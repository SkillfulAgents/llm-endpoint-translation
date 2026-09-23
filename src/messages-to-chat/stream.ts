// OpenAI Chat Completions chunk SSE → Anthropic Messages event SSE.

import { responsesErrorToMessagesError } from "../messages-to-responses/error.js";
import { readWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from "../shared/idle-read.js";
import { restoreToolName } from "../shared/tool-names.js";
import { extractChatCompletionsUsage, mapFinishReason } from "./response.js";

export const CHAT_COMPLETIONS_STREAM_IDLE_TIMEOUT_MS = STREAM_IDLE_TIMEOUT_MS;

export type ChatCompletionsStreamOptions = {
  /** Model reported on `message_start`; defaults to the upstream chunk `model`. */
  model?: string;
  idleTimeoutMs?: number;
  /** Fired when the stream ends abnormally (stalled or truncated). */
  onAbnormalEnd?: (reason: "stalled" | "truncated") => void;
  /** Shortened → original tool names, from `toolNameRestoreMap(request)`. */
  toolNames?: Record<string, string>;
};

export function chatCompletionsStreamToMessagesStream(
  input: ReadableStream<Uint8Array>,
  options?: ChatCompletionsStreamOptions,
): ReadableStream<Uint8Array> {
  const canonicalModel = options?.model;
  const idleTimeoutMs = options?.idleTimeoutMs ?? CHAT_COMPLETIONS_STREAM_IDLE_TIMEOUT_MS;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = new ChatTranslatorState(canonicalModel, options?.toolNames);
  const reader = input.getReader();
  let lineBuffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const flush = (): void => {
        for (const event of state.drain()) controller.enqueue(encoder.encode(event));
      };
      try {
        let stalled = false;
        for (;;) {
          const result = await readWithIdleTimeout(reader, idleTimeoutMs);
          if (result === "idle_timeout") {
            stalled = true;
            reader.cancel("chat completions stream idle timeout").catch(() => {});
            break;
          }
          if (result.done) break;
          lineBuffer += decoder.decode(result.value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";
          for (const line of lines) handleLine(line, state);
          flush();
        }
        if (!stalled && lineBuffer.length > 0) handleLine(lineBuffer, state);
        // A finish_reason arrived but the trailing usage-only chunk never
        // did — still a complete turn, close it normally with zero usage.
        if (!state.finished && state.hasFinishReason) state.finish();
        // No finish_reason: truncated or stalled upstream stream. Emit a
        // retryable error instead of fabricating a clean end_turn.
        if (!state.finished) {
          state.finishAbnormally(
            stalled
              ? `Upstream model stream stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s. Please retry.`
              : "Upstream model stream ended without completing the response. Please retry.",
          );
          options?.onAbnormalEnd?.(stalled ? "stalled" : "truncated");
        }
        flush();
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function handleLine(rawLine: string, state: ChatTranslatorState): void {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return;
  }
  state.handleChunk(chunk);
}

type OpenBlock = { index: number; kind: "thinking" | "text" | "tool_use" };
type ToolCall = { id: string; name: string; args: string };
type Deferred = { kind: "tool_use"; callIndex: number } | { kind: "thinking" | "text"; text: string };

// Messages streams carry one open block at a time. Chat interleaves parallel tool-call
// arguments, so only the first call streams live; later calls and any content after them are
// buffered and emitted in order once the live block closes.
class ChatTranslatorState {
  private pending: string[] = [];
  private startedMessage = false;
  private finishedMessage = false;
  private messageId = "";
  private model = "";
  private usage: Record<string, number> | null = null;
  private finishReason: unknown;
  private sawToolCall = false;
  private sawRefusal = false;
  private nextIndex = 0;
  private live: OpenBlock | null = null;
  private liveCallIndex: number | null = null;
  // Chat tool_calls are keyed by their array index within the delta.
  private toolCalls = new Map<number, ToolCall>();
  private deferred: Deferred[] = [];

  constructor(
    private readonly canonicalModel?: string,
    private readonly toolNames?: Record<string, string>,
  ) {}

  get finished(): boolean {
    return this.finishedMessage;
  }

  get hasFinishReason(): boolean {
    return this.finishReason != null;
  }

  handleChunk(chunk: Record<string, unknown>): void {
    if (this.finishedMessage) return;
    if (chunk.error && typeof chunk.error === "object") {
      if (!this.startedMessage) this.emitMessageStart();
      const { error } = responsesErrorToMessagesError(chunk) as { error: { type: string; message: string } };
      this.finishAbnormally(error.message, error.type);
      return;
    }
    if (!this.startedMessage) {
      if (typeof chunk.id === "string") this.messageId = chunk.id;
      this.model =
        this.canonicalModel ||
        (typeof chunk.model === "string" ? chunk.model : "");
      this.emitMessageStart();
    }
    if (chunk.usage && typeof chunk.usage === "object") {
      this.usage = extractChatCompletionsUsage(chunk.usage);
    }
    const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as
      | Record<string, unknown>
      | undefined;
    if (!choice) {
      // usage-only terminal chunk (stream_options.include_usage)
      if (this.finishReason !== undefined && this.usage) this.finish();
      return;
    }
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      this.emitThinkingDelta(delta.reasoning_content);
    }
    if (typeof delta.content === "string" && delta.content) {
      this.emitTextDelta(delta.content);
    }
    if (typeof delta.refusal === "string" && delta.refusal) {
      this.sawRefusal = true;
      this.emitTextDelta(delta.refusal);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const [position, call] of (delta.tool_calls as Array<Record<string, unknown>>).entries()) {
        this.emitToolCallDelta(call, position);
      }
    }
    if (choice.finish_reason != null) {
      this.finishReason = choice.finish_reason;
      // Fireworks sends usage on this same chunk; OpenAI sends a trailing
      // usage-only chunk. Finish now if usage is already in hand, else wait.
      if (this.usage) this.finish();
    }
  }

  private emitMessageStart(): void {
    this.pending.push(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    );
    this.startedMessage = true;
  }

  private emitThinkingDelta(text: string): void {
    this.emitContentDelta("thinking", text);
  }

  private emitTextDelta(text: string): void {
    this.emitContentDelta("text", text);
  }

  private emitContentDelta(kind: "thinking" | "text", text: string): void {
    if (this.sawToolCall) {
      const last = this.deferred.at(-1);
      if (last && last.kind === kind) last.text += text;
      else this.deferred.push({ kind, text });
      return;
    }
    if (this.live?.kind !== kind) {
      this.closeLive();
      this.live = this.openBlock(kind, contentBlockStart(kind));
    }
    this.pushDelta(this.live.index, kind, text);
  }

  // Some vendors omit `index`; parallel calls are then told apart by their position in the delta.
  private emitToolCallDelta(call: Record<string, unknown>, position: number): void {
    const callIndex = typeof call.index === "number" ? call.index : position;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    let toolCall = this.toolCalls.get(callIndex);
    if (!toolCall) {
      toolCall = {
        id: typeof call.id === "string" ? call.id : `call_${callIndex}`,
        name: typeof fn.name === "string" ? restoreToolName(fn.name, this.toolNames) : "",
        args: "",
      };
      this.toolCalls.set(callIndex, toolCall);
      if (this.sawToolCall) {
        this.deferred.push({ kind: "tool_use", callIndex });
      } else {
        this.sawToolCall = true;
        this.closeLive();
        this.live = this.openBlock("tool_use", toolUseStart(toolCall));
        this.liveCallIndex = callIndex;
      }
    }
    if (typeof fn.arguments !== "string" || !fn.arguments) return;
    if (this.live && callIndex === this.liveCallIndex) {
      this.pushDelta(this.live.index, "tool_use", fn.arguments);
    } else {
      toolCall.args += fn.arguments;
    }
  }

  private pushDelta(index: number, kind: OpenBlock["kind"], text: string): void {
    const delta =
      kind === "tool_use"
        ? { type: "input_json_delta", partial_json: text }
        : kind === "thinking"
          ? { type: "thinking_delta", thinking: text }
          : { type: "text_delta", text };
    this.pending.push(sseEvent("content_block_delta", { type: "content_block_delta", index, delta }));
  }

  private openBlock(
    kind: OpenBlock["kind"],
    contentBlock: Record<string, unknown>,
  ): OpenBlock {
    const index = this.nextIndex++;
    this.pending.push(
      sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: contentBlock,
      }),
    );
    return { index, kind };
  }

  private closeBlock(index: number): void {
    this.pending.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
  }

  private closeLive(): void {
    if (!this.live) return;
    this.closeBlock(this.live.index);
    this.live = null;
    this.liveCallIndex = null;
  }

  private closeAllBlocks(): void {
    this.closeLive();
    for (const item of this.deferred) {
      if (item.kind === "tool_use") {
        const toolCall = this.toolCalls.get(item.callIndex)!;
        this.emitWholeBlock("tool_use", toolUseStart(toolCall), toolCall.args);
      } else {
        this.emitWholeBlock(item.kind, contentBlockStart(item.kind), item.text);
      }
    }
    this.deferred = [];
  }

  private emitWholeBlock(kind: OpenBlock["kind"], contentBlock: Record<string, unknown>, text: string): void {
    const block = this.openBlock(kind, contentBlock);
    if (text) this.pushDelta(block.index, kind, text);
    this.closeBlock(block.index);
  }

  finish(): void {
    if (this.finishedMessage) return;
    if (!this.startedMessage) this.emitMessageStart();
    this.closeAllBlocks();
    this.pending.push(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapFinishReason(this.finishReason, this.sawToolCall, this.sawRefusal),
          stop_sequence: null,
        },
        usage: this.usage ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    this.pending.push(sseEvent("message_stop", { type: "message_stop" }));
    this.finishedMessage = true;
  }

  finishAbnormally(message: string, type = "overloaded_error"): void {
    if (this.finishedMessage) return;
    this.closeAllBlocks();
    this.pending.push(
      sseEvent("error", {
        type: "error",
        error: { type, message },
      }),
    );
    this.finishedMessage = true;
  }

  drain(): string[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function contentBlockStart(kind: "thinking" | "text"): Record<string, unknown> {
  return kind === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" };
}

function toolUseStart(call: ToolCall): Record<string, unknown> {
  return { type: "tool_use", id: call.id, name: call.name, input: {} };
}

function sseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}
