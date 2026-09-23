// Anthropic Messages replies and streams: recorded fixtures plus edge cases the recordings lack.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readChunksFile, type Json } from "../helpers/sse";

const ANTHROPIC = join(import.meta.dirname, "external/vercel-ai/anthropic");

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };

function reply(content: Json[], stop_reason: string, extra: Json = {}): Json {
  return {
    id: "msg_corpus",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage,
    ...extra,
  };
}

const syntheticReplies: Record<string, Json> = {
  "synthetic/thinking-tool-use": reply(
    [
      { type: "thinking", thinking: "Need the weather.", signature: "sig-abc" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Paris" } },
    ],
    "tool_use",
  ),
  "synthetic/max-tokens": reply([{ type: "text", text: "Once upon a" }], "max_tokens"),
  "synthetic/refusal-after-text": reply([{ type: "text", text: "I" }], "refusal", {
    stop_details: { type: "refusal", category: "cyber", explanation: "Not able to help with that." },
  }),
  "synthetic/speed-fast": reply([{ type: "text", text: "fast" }], "end_turn", { usage: { ...usage, speed: "fast" } }),
};

function start(): Json {
  return { type: "message_start", message: { ...reply([], "", { stop_reason: null }), usage } };
}

const syntheticStreams: Record<string, Json[]> = {
  "synthetic/thinking-tool-stream": [
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "weather", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ],
  "synthetic/max-tokens-stream": [
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Once upon" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ],
  "synthetic/refusal-stream": [
    start(),
    { type: "message_delta", delta: { stop_reason: "refusal", stop_details: null }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ],
  "synthetic/overloaded-mid-stream": [
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  ],
  "synthetic/truncated-stream": [
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut" } },
  ],
};

function recorded(suffix: string): string[] {
  return readdirSync(ANTHROPIC)
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

export const messagesReplies: Array<{ name: string; body: Json }> = [
  ...recorded(".json").map((name) => ({
    name: `anthropic/${name}`,
    body: JSON.parse(readFileSync(join(ANTHROPIC, `${name}.json`), "utf8")) as Json,
  })),
  ...Object.entries(syntheticReplies).map(([name, body]) => ({ name, body })),
];

export const messagesStreams: Array<{ name: string; events: Json[] }> = [
  ...recorded(".chunks.txt").map((name) => ({
    name: `anthropic/${name}`,
    events: readChunksFile(join(ANTHROPIC, `${name}.chunks.txt`)),
  })),
  ...Object.entries(syntheticStreams).map(([name, events]) => ({ name, events })),
];

export const messagesErrors: Array<{ name: string; body: unknown }> = [
  ...[
    "invalid_request_error",
    "authentication_error",
    "billing_error",
    "permission_error",
    "not_found_error",
    "request_too_large",
    "rate_limit_error",
    "api_error",
    "timeout_error",
    "overloaded_error",
  ].map((type) => ({ name: type, body: { type: "error", error: { type, message: `${type} happened` } } })),
  { name: "malformed body", body: "<html>502</html>" },
  { name: "empty envelope", body: { type: "error" } },
];
