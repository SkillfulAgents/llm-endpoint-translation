import { z } from "zod";

const count = z.number().int().nonnegative();

export const messagesUsage = z.strictObject({
  input_tokens: count,
  output_tokens: count,
  cache_creation_input_tokens: count,
  cache_read_input_tokens: count,
  speed: z.enum(["slow", "fast"]).optional(),
});

export const stopReason = z.enum(["end_turn", "max_tokens", "tool_use"]);

const textBlock = z.strictObject({ type: z.literal("text"), text: z.string() });
const toolUseBlock = z.strictObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const thinkingBlock = z.strictObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});
const redactedThinkingBlock = z.strictObject({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});
const imageBlock = z.strictObject({
  type: z.literal("image"),
  source: z.union([
    z.strictObject({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    z.strictObject({ type: z.literal("url"), url: z.url() }),
  ]),
});
const toolResultBlock = z.strictObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.string(),
});

export const messagesResponse = z.strictObject({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(z.discriminatedUnion("type", [textBlock, toolUseBlock, thinkingBlock])),
  stop_reason: stopReason,
  stop_sequence: z.null(),
  usage: messagesUsage,
});

export const messagesStreamEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("message_start"),
    message: z.strictObject({
      id: z.string(),
      type: z.literal("message"),
      role: z.literal("assistant"),
      model: z.string(),
      content: z.array(z.never()),
      stop_reason: z.null(),
      stop_sequence: z.null(),
      usage: messagesUsage,
    }),
  }),
  z.strictObject({
    type: z.literal("content_block_start"),
    index: count,
    content_block: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("text"), text: z.literal("") }),
      z.strictObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.strictObject({}) }),
      // Anthropic's own stream starts thinking blocks as {thinking: "", signature: ""}.
      z.strictObject({ type: z.literal("thinking"), thinking: z.literal(""), signature: z.literal("").optional() }),
    ]),
  }),
  z.strictObject({
    type: z.literal("content_block_delta"),
    index: count,
    delta: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("text_delta"), text: z.string().min(1) }),
      z.strictObject({ type: z.literal("input_json_delta"), partial_json: z.string().min(1) }),
      z.strictObject({ type: z.literal("thinking_delta"), thinking: z.string().min(1) }),
      z.strictObject({ type: z.literal("signature_delta"), signature: z.string().min(1) }),
    ]),
  }),
  z.strictObject({ type: z.literal("content_block_stop"), index: count }),
  z.strictObject({
    type: z.literal("message_delta"),
    delta: z.strictObject({ stop_reason: stopReason, stop_sequence: z.null() }),
    usage: messagesUsage,
  }),
  z.strictObject({ type: z.literal("message_stop") }),
  z.strictObject({
    type: z.literal("error"),
    error: z.strictObject({ type: z.string(), message: z.string() }),
  }),
]);

export type MessagesStreamEvent = z.infer<typeof messagesStreamEvent>;

export const messagesError = z.strictObject({
  type: z.literal("error"),
  error: z.strictObject({
    type: z.enum([
      "invalid_request_error",
      "authentication_error",
      "billing_error",
      "permission_error",
      "not_found_error",
      "conflict_error",
      "request_too_large",
      "rate_limit_error",
      "api_error",
      "timeout_error",
      "overloaded_error",
    ]),
    message: z.string().min(1),
  }),
});

const requestBlock = z.discriminatedUnion("type", [
  textBlock,
  toolUseBlock,
  thinkingBlock,
  redactedThinkingBlock,
  imageBlock,
  toolResultBlock,
]);

export const messagesRequest = z.strictObject({
  model: z.string().optional(),
  max_tokens: z.number().int().positive(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  system: z.string().optional(),
  messages: z.array(
    z.strictObject({
      role: z.enum(["user", "assistant"]),
      content: z.array(requestBlock).min(1),
    }),
  ),
  tools: z
    .array(
      z.union([
        z.strictObject({
          name: z.string(),
          description: z.string().optional(),
          input_schema: z.record(z.string(), z.unknown()),
        }),
        z.strictObject({ type: z.literal("web_search_20250305"), name: z.literal("web_search") }),
      ]),
    )
    .optional(),
  tool_choice: z
    .union([
      z.strictObject({ type: z.enum(["auto", "any"]), disable_parallel_tool_use: z.boolean().optional() }),
      z.strictObject({ type: z.literal("none") }),
      z.strictObject({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }),
    ])
    .optional(),
  thinking: z.strictObject({ type: z.literal("disabled") }).optional(),
  output_config: z
    .strictObject({
      effort: z.string().optional(),
      format: z
        .strictObject({ type: z.literal("json_schema"), name: z.unknown(), schema: z.unknown() })
        .optional(),
    })
    .optional(),
});
