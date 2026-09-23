// Anthropic Messages event SSE → OpenAI Responses event SSE.

import { thinkingToReasoningItem } from "./reasoning.js";
import {
  finalStatus,
  functionCallItem,
  messageItem,
  refusalItem,
  refusalText,
  responseErrorCode,
  responseId,
  responseObject,
  webSearchCallItem,
  type AnthropicUsage,
  type Json,
  type ResponseShell,
} from "./response.js";

type OpenItem =
  | { kind: "text"; outputIndex: number; id: string; text: string }
  | { kind: "tool"; outputIndex: number; id: string; callId: string; name: string; args: string }
  | { kind: "reasoning"; outputIndex: number; id: string; text: string; signature: string }
  | { kind: "web_search"; outputIndex: number; id: string; input: string }
  | { kind: "skip" };

// A truncated or malformed server_tool_use input only loses the echoed query, not the item.
function parseJsonObject(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isNonEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

class StreamTranslator {
  private seq = 0;
  private out: string[] = [];
  private shell: ResponseShell = {
    id: "",
    model: "",
    createdAt: Math.floor(Date.now() / 1000),
    status: "in_progress",
    output: [],
    usage: undefined,
  };
  private blocks = new Map<number, OpenItem>();
  private stopReason: unknown = null;
  private stopDetails: unknown = null;
  started = false;
  finished = false;

  constructor(private readonly fallbackModel: string) {}

  drain(): string[] {
    const events = this.out;
    this.out = [];
    return events;
  }

  private emit(type: string, payload: Json): void {
    this.out.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...payload })}\n\n`);
  }

  handle(event: Json): void {
    switch (event.type) {
      case "message_start":
        return this.onMessageStart(event.message as Json | undefined);
      case "content_block_start":
        return this.onBlockStart(event.index as number, event.content_block as Json);
      case "content_block_delta":
        return this.onBlockDelta(event.index as number, event.delta as Json);
      case "content_block_stop":
        return this.onBlockStop(event.index as number);
      case "message_delta": {
        const delta = event.delta as Json | undefined;
        this.stopReason = delta?.stop_reason ?? this.stopReason;
        this.stopDetails = delta?.stop_details ?? this.stopDetails;
        this.mergeUsage(event.usage as AnthropicUsage | undefined);
        return;
      }
      case "message_stop":
        return this.complete();
      case "error": {
        const error = event.error as Json | undefined;
        return this.fail(
          responseErrorCode(error?.type),
          typeof error?.message === "string" ? error.message : "Upstream stream error",
        );
      }
      default:
        return;
    }
  }

  private mergeUsage(usage: AnthropicUsage | undefined): void {
    if (!usage) return;
    const merged: AnthropicUsage = { ...this.shell.usage };
    for (const [key, value] of Object.entries(usage)) {
      if (value !== undefined && value !== null) (merged as Json)[key] = value;
    }
    this.shell.usage = merged;
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    if (!this.shell.id) this.shell.id = responseId(undefined);
    if (!this.shell.model) this.shell.model = this.fallbackModel;
    const response = responseObject(this.shell);
    this.emit("response.created", { response });
    this.emit("response.in_progress", { response });
  }

  private onMessageStart(message: Json | undefined): void {
    this.shell.id = responseId(message?.id);
    this.shell.model = typeof message?.model === "string" ? message.model : this.fallbackModel;
    this.mergeUsage(message?.usage as AnthropicUsage | undefined);
    this.ensureStarted();
  }

  private onBlockStart(index: number, block: Json | undefined): void {
    this.ensureStarted();
    const outputIndex = this.shell.output.length;
    if (block?.type === "text") {
      const item: OpenItem = { kind: "text", outputIndex, id: `msg_${outputIndex}`, text: "" };
      this.blocks.set(index, item);
      this.shell.output.push({});
      this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: { type: "message", id: item.id, status: "in_progress", role: "assistant", content: [] },
      });
      this.emit("response.content_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      });
      if (typeof block.text === "string" && block.text) this.textDelta(item, block.text);
    } else if (block?.type === "tool_use") {
      const item: OpenItem = {
        kind: "tool",
        outputIndex,
        id: `fc_${outputIndex}`,
        callId: String(block.id ?? ""),
        name: String(block.name ?? ""),
        args: "",
      };
      this.blocks.set(index, item);
      this.shell.output.push({});
      this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: functionCallItem(item.id, item.callId, item.name, "", "in_progress"),
      });
    } else if (block?.type === "thinking") {
      const item: OpenItem = {
        kind: "reasoning",
        outputIndex,
        id: `rs_${outputIndex}`,
        text: typeof block.thinking === "string" ? block.thinking : "",
        signature: typeof block.signature === "string" ? block.signature : "",
      };
      this.blocks.set(index, item);
      this.shell.output.push({});
      this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: { type: "reasoning", id: item.id, summary: [] },
      });
      this.emit("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    } else if (block?.type === "redacted_thinking") {
      const item = thinkingToReasoningItem(block, `rs_${outputIndex}`);
      this.blocks.set(index, { kind: "skip" });
      if (!item) return;
      this.shell.output.push(item);
      this.emit("response.output_item.added", { output_index: outputIndex, item });
      this.emit("response.output_item.done", { output_index: outputIndex, item });
    } else if (block?.type === "server_tool_use" && block.name === "web_search") {
      const item: OpenItem = {
        kind: "web_search",
        outputIndex,
        id: String(block.id ?? `ws_${outputIndex}`),
        input: isNonEmptyObject(block.input) ? JSON.stringify(block.input) : "",
      };
      this.blocks.set(index, item);
      this.shell.output.push({});
      this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: webSearchCallItem(item.id, undefined, "in_progress"),
      });
    } else {
      // web_search_tool_result etc.: results fold into the model's text.
      this.blocks.set(index, { kind: "skip" });
    }
  }

  private textDelta(item: Extract<OpenItem, { kind: "text" }>, delta: string): void {
    item.text += delta;
    this.emit("response.output_text.delta", {
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  private onBlockDelta(index: number, delta: Json | undefined): void {
    const item = this.blocks.get(index);
    if (!item || !delta) return;
    if (item.kind === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
      this.textDelta(item, delta.text);
    } else if (item.kind === "tool" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      item.args += delta.partial_json;
      this.emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: item.outputIndex,
        delta: delta.partial_json,
      });
    } else if (item.kind === "reasoning" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      item.text += delta.thinking;
      this.emit("response.reasoning_summary_text.delta", {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        delta: delta.thinking,
      });
    } else if (item.kind === "reasoning" && delta.type === "signature_delta" && typeof delta.signature === "string") {
      item.signature += delta.signature;
    } else if (item.kind === "web_search" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      item.input += delta.partial_json;
    }
  }

  private onBlockStop(index: number): void {
    const item = this.blocks.get(index);
    this.blocks.delete(index);
    if (!item || item.kind === "skip") return;
    const outputIndex = item.outputIndex;
    let done: Json;
    if (item.kind === "text") {
      this.emit("response.output_text.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text: item.text,
        logprobs: [],
      });
      this.emit("response.content_part.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: item.text, annotations: [], logprobs: [] },
      });
      done = messageItem(item.id, item.text, "completed");
    } else if (item.kind === "tool") {
      const args = item.args || "{}";
      this.emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: args,
      });
      done = functionCallItem(item.id, item.callId, item.name, args, "completed");
    } else if (item.kind === "reasoning") {
      this.emit("response.reasoning_summary_text.done", {
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        text: item.text,
      });
      this.emit("response.reasoning_summary_part.done", {
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: item.text },
      });
      done = thinkingToReasoningItem(
        { type: "thinking", thinking: item.text, signature: item.signature },
        item.id,
      )!;
    } else {
      done = webSearchCallItem(item.id, parseJsonObject(item.input), "completed");
    }
    this.shell.output[outputIndex] = done;
    this.emit("response.output_item.done", { output_index: outputIndex, item: done });
  }

  private emitRefusal(): void {
    const outputIndex = this.shell.output.length;
    const id = `msg_${outputIndex}`;
    const refusal = refusalText(this.stopDetails);
    const ref = { item_id: id, output_index: outputIndex, content_index: 0 };
    this.shell.output.push({});
    this.emit("response.output_item.added", {
      output_index: outputIndex,
      item: { type: "message", id, status: "in_progress", role: "assistant", content: [] },
    });
    this.emit("response.content_part.added", { ...ref, part: { type: "refusal", refusal: "" } });
    this.emit("response.refusal.delta", { ...ref, delta: refusal });
    this.emit("response.refusal.done", { ...ref, refusal });
    this.emit("response.content_part.done", { ...ref, part: { type: "refusal", refusal } });
    const done = refusalItem(id, refusal, "completed");
    this.shell.output[outputIndex] = done;
    this.emit("response.output_item.done", { output_index: outputIndex, item: done });
  }

  private complete(): void {
    if (this.finished) return;
    this.ensureStarted();
    if (this.stopReason === "refusal") this.emitRefusal();
    this.finished = true;
    this.shell.status = finalStatus(this.stopReason);
    const type = this.shell.status === "incomplete" ? "response.incomplete" : "response.completed";
    this.emit(type, { response: responseObject(this.shell) });
  }

  // Items still open when the stream dies go out in their partial state, never as `{}` placeholders.
  private partialItem(item: Exclude<OpenItem, { kind: "skip" }>): Json {
    switch (item.kind) {
      case "text":
        return messageItem(item.id, item.text, "incomplete");
      case "tool":
        return functionCallItem(item.id, item.callId, item.name, item.args, "incomplete");
      case "reasoning":
        return { type: "reasoning", id: item.id, summary: item.text ? [{ type: "summary_text", text: item.text }] : [] };
      case "web_search":
        return webSearchCallItem(item.id, parseJsonObject(item.input), "failed");
    }
  }

  fail(code: string, message: string): void {
    if (this.finished) return;
    this.ensureStarted();
    for (const item of this.blocks.values()) {
      if (item.kind !== "skip") this.shell.output[item.outputIndex] = this.partialItem(item);
    }
    this.blocks.clear();
    this.finished = true;
    this.shell.status = "failed";
    this.shell.error = { code, message };
    this.emit("response.failed", { response: responseObject(this.shell) });
  }
}

export type MessagesStreamOptions = {
  /** Model reported when the upstream `message_start` carries none. */
  model?: string;
};

export function messagesStreamToResponsesStream(
  source: ReadableStream<Uint8Array>,
  options?: MessagesStreamOptions,
): ReadableStream<Uint8Array> {
  const translator = new StreamTranslator(options?.model ?? "");
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      translator.handle(JSON.parse(payload) as Json);
    } catch {
      // A malformed frame is skipped; a stream that never completes fails below.
    }
  };

  // Pull-based (not a TransformStream) so a client cancel reaches the source reader.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Keep reading until something is enqueued: an empty pull never gets re-invoked.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer) handleLine(buffer);
          buffer = "";
          if (!translator.finished) {
            translator.fail("server_error", "Upstream model stream ended without completing the response. Please retry.");
          }
          for (const event of translator.drain()) controller.enqueue(encoder.encode(event));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line.replace(/\r$/, ""));
        const events = translator.drain();
        if (events.length === 0) continue;
        for (const event of events) controller.enqueue(encoder.encode(event));
        return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
