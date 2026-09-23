import { describe, expect, it } from "vitest";

import { messagesRequestToChatCompletions as anthropicRequestToChatCompletions } from "./request.js";
import {
  chatCompletionsResponseToMessages,
  extractChatCompletionsUsage as translateChatUsage,
} from "./response.js";
import { chatCompletionsStreamToMessagesStream } from "./stream.js";

// Positional shims over the options API so ported cases stay diffable against the original suite.
const chatCompletionsResponseToAnthropic = (body: Record<string, unknown>, model?: string) =>
  chatCompletionsResponseToMessages(body, { model });
const chatCompletionsSSEToAnthropicSSE = (input: ReadableStream<Uint8Array>, model?: string) =>
  chatCompletionsStreamToMessagesStream(input, { model });

describe("anthropicRequestToChatCompletions", () => {
  it("maps model, limits, sampling, stop sequences, and stream options", () => {
    const out = anthropicRequestToChatCompletions({
      model: "accounts/fireworks/models/glm-5p3-flash",
      max_tokens: 32000,
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["END"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.model).toBe("accounts/fireworks/models/glm-5p3-flash");
    expect(out.max_tokens).toBe(32000);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.temperature).toBe(0.7);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(["END"]);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps output_config.effort onto reasoning_effort and drops the Anthropic fields", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      messages: [],
    });
    expect(out.reasoning_effort).toBe("medium");
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toBeUndefined();
    expect(out.response_format).toBeUndefined();
    expect(out.stream_options).toBeUndefined();
  });

  it.each(["low", "medium", "high", "xhigh", "max"])(
    "passes effort %s through as reasoning_effort",
    (effort) => {
      const out = anthropicRequestToChatCompletions({
        model: "m",
        output_config: { effort },
        messages: [],
      });
      expect(out.reasoning_effort).toBe(effort);
    },
  );

  it("maps disabled thinking to reasoning_effort none, winning over effort", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
      messages: [],
    });
    expect(out.reasoning_effort).toBe("none");
  });

  it("uses disabledReasoningEffort for disabled thinking when the caller supplies one", () => {
    const out = anthropicRequestToChatCompletions(
      { model: "m", thinking: { type: "disabled" }, messages: [] },
      { disabledReasoningEffort: "low" },
    );
    expect(out.reasoning_effort).toBe("low");
  });

  it.each(["bogus", "constructor", "__proto__", ""])(
    "omits reasoning_effort for unknown effort %j",
    (effort) => {
      const out = anthropicRequestToChatCompletions({
        model: "m",
        output_config: { effort },
        messages: [],
      });
      expect(out.reasoning_effort).toBeUndefined();
    },
  );

  it("omits reasoning_effort when neither thinking nor effort is set", () => {
    const out = anthropicRequestToChatCompletions({ model: "m", messages: [] });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("maps output_config.format json_schema onto response_format", () => {
    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    };
    const out = anthropicRequestToChatCompletions({
      model: "m",
      output_config: { format: { type: "json_schema", schema } },
      messages: [],
    });
    expect(out.output_config).toBeUndefined();
    expect(out.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema },
    });
  });

  it("converts system, assistant tool_use, and tool_result into chat roles", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      system: [{ type: "text", text: "be helpful" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "open the site" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan...", signature: "" },
            { type: "text", text: "Opening it." },
            { type: "tool_use", id: "t1", name: "browser_open", input: { url: "https://x.test" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "opened" }] },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "open the site" },
      {
        role: "assistant",
        content: "Opening it.",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "browser_open", arguments: '{"url":"https://x.test"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "opened" },
    ]);
    // Replayed thinking must never reach the chat wire.
    expect(JSON.stringify(out)).not.toContain("plan...");
  });

  it("keeps mid-conversation system messages and splits mid-turn steers", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      messages: [
        { role: "system", content: "deferred tools listing" },
        {
          role: "system",
          content:
            "The user sent a new message while you were working: do the other thing\n<total_tokens>99 tokens left</total_tokens>",
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: "system", content: "deferred tools listing" },
      { role: "system", content: "<total_tokens>99 tokens left</total_tokens>" },
      {
        role: "user",
        content: "The user sent a new message while you were working: do the other thing",
      },
    ]);
  });

  it("surfaces tool_result images as a follow-up user message", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "screenshot taken" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "t1", content: "screenshot taken" },
      {
        role: "user",
        content: [
          { type: "text", text: "[image output from tool t1]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("converts function tools and skips server tools", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      messages: [],
      tools: [
        { name: "Bash", description: "run", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search" },
      ],
      tool_choice: { type: "any" },
    });
    expect(out.tools).toEqual([
      {
        type: "function",
        function: { name: "Bash", description: "run", parameters: { type: "object" } },
      },
    ]);
    expect(out.tool_choice).toBe("required");
  });

  it("maps tool_choice tool to a function choice only when the tool exists", () => {
    const base = {
      model: "m",
      messages: [],
      tools: [{ name: "Bash", input_schema: { type: "object" } }],
    };
    expect(
      anthropicRequestToChatCompletions({ ...base, tool_choice: { type: "tool", name: "Bash" } })
        .tool_choice,
    ).toEqual({ type: "function", function: { name: "Bash" } });
    expect(
      anthropicRequestToChatCompletions({ ...base, tool_choice: { type: "tool", name: "Nope" } })
        .tool_choice,
    ).toBeUndefined();
  });
});

describe("chatCompletionsResponseToAnthropic", () => {
  it("translates content, reasoning, and tool calls into Anthropic blocks", () => {
    const out = chatCompletionsResponseToAnthropic(
      {
        id: "chatcmpl-1",
        model: "accounts/fireworks/models/glm-5p3-flash",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Opening the site.",
              reasoning_content: "let me open it",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "browser_open", arguments: '{"url":"https://x.test"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      },
      "glm-5.3-flash",
    );
    expect(out).toEqual({
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "glm-5.3-flash",
      content: [
        { type: "thinking", thinking: "let me open it", signature: "" },
        { type: "text", text: "Opening the site." },
        { type: "tool_use", id: "call_1", name: "browser_open", input: { url: "https://x.test" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 25,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 60,
      },
    });
  });

  it("maps finish_reason length to max_tokens and null content to no text block", () => {
    const out = chatCompletionsResponseToAnthropic({
      id: "c",
      choices: [{ finish_reason: "length", message: { content: null } }],
    });
    expect(out.content).toEqual([]);
    expect(out.stop_reason).toBe("max_tokens");
  });
});

describe("translateChatUsage", () => {
  it("subtracts cached tokens from input, matching Anthropic semantics", () => {
    expect(
      translateChatUsage({
        prompt_tokens: 30295,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 30080 },
      }),
    ).toEqual({
      input_tokens: 215,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30080,
    });
  });
});

describe("chatCompletionsSSEToAnthropicSSE", () => {
  function toStream(text: string, chunkSize = 9): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
  }

  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let out = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out + dec.decode();
  }

  const chunk = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`;

  function parseEvents(sse: string): Array<Record<string, unknown>> {
    return sse
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
  }

  it("translates reasoning, text, and streamed tool calls into Anthropic events", async () => {
    const input = [
      chunk({
        id: "chatcmpl-9",
        model: "accounts/fireworks/models/glm-5p3-flash",
        choices: [{ delta: { role: "assistant", reasoning_content: "think " } }],
      }),
      chunk({ choices: [{ delta: { reasoning_content: "hard" } }] }),
      chunk({ choices: [{ delta: { content: "Opening." } }] }),
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "browser_open", arguments: '{"url":' } },
              ],
            },
          },
        ],
      }),
      chunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '"https://x.test"}' } }] } },
        ],
      }),
      chunk({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 51, completion_tokens: 25 },
      }),
      "data: [DONE]\n\n",
    ].join("");

    const out = await drain(
      chatCompletionsSSEToAnthropicSSE(toStream(input), "glm-5.3-flash"),
    );
    const events = parseEvents(out);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect((events[0].message as Record<string, unknown>).model).toBe("glm-5.3-flash");
    // thinking block, then text block, then tool_use block — each start/stop paired.
    expect(out).toContain('"type":"thinking_delta","thinking":"think "');
    expect(out).toContain('"type":"text_delta","text":"Opening."');
    expect(out).toContain('"type":"tool_use","id":"call_1","name":"browser_open"');
    expect(out).toContain('"partial_json":"{\\"url\\":"');
    const starts = types.filter((t) => t === "content_block_start").length;
    const stops = types.filter((t) => t === "content_block_stop").length;
    expect(starts).toBe(3);
    expect(stops).toBe(3);
    const delta = events.find((e) => e.type === "message_delta")!;
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("tool_use");
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(25);
    expect(types[types.length - 1]).toBe("message_stop");
  });

  it("finishes on an OpenAI-style trailing usage-only chunk", async () => {
    const input = [
      chunk({ id: "c", model: "m", choices: [{ delta: { content: "hi" } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      "data: [DONE]\n\n",
    ].join("");
    const events = parseEvents(
      await drain(chatCompletionsSSEToAnthropicSSE(toStream(input))),
    );
    const delta = events.find((e) => e.type === "message_delta")!;
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(5);
  });

  it("closes cleanly when finish_reason arrives but a usage chunk never does", async () => {
    const input = [
      chunk({ id: "c", model: "m", choices: [{ delta: { content: "hi" } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ].join("");
    const events = parseEvents(
      await drain(chatCompletionsSSEToAnthropicSSE(toStream(input))),
    );
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("emits a retryable error for a stream truncated before finish_reason", async () => {
    const input = chunk({ id: "c", model: "m", choices: [{ delta: { content: "hi" } }] });
    const events = parseEvents(
      await drain(chatCompletionsSSEToAnthropicSSE(toStream(input))),
    );
    const err = events.find((e) => e.type === "error")!;
    expect((err.error as Record<string, unknown>).type).toBe("overloaded_error");
    // Open blocks are closed so the SDK's block state stays consistent.
    expect(events.some((e) => e.type === "content_block_stop")).toBe(true);
  });
});
