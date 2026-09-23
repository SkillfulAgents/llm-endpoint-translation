// Non-streaming OpenAI Responses reply → Anthropic Messages reply.

import { encodeReasoningSignature } from "./reasoning-replay.js";
import {
  extractResponsesUsage,
  servedSpeedEcho,
  type AnthropicUsage,
} from "./usage.js";

export type ResponsesResponseOptions = {
  /** Reported model id; wins over the vendor's dated snapshot (e.g. `gpt-5.5-2026-04-23`). */
  model?: string;
  /** Sign thinking blocks with the encrypted reasoning for replay under this scope. */
  reasoningReplayScope?: string;
};

export function responsesResponseToMessages(
  body: Record<string, unknown>,
  options?: ResponsesResponseOptions,
): Record<string, unknown> {
  const id = typeof body.id === "string" ? body.id : "";
  const model =
    options?.model || (typeof body.model === "string" ? body.model : "");
  const output = Array.isArray(body.output) ? body.output : [];

  const blocks: Array<Record<string, unknown>> = [];
  let sawToolCall = false;

  for (const item of output as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") continue;
    const type = item.type;
    if (type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content as Array<Record<string, unknown>>) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        }
      }
    } else if (type === "function_call") {
      sawToolCall = true;
      blocks.push({
        type: "tool_use",
        id: typeof item.call_id === "string" ? item.call_id : "",
        name: typeof item.name === "string" ? item.name : "",
        input: parseJsonOrEmpty(item.arguments),
      });
    } else if (type === "reasoning") {
      const summary = reasoningText(item);
      const signature = reasoningSignature(item, options?.reasoningReplayScope);
      if (signature) {
        blocks.push({ type: "thinking", thinking: summary, signature });
      } else if (summary) {
        blocks.push({ type: "thinking", thinking: summary });
      }
    }
    // web_search_call items: the model folds results into output_text; we
    // don't surface a structured web_search_tool_result block (v1).
  }

  // `incomplete` means the model hit the output cap → Anthropic max_tokens.
  const stopReason =
    body.status === "incomplete"
      ? "max_tokens"
      : sawToolCall
        ? "tool_use"
        : "end_turn";

  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: withSpeedEcho(
      extractResponsesUsage(body.usage as Record<string, unknown> | undefined),
      body.service_tier,
    ),
  };
}

/** Attach the served-tier echo to a translated usage object. */
export function withSpeedEcho(usage: AnthropicUsage, serviceTier: unknown): AnthropicUsage {
  const speed = servedSpeedEcho(serviceTier);
  return speed ? { ...usage, speed } : usage;
}

// Empty when replay is off or the vendor sent no `encrypted_content`.
export function reasoningSignature(
  item: Record<string, unknown>,
  scope: string | undefined,
): string {
  if (!scope) return "";
  if (typeof item.id !== "string" || !item.id) return "";
  if (typeof item.encrypted_content !== "string" || !item.encrypted_content) return "";
  return encodeReasoningSignature({
    scope,
    id: item.id,
    encryptedContent: item.encrypted_content,
  });
}

function reasoningText(item: Record<string, unknown>): string {
  if (typeof item.reasoning === "string") return item.reasoning;
  const summary = item.summary;
  if (Array.isArray(summary)) {
    const parts: string[] = [];
    for (const s of summary as Array<Record<string, unknown>>) {
      if (s && typeof s.text === "string") parts.push(s.text);
    }
    return parts.join("\n\n");
  }
  return "";
}

function parseJsonOrEmpty(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
