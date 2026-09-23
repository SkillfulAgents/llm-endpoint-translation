// Non-streaming Anthropic Messages reply (or error envelope) → OpenAI Responses reply.

import { thinkingToReasoningItem } from "./reasoning.js";

export type Json = Record<string, unknown>;

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  speed?: string;
};

export function toResponsesUsage(usage: AnthropicUsage | undefined): Json {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  // Responses input_tokens is the total prompt, cache hits included.
  const input = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + cacheRead;
  const output = usage?.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: usage?.cache_creation_input_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

function serviceTier(usage: AnthropicUsage | undefined): string {
  if (usage?.speed === "fast") return "priority";
  if (usage?.speed === "slow") return "flex";
  return "default";
}

export function responseId(messageId: unknown): string {
  const raw = typeof messageId === "string" ? messageId.replace(/^msg_/, "") : "";
  return `resp_${raw || crypto.randomUUID().replace(/-/g, "")}`;
}

export type ResponseShell = {
  id: string;
  model: string;
  createdAt: number;
  status: "in_progress" | "completed" | "incomplete" | "failed";
  output: Json[];
  usage: AnthropicUsage | undefined;
  error?: { code: string; message: string } | null;
};

// Request-echo fields the spec requires on every Response; the codec never sees the request, so defaults.
const REQUEST_ECHO = {
  instructions: null,
  tools: [],
  tool_choice: "auto",
  parallel_tool_calls: true,
  temperature: null,
  top_p: null,
  metadata: {},
};

export function responseObject(shell: ResponseShell): Json {
  return {
    id: shell.id,
    object: "response",
    created_at: shell.createdAt,
    status: shell.status,
    error: shell.error ?? null,
    incomplete_details: shell.status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model: shell.model,
    output: shell.output,
    ...REQUEST_ECHO,
    store: false,
    service_tier: serviceTier(shell.usage),
    ...(shell.status === "in_progress" ? {} : { usage: toResponsesUsage(shell.usage) }),
  };
}

// ResponseErrorCode is a closed enum; Anthropic error types outside it collapse to server_error.
export function responseErrorCode(anthropicType: unknown): string {
  return anthropicType === "rate_limit_error" ? "rate_limit_exceeded" : "server_error";
}

export function webSearchCallItem(id: string, input: unknown, status: string): Json {
  const query = typeof input === "object" && input !== null ? (input as Json).query : undefined;
  return {
    type: "web_search_call",
    id,
    status,
    action: typeof query === "string" ? { type: "search", query, queries: [query] } : { type: "search" },
  };
}

export function finalStatus(stopReason: unknown): "completed" | "incomplete" {
  return stopReason === "max_tokens" ? "incomplete" : "completed";
}

export function messageItem(id: string, text: string, status: string): Json {
  return {
    type: "message",
    id,
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

const DEFAULT_REFUSAL = "The model declined to respond to this request.";

/** Refusal text for `stop_reason: "refusal"`; Anthropic may omit `stop_details`. */
export function refusalText(stopDetails: unknown): string {
  const explanation =
    typeof stopDetails === "object" && stopDetails !== null
      ? (stopDetails as Json).explanation
      : undefined;
  return typeof explanation === "string" && explanation ? explanation : DEFAULT_REFUSAL;
}

export function refusalItem(id: string, refusal: string, status: string): Json {
  return {
    type: "message",
    id,
    status,
    role: "assistant",
    content: [{ type: "refusal", refusal }],
  };
}

export function functionCallItem(
  id: string,
  callId: string,
  name: string,
  args: string,
  status: string,
): Json {
  return { type: "function_call", id, call_id: callId, name, arguments: args, status };
}

export function messagesResponseToResponses(message: Json): Json {
  const content = Array.isArray(message.content) ? (message.content as Json[]) : [];
  const output: Json[] = [];
  let pendingText: string[] = [];
  const flushText = () => {
    if (pendingText.length === 0) return;
    output.push(messageItem(`msg_${output.length}`, pendingText.join(""), "completed"));
    pendingText = [];
  };

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      pendingText.push(block.text);
      continue;
    }
    flushText();
    if (block.type === "tool_use") {
      output.push(
        functionCallItem(
          `fc_${output.length}`,
          String(block.id ?? ""),
          String(block.name ?? ""),
          JSON.stringify(block.input ?? {}),
          "completed",
        ),
      );
    } else if (block.type === "server_tool_use" && block.name === "web_search") {
      output.push(webSearchCallItem(String(block.id ?? `ws_${output.length}`), block.input, "completed"));
    } else {
      const reasoning = thinkingToReasoningItem(block, `rs_${output.length}`);
      if (reasoning) output.push(reasoning);
    }
  }
  flushText();
  if (message.stop_reason === "refusal") {
    output.push(refusalItem(`msg_${output.length}`, refusalText(message.stop_details), "completed"));
  }

  return responseObject({
    id: responseId(message.id),
    model: typeof message.model === "string" ? message.model : "",
    createdAt: Math.floor(Date.now() / 1000),
    status: finalStatus(message.stop_reason),
    output,
    usage: message.usage as AnthropicUsage | undefined,
  });
}

// Anthropic error envelope: {type:"error", error:{type, message}}.
export function messagesErrorToResponsesError(body: unknown): Json {
  const error =
    typeof body === "object" && body !== null
      ? ((body as Json).error as Json | undefined)
      : undefined;
  const type = typeof error?.type === "string" ? error.type : "api_error";
  const message = typeof error?.message === "string" ? error.message : "Upstream error";
  return { error: { message, type, code: type, param: null } };
}
