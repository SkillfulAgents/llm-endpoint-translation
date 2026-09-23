import { describe, expect, it } from "vitest";

import { messagesRequestToChatCompletions as anthropicRequestToChatCompletions } from "./request.js";
import {
  chatCompletionsResponseToMessages,
  extractChatCompletionsUsage as translateChatUsage,
} from "./response.js";
import { chatCompletionsStreamToMessagesStream } from "./stream.js";
import { shortenToolName, toolNameRestoreMap } from "../shared/tool-names.js";

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

describe("anthropicRequestToChatCompletions — tool_choice none, documents, long tool names, thinking budget", () => {
  const tools = [{ name: "Bash", input_schema: { type: "object", properties: {} } }];
  const PDF = "JVBERi0xLjQK";

  it("sends tool_choice none instead of omitting it (omitted means auto)", () => {
    const out = anthropicRequestToChatCompletions({ model: "m", messages: [], tools, tool_choice: { type: "none" } });
    expect(out.tool_choice).toBe("none");
  });

  it("omits tool_choice none when no function tools are sent", () => {
    const out = anthropicRequestToChatCompletions({ model: "m", messages: [], tool_choice: { type: "none" } });
    expect(out.tool_choice).toBeUndefined();
  });

  it("maps user documents to file parts, url documents to a text note, text documents to text", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize" },
            { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: PDF } },
            { type: "document", source: { type: "url", url: "https://example.com/a.pdf" } },
            { type: "document", source: { type: "text", media_type: "text/plain", data: "plain doc" } },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize" },
          { type: "file", file: { filename: "spec.pdf", file_data: `data:application/pdf;base64,${PDF}` } },
          { type: "text", text: "[document: https://example.com/a.pdf]" },
          { type: "text", text: "plain doc" },
        ],
      },
    ]);
  });

  it("moves tool_result documents to a follow-up user message (tool content is text-only)", () => {
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
                { type: "text", text: "Read 2 pages" },
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } },
              ],
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "t1", content: "Read 2 pages" },
      {
        role: "user",
        content: [
          { type: "text", text: "[document output from tool t1]" },
          { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${PDF}` } },
        ],
      },
    ]);
  });

  it("shortens tool names over 64 chars across tools, history, and tool_choice", () => {
    const long = `mcp__${"server".repeat(8)}__${"tool".repeat(6)}`;
    const short = shortenToolName(long);
    const out = anthropicRequestToChatCompletions({
      model: "m",
      tools: [{ name: long, input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: long },
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: long, input: {} }] },
      ],
    });
    expect((out.tools as Array<{ function: { name: string } }>)[0].function.name).toBe(short);
    expect(out.tool_choice).toEqual({ type: "function", function: { name: short } });
    const history = out.messages as Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
    expect(history[1].tool_calls?.[0].function.name).toBe(short);
  });

  it("maps thinking.budget_tokens onto reasoning_effort when no explicit effort is set", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      messages: [],
      thinking: { type: "enabled", budget_tokens: 3000 },
    });
    expect(out.reasoning_effort).toBe("medium");
  });

  it("keeps an unknown explicit effort dropped rather than falling back to the budget", () => {
    const out = anthropicRequestToChatCompletions({
      model: "m",
      messages: [],
      thinking: { type: "enabled", budget_tokens: 30000 },
      output_config: { effort: "bogus" },
    });
    expect(out.reasoning_effort).toBeUndefined();
  });
});

describe("chatCompletionsResponseToAnthropic — refusals and restored tool names", () => {
  it("surfaces message.refusal as text with stop_reason refusal", () => {
    const out = chatCompletionsResponseToAnthropic({
      id: "c",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, refusal: "I can't help." } }],
    });
    expect(out.content).toEqual([{ type: "text", text: "I can't help." }]);
    expect(out.stop_reason).toBe("refusal");
  });

  it("maps finish_reason content_filter to refusal", () => {
    const out = chatCompletionsResponseToAnthropic({
      id: "c",
      choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "" } }],
    });
    expect(out.stop_reason).toBe("refusal");
  });

  it("restores shortened tool names from toolNames", () => {
    const long = "q".repeat(70);
    const out = chatCompletionsResponseToMessages(
      {
        id: "c",
        choices: [
          {
            finish_reason: "tool_calls",
            message: { tool_calls: [{ id: "k1", type: "function", function: { name: shortenToolName(long), arguments: "{}" } }] },
          },
        ],
      },
      { toolNames: toolNameRestoreMap({ tools: [{ name: long }] }) },
    );
    expect(out.content).toEqual([{ type: "tool_use", id: "k1", name: long, input: {} }]);
  });
});

describe("chatCompletionsStreamToMessagesStream — refusals and restored tool names", () => {
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n").body!;
  const frames = async (stream: ReadableStream<Uint8Array>) =>
    (await new Response(stream).text())
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as { type: string; delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string }; content_block?: Record<string, unknown> });
  const usage = { prompt_tokens: 1, completion_tokens: 1 };

  it("streams delta.refusal as text and stops with refusal", async () => {
    const out = await frames(
      chatCompletionsSSEToAnthropicSSE(
        sse([
          { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", refusal: "I can't " } }] },
          { id: "c", model: "m", choices: [{ index: 0, delta: { refusal: "help." }, finish_reason: "stop" }], usage },
        ]),
      ),
    );
    expect(out.filter((f) => f.delta?.type === "text_delta").map((f) => f.delta?.text).join("")).toBe("I can't help.");
    expect(out.find((f) => f.type === "message_delta")?.delta?.stop_reason).toBe("refusal");
  });

  it("maps a streamed content_filter finish to refusal", async () => {
    const out = await frames(
      chatCompletionsSSEToAnthropicSSE(
        sse([{ id: "c", model: "m", choices: [{ index: 0, delta: { content: "Hm" }, finish_reason: "content_filter" }], usage }]),
      ),
    );
    expect(out.find((f) => f.type === "message_delta")?.delta?.stop_reason).toBe("refusal");
  });

  it("restores shortened tool names on tool_use block starts", async () => {
    const long = "w".repeat(100);
    const out = await frames(
      chatCompletionsStreamToMessagesStream(
        sse([
          {
            id: "c",
            model: "m",
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "k1", function: { name: shortenToolName(long), arguments: "{}" } }] } }],
          },
          { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
        ]),
        { toolNames: toolNameRestoreMap({ tools: [{ name: long }] }) },
      ),
    );
    expect(out.find((f) => f.type === "content_block_start")?.content_block).toMatchObject({ type: "tool_use", name: long });
  });
});
