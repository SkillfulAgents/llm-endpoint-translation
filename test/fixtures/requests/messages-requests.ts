// Anthropic Messages requests covering every construct the Messages→Responses request codec handles.

type Json = Record<string, unknown>;

const PNG = "iVBORw0KGgo=";

export const messagesRequests: Record<string, Json> = {
  "plain text": {
    model: "gpt-5.5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  },
  "system blocks and sampling params": {
    model: "gpt-5.5",
    max_tokens: 512,
    temperature: 0.3,
    top_p: 0.9,
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1\n" },
      { type: "text", text: "You are terse." },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  },
  "images, base64 and url": {
    model: "gpt-5.5",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        ],
      },
    ],
  },
  "tool loop with image tool result and mid-turn steer": {
    model: "gpt-5.5",
    max_tokens: 2048,
    stream: true,
    tools: [
      {
        name: "screenshot",
        description: "Take a screenshot",
        input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
      { name: "noop" },
    ],
    tool_choice: { type: "any" },
    messages: [
      { role: "user", content: "Open example.com" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Opening." },
          { type: "tool_use", id: "toolu_1", name: "screenshot", input: { url: "https://example.com" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "done" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            ],
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content:
              "ok\n<system-reminder>\nThe user sent a new message while you were working:\nstop after this\n</system-reminder>",
          },
        ],
      },
    ],
  },
  "system-role steer message": {
    model: "gpt-5.5",
    max_tokens: 64,
    messages: [
      { role: "user", content: "Start" },
      {
        role: "system",
        content:
          "The user sent a new message while you were working:\nuse python\n<system-reminder>budget low</system-reminder>",
      },
    ],
  },
  "web search, forced function, json_schema, effort": {
    model: "gpt-5.5",
    max_tokens: 4096,
    tools: [
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250910", name: "web_fetch" },
      { name: "record", input_schema: { type: "object", properties: {} } },
    ],
    tool_choice: { type: "tool", name: "record" },
    output_config: {
      effort: "max",
      format: {
        type: "json_schema",
        name: "Result!",
        schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      },
    },
    messages: [{ role: "user", content: "Find it" }],
  },
  "disabled thinking": {
    model: "gpt-5.5",
    max_tokens: 64,
    thinking: { type: "disabled" },
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: "Quick" }],
  },
};
