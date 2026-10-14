// Non-streaming OpenAI Chat Completions reply → Anthropic Messages reply.

import { encodeReasoningSignature } from "../messages-to-responses/reasoning-replay.js";
import { restoreToolName } from "../shared/tool-names.js";

export type ChatCompletionsResponseOptions = {
  /** Model reported on the Messages reply; defaults to the upstream `model`. */
  model?: string;
  /** Shortened → original tool names, from `toolNameRestoreMap(request)`. */
  toolNames?: Record<string, string>;
  /** Carry Gemini tool-call thought signatures in a thinking block under this scope. */
  reasoningReplayScope?: string;
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
      const id = typeof call.id === "string" ? call.id : "";
      const signature = thoughtSignatureBlockSignature(call, id, options?.reasoningReplayScope);
      if (signature) blocks.push({ type: "thinking", thinking: "", signature });
      blocks.push({
        type: "tool_use",
        id,
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
  // A cut-off tool call carries partial arguments; `tool_use` would get it executed.
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (finish === "tool_calls" || sawToolCall) return "tool_use";
  if (sawRefusal) return "refusal";
  return "end_turn";
}

/**
 * Gemini puts a thought signature on a tool call and 400s if it is missing
 * when that call is replayed. Anthropic clients replay thinking-block
 * signatures verbatim, so the signature rides in one, keyed by the call id.
 */
export function thoughtSignatureBlockSignature(
  call: Record<string, unknown>,
  id: string,
  scope: string | undefined,
): string {
  if (!scope || !id) return "";
  const google = (call.extra_content as { google?: { thought_signature?: unknown } } | undefined)?.google;
  const signature = google?.thought_signature;
  if (typeof signature !== "string" || !signature) return "";
  return encodeReasoningSignature({ scope, id, encryptedContent: signature });
}

function parseJsonOrEmpty(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * OpenAI usage names → Anthropic names; cached tokens split out of input.
 * Gemini leaves thinking tokens out of `completion_tokens` but counts them in
 * `total_tokens` (and bills them as output), so output is whichever is larger.
 */
export function extractChatCompletionsUsage(usage: unknown): Record<string, number> {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = num(details?.cached_tokens);
  const prompt = num(u.prompt_tokens);
  return {
    input_tokens: Math.max(prompt - cached, 0),
    output_tokens: Math.max(num(u.completion_tokens), num(u.total_tokens) - prompt),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}
