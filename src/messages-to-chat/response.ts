// Non-streaming OpenAI Chat Completions reply → Anthropic Messages reply.

import { restoreToolName } from "../shared/tool-names.js";

export type ChatCompletionsResponseOptions = {
  /** Model reported on the Messages reply; defaults to the upstream `model`. */
  model?: string;
  /** Shortened → original tool names, from `toolNameRestoreMap(request)`. */
  toolNames?: Record<string, string>;
};

export function chatCompletionsResponseToMessages(
  body: Record<string, unknown>,
  options?: ChatCompletionsResponseOptions,
): Record<string, unknown> {
  const canonicalModel = options?.model;
  const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  const message = (choice?.message ?? {}) as Record<string, unknown>;

  const blocks: Array<Record<string, unknown>> = [];
  const reasoning =
    typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : "";
  if (reasoning) blocks.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  const sawRefusal = typeof message.refusal === "string" && message.refusal.length > 0;
  if (sawRefusal) blocks.push({ type: "text", text: message.refusal });
  let sawToolCall = false;
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls as Array<Record<string, unknown>>) {
      const fn = (call?.function ?? {}) as Record<string, unknown>;
      sawToolCall = true;
      blocks.push({
        type: "tool_use",
        id: typeof call.id === "string" ? call.id : "",
        name: typeof fn.name === "string" ? restoreToolName(fn.name, options?.toolNames) : "",
        input: parseJsonOrEmpty(fn.arguments),
      });
    }
  }

  return {
    id: typeof body.id === "string" ? body.id : "",
    type: "message",
    role: "assistant",
    model: canonicalModel || (typeof body.model === "string" ? body.model : ""),
    content: blocks,
    stop_reason: mapFinishReason(choice?.finish_reason, sawToolCall, sawRefusal),
    stop_sequence: null,
    usage: extractChatCompletionsUsage(body.usage),
  };
}

export function mapFinishReason(
  finish: unknown,
  sawToolCall: boolean,
  sawRefusal = false,
): "tool_use" | "max_tokens" | "end_turn" | "refusal" {
  if (finish === "tool_calls" || sawToolCall) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter" || sawRefusal) return "refusal";
  return "end_turn";
}

function parseJsonOrEmpty(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** OpenAI usage names → Anthropic names; cached tokens split out of input. */
export function extractChatCompletionsUsage(usage: unknown): Record<string, number> {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = num(details?.cached_tokens);
  return {
    input_tokens: Math.max(num(u.prompt_tokens) - cached, 0),
    output_tokens: num(u.completion_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}
