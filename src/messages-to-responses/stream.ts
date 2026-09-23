// OpenAI Responses event SSE → Anthropic Messages event SSE.

import { reasoningSignature, withSpeedEcho } from "./response.js";
import { readWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from "../shared/idle-read.js";
import { restoreToolName } from "../shared/tool-names.js";
import { extractResponsesUsage, type AnthropicUsage } from "./usage.js";

export const RESPONSES_STREAM_IDLE_TIMEOUT_MS = STREAM_IDLE_TIMEOUT_MS;

export type ResponsesStreamOptions = {
  /** Reported model id; wins over the vendor's dated snapshot. */
  model?: string;
  idleTimeoutMs?: number;
  /** Fired when the stream ends abnormally (stalled or truncated). */
  onAbnormalEnd?: (reason: "stalled" | "truncated") => void;
  /**
   * Every vendor `service_tier` snapshot, raw vocabulary; the last call is the served tier.
   * Fires before the final bytes are enqueued.
   */
  onServiceTier?: (tier: string) => void;
  /** Sign thinking blocks with the encrypted reasoning for replay under this scope. */
  reasoningReplayScope?: string;
  /** Shortened → original tool names, from `toolNameRestoreMap(request)`. */
  toolNames?: Record<string, string>;
};

export function responsesStreamToMessagesStream(
  input: ReadableStream<Uint8Array>,
  options?: ResponsesStreamOptions,
): ReadableStream<Uint8Array> {
  const idleTimeoutMs = options?.idleTimeoutMs ?? RESPONSES_STREAM_IDLE_TIMEOUT_MS;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = new ResponsesTranslatorState(
    options?.model,
    options?.onServiceTier,
    options?.reasoningReplayScope,
    options?.toolNames,
  );
  const reader = input.getReader();
  let lineBuffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const flush = (): void => {
        for (const event of state.drain()) controller.enqueue(encoder.encode(event));
      };
      try {
        for (;;) {
          const result = await readWithIdleTimeout(reader, idleTimeoutMs);
          if (result === "idle_timeout") {
            // Vendor went silent with the connection open (observed on xAI
            // grok-4.5/4.6). Without this, the client waits forever on
            // "working" — surface a retryable error instead.
            state.finishAbnormally(
              `Upstream model stream stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s. Please retry.`,
            );
            options?.onAbnormalEnd?.("stalled");
            flush();
            controller.close();
            reader.cancel("responses stream idle timeout").catch(() => {});
            return;
          }
          if (result.done) break;
          lineBuffer += decoder.decode(result.value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";
          for (const line of lines) handleLine(line, state);
          flush();
        }
        if (lineBuffer.length > 0) handleLine(lineBuffer, state);
        // EOF without a terminal event (response.completed / incomplete /
        // failed / error). A healthy Responses stream ALWAYS ends with one, so
        // this is a truncated/dead stream. Fabricating a clean end_turn here
        // (the old behavior) turned upstream faults into silent empty turns
        // the agent could never explain — emit a retryable error instead.
        if (!state.finished) {
          state.finishAbnormally(
            "Upstream model stream ended without completing the response. Please retry.",
          );
          options?.onAbnormalEnd?.("truncated");
        }
        flush();
        controller.close();
      } catch (err) {
        // Upstream read failure (network reset). Propagate — the usage tap
        // settles on stream error, and the client sees a broken connection.
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function handleLine(rawLine: string, state: ResponsesTranslatorState): void {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return;
  }
  state.handleEvent(event);
}

type BlockKind = "text" | "tool_use" | "thinking";

class ResponsesTranslatorState {
  private pending: string[] = [];
  private startedMessage = false;
  private finishedMessage = false;
  private messageId = "";
  private model = "";
  private usage: AnthropicUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  private sawToolCall = false;
  private sawRefusal = false;
  // Responses item_id → { index, kind }. Each output item is one Anthropic
  // content block.
  private blocks = new Map<string, { index: number; kind: BlockKind }>();
  // Thinking block index → last summary_index streamed into it.
  private summaryParts = new Map<number, number>();

  constructor(
    private readonly canonicalModel?: string,
    private readonly onServiceTier?: (tier: string) => void,
    private readonly reasoningReplayScope?: string,
    private readonly toolNames?: Record<string, string>,
  ) {}
  private nextIndex = 0;
  // Latest service_tier snapshot seen — fallback for terminal events whose
  // response object omits it (unobserved from OpenAI/xAI, but cheap to cover).
  private lastServiceTier: unknown;
  // Indices already closed, so `output_item.done` and `finish()` never emit a
  // duplicate content_block_stop (double-stop makes the SDK dispatch a
  // tool_use twice → duplicated turns).
  private stopped = new Set<number>();

  handleEvent(event: Record<string, unknown>): void {
    if (this.finishedMessage) return;
    const type = typeof event.type === "string" ? event.type : "";
    const response = event.response as Record<string, unknown> | undefined;

    // Any response snapshot may carry the served tier. Report every one and
    // let the LAST win: early snapshots (response.created) can echo the
    // REQUESTED tier while only the terminal event reflects what was actually
    // granted (xAI bills priority only when the final response confirms it).
    if (response && typeof response.service_tier === "string") {
      this.lastServiceTier = response.service_tier;
      this.onServiceTier?.(response.service_tier);
    }

    if (!this.startedMessage) {
      if (response) {
        if (typeof response.id === "string") this.messageId = response.id;
        if (typeof response.model === "string") this.model = response.model;
      }
      // Canonical request id wins over OpenAI's dated snapshot.
      if (this.canonicalModel) this.model = this.canonicalModel;
      this.emitMessageStart();
    }

    switch (type) {
      case "response.output_item.added":
        this.onItemAdded(event);
        break;
      case "response.output_text.delta":
        this.onTextDelta(event);
        break;
      case "response.refusal.delta":
        this.sawRefusal = true;
        this.onTextDelta(event);
        break;
      // The summary stream is what surfaces when we request `reasoning.summary`;
      // accept the raw reasoning stream too in case a provider emits it.
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        this.onReasoningDelta(event);
        break;
      case "response.function_call_arguments.delta":
        this.onArgsDelta(event);
        break;
      case "response.output_item.done":
        this.onItemDone(event);
        break;
      case "response.completed":
        this.onCompleted(event);
        break;
      case "response.incomplete":
        this.onIncomplete(event);
        break;
      case "response.failed":
        this.onFailed(event);
        break;
      // Top-level Responses SSE error event (not response.failed). Previously
      // fell through to `default` and got silently swallowed — the stream then
      // ended as a fabricated clean end_turn.
      case "error":
        this.emitErrorAndFinish(
          streamErrorType(event.code),
          typeof event.message === "string"
            ? event.message
            : "Upstream model reported a stream error",
        );
        break;
      default:
        break;
    }
  }

  get finished(): boolean {
    return this.finishedMessage;
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

  private onItemAdded(event: Record<string, unknown>): void {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return;
    const itemId = typeof item.id === "string" ? item.id : "";
    if (!itemId || this.blocks.has(itemId)) return;
    const itemType = item.type;

    if (itemType === "message") {
      this.openBlock(itemId, "text", { type: "text", text: "" });
    } else if (itemType === "function_call") {
      this.sawToolCall = true;
      this.openBlock(itemId, "tool_use", {
        type: "tool_use",
        id: typeof item.call_id === "string" ? item.call_id : itemId,
        name: typeof item.name === "string" ? restoreToolName(item.name, this.toolNames) : "",
        input: {},
      });
    }
    // `reasoning` items open lazily: on their first non-empty summary delta
    // (onReasoningDelta), or at `output_item.done` when they carry
    // encrypted_content to sign (onItemDone). Summary-less, unsigned reasoning
    // never surfaces as an empty thinking block.
  }

  private openBlock(
    itemId: string,
    kind: BlockKind,
    contentBlock: Record<string, unknown>,
  ): void {
    const index = this.nextIndex++;
    this.blocks.set(itemId, { index, kind });
    this.pending.push(
      sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: contentBlock,
      }),
    );
  }

  private onTextDelta(event: Record<string, unknown>): void {
    const block = this.blockFor(event, "text", { type: "text", text: "" });
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return;
    this.pending.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "text_delta", text: delta },
      }),
    );
  }

  private onReasoningDelta(event: Record<string, unknown>): void {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return;
    const block = this.blockFor(event, "thinking", {
      type: "thinking",
      thinking: "",
    });
    // Separate summary parts the same way the JSON reply joins them.
    if (typeof event.summary_index === "number") {
      const last = this.summaryParts.get(block.index);
      if (last !== undefined && last !== event.summary_index) {
        this.pending.push(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "thinking_delta", thinking: "\n\n" },
          }),
        );
      }
      this.summaryParts.set(block.index, event.summary_index);
    }
    this.pending.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "thinking_delta", thinking: delta },
      }),
    );
  }

  private onArgsDelta(event: Record<string, unknown>): void {
    const itemId = typeof event.item_id === "string" ? event.item_id : "";
    const block = this.blocks.get(itemId);
    if (!block) return;
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return;
    this.pending.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: delta },
      }),
    );
  }

  private onItemDone(event: Record<string, unknown>): void {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return;
    if (item.type === "reasoning") {
      this.signReasoning(item);
      return;
    }
    const itemId = typeof item.id === "string" ? item.id : "";
    const block = this.blocks.get(itemId);
    if (!block) return;
    this.emitBlockStop(block.index);
  }

  // The completed reasoning item is the first place the vendor's final
  // encrypted_content is guaranteed present. Mirrors Anthropic's own wire:
  // signature_delta, then content_block_stop.
  private signReasoning(item: Record<string, unknown>): void {
    const itemId = typeof item.id === "string" ? item.id : "";
    if (!itemId) return;
    const signature = reasoningSignature(item, this.reasoningReplayScope);
    let block = this.blocks.get(itemId);
    if (!block) {
      if (!signature) return;
      this.openBlock(itemId, "thinking", { type: "thinking", thinking: "" });
      block = this.blocks.get(itemId)!;
    }
    if (this.stopped.has(block.index)) return;
    if (signature) {
      this.pending.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "signature_delta", signature },
        }),
      );
    }
    this.emitBlockStop(block.index);
  }

  private emitBlockStop(index: number): void {
    if (this.stopped.has(index)) return;
    this.stopped.add(index);
    this.pending.push(
      sseEvent("content_block_stop", { type: "content_block_stop", index }),
    );
  }

  private onCompleted(event: Record<string, unknown>): void {
    const response = event.response as Record<string, unknown> | undefined;
    // Defensive: a reasoning item whose output_item.done never arrived still
    // gets signed from the terminal snapshot before finish() stops it unsigned.
    if (Array.isArray(response?.output)) {
      for (const item of response.output as Array<Record<string, unknown>>) {
        if (item && typeof item === "object" && item.type === "reasoning") {
          this.signReasoning(item);
        }
      }
    }
    this.updateUsage(response);
    this.finish();
  }

  private onIncomplete(event: Record<string, unknown>): void {
    const response = event.response as Record<string, unknown> | undefined;
    this.updateUsage(response);
    this.finish("max_tokens");
  }

  private onFailed(event: Record<string, unknown>): void {
    const response = event.response as Record<string, unknown> | undefined;
    this.updateUsage(response);
    this.finishWithError(response);
  }

  private updateUsage(response: Record<string, unknown> | undefined): void {
    if (!response?.usage) return;
    // Echo the served tier into the translated usage (terminal snapshot's own
    // tier, falling back to the last snapshot seen) so downstream JSONL
    // consumers can price the turn — see AnthropicUsage.speed.
    this.usage = withSpeedEcho(
      extractResponsesUsage(response.usage as Record<string, unknown>),
      response.service_tier ?? this.lastServiceTier,
    );
  }

  // Lazily open a block for delta events that arrive without a matching
  // output_item.added (defensive — keeps indices consistent).
  private blockFor(
    event: Record<string, unknown>,
    kind: BlockKind,
    contentBlock: Record<string, unknown>,
  ): { index: number; kind: BlockKind } {
    const itemId =
      typeof event.item_id === "string" && event.item_id
        ? event.item_id
        : `block_${this.nextIndex}`;
    const existing = this.blocks.get(itemId);
    if (existing) return existing;
    this.openBlock(itemId, kind, contentBlock);
    return this.blocks.get(itemId)!;
  }

  finish(
    stopReason: "end_turn" | "max_tokens" | "tool_use" | "refusal" = this.sawRefusal
      ? "refusal"
      : this.sawToolCall
        ? "tool_use"
        : "end_turn",
  ): void {
    if (this.finishedMessage) return;
    if (!this.startedMessage) this.emitMessageStart();
    for (const { index } of this.blocks.values()) {
      this.emitBlockStop(index);
    }
    this.pending.push(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage: this.usage,
      }),
    );
    this.pending.push(sseEvent("message_stop", { type: "message_stop" }));
    this.finishedMessage = true;
  }

  private finishWithError(response: Record<string, unknown> | undefined): void {
    const error = response?.error as Record<string, unknown> | undefined;
    const message =
      typeof error?.message === "string"
        ? error.message
        : "OpenAI response failed";
    this.emitErrorAndFinish(streamErrorType(error?.code), message);
  }

  // Stalled / truncated stream. `overloaded_error` is Anthropic's standard
  // transient type, so SDK clients auto-retry the turn instead of recording
  // a silent empty success.
  finishAbnormally(message: string): void {
    this.emitErrorAndFinish("overloaded_error", message);
  }

  private emitErrorAndFinish(type: string, message: string): void {
    if (this.finishedMessage) return;
    for (const { index } of this.blocks.values()) {
      this.emitBlockStop(index);
    }
    this.pending.push(
      sseEvent("error", { type: "error", error: { type, message } }),
    );
    this.finishedMessage = true;
  }

  drain(): string[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

// Transient upstream codes map to types Anthropic clients retry; anything else stays
// non-retryable so the upstream message is shown as-is.
function streamErrorType(code: unknown): string {
  if (code === "server_error") return "api_error";
  if (code === "rate_limit_exceeded") return "rate_limit_error";
  return "openai_response_failed";
}

function sseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}
