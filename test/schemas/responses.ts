import { z } from "zod";

const count = z.number().int().nonnegative();

const jsonString = z.string().refine((s) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}, "not valid JSON");

export const responsesUsage = z.strictObject({
  input_tokens: count,
  input_tokens_details: z.strictObject({ cached_tokens: count, cache_write_tokens: count }),
  output_tokens: count,
  output_tokens_details: z.strictObject({ reasoning_tokens: count }),
  total_tokens: count,
});

const outputText = z.strictObject({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.unknown()),
  logprobs: z.array(z.unknown()).max(0),
});

const refusalPart = z.strictObject({ type: z.literal("refusal"), refusal: z.string() });
const contentPart = z.discriminatedUnion("type", [outputText, refusalPart]);

export const messageItem = z.strictObject({
  type: z.literal("message"),
  id: z.string(),
  status: z.enum(["in_progress", "completed", "incomplete"]),
  role: z.literal("assistant"),
  content: z.array(contentPart),
});

export const functionCallItem = z.strictObject({
  type: z.literal("function_call"),
  id: z.string(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  status: z.enum(["in_progress", "completed", "incomplete"]),
});

export const reasoningItem = z.strictObject({
  type: z.literal("reasoning"),
  id: z.string(),
  summary: z.array(z.strictObject({ type: z.literal("summary_text"), text: z.string() })),
  encrypted_content: z.string().optional(),
});

export const webSearchCallItem = z.strictObject({
  type: z.literal("web_search_call"),
  id: z.string(),
  status: z.enum(["in_progress", "completed", "failed"]),
  action: z.strictObject({
    type: z.literal("search"),
    query: z.string().optional(),
    queries: z.array(z.string()).optional(),
  }),
});

export const outputItem = z.discriminatedUnion("type", [
  messageItem,
  functionCallItem,
  reasoningItem,
  webSearchCallItem,
]);

export const responseObject = z.strictObject({
  id: z.string().startsWith("resp_"),
  object: z.literal("response"),
  created_at: count,
  status: z.enum(["in_progress", "completed", "incomplete", "failed"]),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
  incomplete_details: z.strictObject({ reason: z.literal("max_output_tokens") }).nullable(),
  model: z.string(),
  output: z.array(outputItem),
  instructions: z.null(),
  tools: z.array(z.unknown()).max(0),
  tool_choice: z.literal("auto"),
  parallel_tool_calls: z.literal(true),
  temperature: z.null(),
  top_p: z.null(),
  metadata: z.strictObject({}),
  store: z.literal(false),
  service_tier: z.enum(["default", "flex", "priority"]),
  usage: responsesUsage.optional(),
});

export const completedFunctionCall = functionCallItem.extend({ arguments: jsonString });

const seq = { sequence_number: count };
const itemRef = { item_id: z.string(), output_index: count };

export const responsesStreamEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("response.created"), ...seq, response: responseObject }),
  z.strictObject({ type: z.literal("response.in_progress"), ...seq, response: responseObject }),
  z.strictObject({ type: z.literal("response.completed"), ...seq, response: responseObject }),
  z.strictObject({ type: z.literal("response.incomplete"), ...seq, response: responseObject }),
  z.strictObject({ type: z.literal("response.failed"), ...seq, response: responseObject }),
  z.strictObject({
    type: z.literal("response.output_item.added"),
    ...seq,
    output_index: count,
    item: outputItem,
  }),
  z.strictObject({
    type: z.literal("response.output_item.done"),
    ...seq,
    output_index: count,
    item: outputItem,
  }),
  z.strictObject({
    type: z.literal("response.content_part.added"),
    ...seq,
    ...itemRef,
    content_index: count,
    part: contentPart,
  }),
  z.strictObject({
    type: z.literal("response.content_part.done"),
    ...seq,
    ...itemRef,
    content_index: count,
    part: contentPart,
  }),
  z.strictObject({
    type: z.literal("response.refusal.delta"),
    ...seq,
    ...itemRef,
    content_index: count,
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("response.refusal.done"),
    ...seq,
    ...itemRef,
    content_index: count,
    refusal: z.string(),
  }),
  z.strictObject({
    type: z.literal("response.output_text.delta"),
    ...seq,
    ...itemRef,
    content_index: count,
    delta: z.string(),
    logprobs: z.array(z.unknown()).max(0),
  }),
  z.strictObject({
    type: z.literal("response.output_text.done"),
    ...seq,
    ...itemRef,
    content_index: count,
    text: z.string(),
    logprobs: z.array(z.unknown()).max(0),
  }),
  z.strictObject({
    type: z.literal("response.function_call_arguments.delta"),
    ...seq,
    ...itemRef,
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("response.function_call_arguments.done"),
    ...seq,
    ...itemRef,
    arguments: z.string(),
  }),
  z.strictObject({
    type: z.literal("response.reasoning_summary_part.added"),
    ...seq,
    ...itemRef,
    summary_index: count,
    part: z.strictObject({ type: z.literal("summary_text"), text: z.string() }),
  }),
  z.strictObject({
    type: z.literal("response.reasoning_summary_part.done"),
    ...seq,
    ...itemRef,
    summary_index: count,
    part: z.strictObject({ type: z.literal("summary_text"), text: z.string() }),
  }),
  z.strictObject({
    type: z.literal("response.reasoning_summary_text.delta"),
    ...seq,
    ...itemRef,
    summary_index: count,
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("response.reasoning_summary_text.done"),
    ...seq,
    ...itemRef,
    summary_index: count,
    text: z.string(),
  }),
]);

export type ResponsesStreamEvent = z.infer<typeof responsesStreamEvent>;

export const responsesError = z.strictObject({
  error: z.strictObject({
    message: z.string(),
    type: z.string(),
    code: z.string(),
    param: z.null(),
  }),
});

const inputText = z.strictObject({ type: z.literal("input_text"), text: z.string() });
const inputImage = z.strictObject({
  type: z.literal("input_image"),
  image_url: z.string(),
  detail: z.literal("high"),
});

export const responsesRequest = z.strictObject({
  store: z.literal(false),
  model: z.string().optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  instructions: z.string().optional(),
  input: z.array(
    z.union([
      z.strictObject({
        role: z.enum(["user", "system"]),
        content: z.array(z.discriminatedUnion("type", [inputText, inputImage])).min(1),
      }),
      z.strictObject({
        role: z.literal("assistant"),
        content: z.array(z.strictObject({ type: z.literal("output_text"), text: z.string() })).min(1),
      }),
      z.strictObject({ type: z.literal("function_call"), call_id: z.string(), name: z.string(), arguments: jsonString }),
      z.strictObject({ type: z.literal("function_call_output"), call_id: z.string(), output: z.string() }),
      z.strictObject({
        type: z.literal("reasoning"),
        id: z.string(),
        encrypted_content: z.string(),
        summary: z.array(z.strictObject({ type: z.literal("summary_text"), text: z.string() })),
      }),
    ]),
  ),
  tools: z
    .array(
      z.union([
        z.strictObject({ type: z.literal("web_search") }),
        z.strictObject({
          type: z.literal("function"),
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()),
          strict: z.literal(false),
        }),
      ]),
    )
    .optional(),
  tool_choice: z
    .union([z.enum(["auto", "required"]), z.strictObject({ type: z.literal("function"), name: z.string() })])
    .optional(),
  reasoning: z
    .strictObject({
      effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
      summary: z.literal("auto"),
    })
    .optional(),
  include: z.tuple([z.literal("reasoning.encrypted_content")]).optional(),
  service_tier: z.enum(["flex", "priority"]).optional(),
  text: z
    .strictObject({
      format: z.strictObject({
        type: z.literal("json_schema"),
        name: z.string(),
        schema: z.record(z.string(), z.unknown()),
        strict: z.boolean(),
      }),
    })
    .optional(),
});
