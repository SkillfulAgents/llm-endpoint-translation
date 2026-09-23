import { describe, expect, it } from "vitest";

import { TranslationError } from "../errors.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, responsesRequestToMessages } from "./request.js";

describe("responsesRequestToMessages", () => {
  it("maps a string input with instructions to a single user turn", () => {
    expect(
      responsesRequestToMessages({
        model: "claude-opus-5",
        instructions: "Be brief.",
        input: "hi",
        stream: true,
        temperature: 0.2,
      }),
    ).toEqual({
      model: "claude-opus-5",
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      stream: true,
      temperature: 0.2,
      system: "Be brief.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
  });

  it("folds system and developer messages into the top-level system prompt", () => {
    const out = responsesRequestToMessages({
      model: "m",
      instructions: "A",
      input: [
        { role: "developer", content: "B" },
        { type: "message", role: "system", content: [{ type: "input_text", text: "C" }] },
        { role: "user", content: "q" },
      ],
    });
    expect(out.system).toBe("A\n\nB\n\nC");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "q" }] }]);
  });

  it("merges tool calls and results into alternating assistant/user turns", () => {
    const out = responsesRequestToMessages({
      model: "m",
      max_output_tokens: 100,
      input: [
        { role: "user", content: "weather?" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
    });
    expect(out.max_tokens).toBe(100);
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }] },
    ]);
  });

  it("maps function and web search tools plus tool_choice", () => {
    const out = responsesRequestToMessages({
      model: "m",
      input: "x",
      tools: [
        { type: "function", name: "f", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } },
        { type: "web_search" },
      ],
      tool_choice: { type: "function", name: "f" },
      parallel_tool_calls: false,
    });
    expect(out.tools).toEqual([
      { name: "f", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } },
      { type: "web_search_20250305", name: "web_search" },
    ]);
    expect(out.tool_choice).toEqual({ type: "tool", name: "f", disable_parallel_tool_use: true });
  });

  it.each([
    ["auto", { type: "auto" }],
    ["required", { type: "any" }],
    ["none", { type: "none" }],
  ])("maps tool_choice %s", (choice, expected) => {
    expect(responsesRequestToMessages({ model: "m", input: "x", tool_choice: choice }).tool_choice).toEqual(expected);
  });

  it("maps reasoning effort and json_schema output to output_config", () => {
    const out = responsesRequestToMessages({
      model: "m",
      input: "x",
      reasoning: { effort: "high" },
      text: { format: { type: "json_schema", name: "r", schema: { type: "object" } } },
    });
    expect(out.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", name: "r", schema: { type: "object" } },
    });
  });

  it("disables thinking for effort none/minimal", () => {
    expect(responsesRequestToMessages({ model: "m", input: "x", reasoning: { effort: "minimal" } }).thinking).toEqual({
      type: "disabled",
    });
  });

  it("maps data: and https: images", () => {
    const out = responsesRequestToMessages({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            { type: "input_image", image_url: "https://example.com/a.png" },
          ],
        },
      ],
    });
    expect((out.messages as Array<{ content: unknown[] }>)[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    ]);
  });

  it("replays reasoning items that carry a library-issued thinking signature and drops foreign ones", () => {
    const out = responsesRequestToMessages({
      model: "m",
      input: [
        { role: "user", content: "q" },
        { type: "reasoning", id: "rs_0", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "th:sig" },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA-openai-blob" },
        { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      ],
    });
    expect((out.messages as Array<{ content: unknown[] }>)[1].content).toEqual([
      { type: "thinking", thinking: "think", signature: "sig" },
      { type: "tool_use", id: "c", name: "f", input: {} },
    ]);
  });

  it.each([
    ["previous_response_id", { previous_response_id: "resp_1" }],
    ["conversation", { conversation: "conv_1" }],
    ["background", { background: true }],
    ["unknown tool", { tools: [{ type: "file_search" }] }],
    ["unknown item", { input: [{ type: "item_reference", id: "x" }] }],
    ["file input", { input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] }],
    ["json_object format", { text: { format: { type: "json_object" } } }],
    ["bad arguments", { input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{" }] }],
    ["non-array input", { input: 42 }],
  ])("rejects %s with a TranslationError", (_label, extra) => {
    expect(() => responsesRequestToMessages({ model: "m", input: "x", ...extra })).toThrow(TranslationError);
  });
});
