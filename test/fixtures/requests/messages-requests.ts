// Anthropic Messages requests covering every construct the Messages→Responses request codec handles.

type Json = Record<string, unknown>;

const PNG = "iVBORw0KGgo=";
const PDF_DOC = "JVBERi0xLjQK";
const LONG_TOOL = `mcp__${"server".repeat(8)}__${"tool".repeat(6)}`;

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
  "documents in user turn and tool result": {
    model: "gpt-5.5",
    max_tokens: 1024,
    tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize both" },
          { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: PDF_DOC } },
          { type: "document", source: { type: "url", url: "https://example.com/a.pdf" } },
          { type: "document", source: { type: "text", media_type: "text/plain", data: "plain" } },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_r", name: "Read", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_r",
            content: [
              { type: "text", text: "2 pages" },
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_DOC } },
            ],
          },
        ],
      },
    ],
  },
  "tool_choice none and a tool name over 64 chars": {
    model: "gpt-5.5",
    max_tokens: 64,
    tools: [{ name: LONG_TOOL, input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "none" },
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_l", name: LONG_TOOL, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_l", content: "ok" }] },
    ],
  },
  "forced tool over 64 chars and thinking budget": {
    model: "gpt-5.5",
    max_tokens: 64,
    thinking: { type: "enabled", budget_tokens: 8000 },
    tools: [{ name: LONG_TOOL, input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: LONG_TOOL },
    messages: [{ role: "user", content: "go" }],
  },
  "disabled thinking": {
    model: "gpt-5.5",
    max_tokens: 64,
    thinking: { type: "disabled" },
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: "Quick" }],
  },
  "no parallel tool use and an is_error tool result": {
    model: "gpt-5.5",
    max_tokens: 64,
    tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_e", name: "Bash", input: { command: "false" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e", is_error: true, content: "exit code 1" }] },
    ],
  },
};
