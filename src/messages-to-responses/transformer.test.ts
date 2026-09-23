import { describe, expect, it } from "vitest";

import { createEffortMapper } from "../shared/effort.js";
import {
  decodeReasoningSignature,
  encodeReasoningSignature,
  reasoningReplayScope,
} from "./reasoning-replay.js";
import {
  hasWebFetchTool,
  messagesRequestToResponses,
  type ResponsesRequestOptions,
} from "./request.js";
import { responsesResponseToMessages, type ResponsesResponseOptions } from "./response.js";
import { responsesStreamToMessagesStream, type ResponsesStreamOptions } from "./stream.js";

// Positional shims over the options API so ported cases stay diffable against the original suite.
const buildResponsesRequest = messagesRequestToResponses;
const anthropicRequestToResponses = (body: Record<string, unknown>, options?: ResponsesRequestOptions) =>
  messagesRequestToResponses(body, options).body;
const responsesResponseToAnthropic = (
  body: Record<string, unknown>,
  model?: string,
  options?: ResponsesResponseOptions,
) => responsesResponseToMessages(body, { ...options, model });
const responsesSSEToAnthropicSSE = (
  input: ReadableStream<Uint8Array>,
  model?: string,
  onServiceTier?: (tier: string) => void,
  options?: Omit<ResponsesStreamOptions, "model" | "onServiceTier">,
) => responsesStreamToMessagesStream(input, { ...options, model, onServiceTier });
const mapGrokReasoningEffort = createEffortMapper({ disabledEffort: "low", maxEffort: "xhigh" });


describe("anthropicRequestToResponses", () => {
  it("maps system → instructions and messages → input items", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      system: "be terse",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.model).toBe("gpt-5.5");
    expect(out.instructions).toBe("be terse");
    expect(out.max_output_tokens).toBe(256);
    expect(out.store).toBe(false);
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("sets service_tier from the serviceTier option and omits it otherwise", () => {
    const withTier = anthropicRequestToResponses(
      { model: "gpt-5.5", messages: [] },
      { serviceTier: "priority" },
    );
    expect(withTier.service_tier).toBe("priority");

    const withoutTier = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [],
    });
    expect(withoutTier.service_tier).toBeUndefined();
  });

  it("emits function_call / function_call_output as top-level input items", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "result" },
          ],
        },
      ],
    });
    expect(out.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "calling" }] },
      { type: "function_call", call_id: "call_1", name: "search", arguments: JSON.stringify({ q: "x" }) },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ]);
  });

  it("flattens function tools and maps the web_search server tool", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [],
      tools: [
        { name: "search", description: "d", input_schema: { type: "object", properties: {} } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    });
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "d",
        parameters: { type: "object", properties: {} },
        // Explicit false (not omitted) so the Responses API omits unused optional
        // params instead of filling them with ""/[]. See vercel/ai#11869.
        strict: false,
      },
      { type: "web_search" },
    ]);
  });

  it("drops native web_fetch (no Responses equivalent; do not mis-map to a function)", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [],
      tools: [
        { type: "web_fetch_20250910", name: "web_fetch" },
        { name: "search", input_schema: { type: "object", properties: {} } },
      ],
    });
    expect(out.tools).toEqual([
      expect.objectContaining({ type: "function", name: "search" }),
    ]);
  });

  it("hasWebFetchTool detects typed and named web_fetch tools", () => {
    expect(
      hasWebFetchTool({
        tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      }),
    ).toBe(true);
    expect(hasWebFetchTool({ tools: [{ name: "web_fetch" }] })).toBe(true);
    expect(
      hasWebFetchTool({
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    ).toBe(false);
  });

  it("translates tool_choice only when the forced function exists", () => {
    const tools = [{ name: "search", input_schema: { type: "object", properties: {} } }];
    // auto → bare string "auto" (Responses API rejects { type: "auto" })
    expect(
      anthropicRequestToResponses({ model: "gpt-5.5", messages: [], tools, tool_choice: { type: "auto" } }).tool_choice,
    ).toBe("auto");
    // any → bare string "required" (function tools present)
    expect(
      anthropicRequestToResponses({ model: "gpt-5.5", messages: [], tools, tool_choice: { type: "any" } }).tool_choice,
    ).toBe("required");
    // tool with a name that IS a function tool
    expect(
      anthropicRequestToResponses({ model: "gpt-5.5", messages: [], tools, tool_choice: { type: "tool", name: "search" } }).tool_choice,
    ).toEqual({ type: "function", name: "search" });
    // forcing web_search (a built-in, not a function) is dropped to avoid a 400
    expect(
      anthropicRequestToResponses({
        model: "gpt-5.5",
        messages: [],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        tool_choice: { type: "tool", name: "web_search" },
      }).tool_choice,
    ).toBeUndefined();
  });

  it("maps effort → reasoning.effort (and keeps it alongside tools)", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [],
      output_config: { effort: "high" },
      tools: [{ name: "search", input_schema: { type: "object", properties: {} } }],
    });
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.tools).toBeDefined();
    expect(out.text).toBeUndefined();
  });

  it("maps output_config.format json_schema onto text.format", () => {
    const schema = {
      type: "object",
      properties: { action: { type: "string" }, text: { type: "string" } },
      required: ["action", "text"],
      additionalProperties: false,
    };
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [],
      output_config: { format: { type: "json_schema", schema } },
    });
    expect(out.text).toEqual({
      format: { type: "json_schema", name: "response", schema, strict: true },
    });
    expect(out.output_config).toBeUndefined();
  });

  it("uses the injected mapReasoningEffort (xAI clamps disabled → low)", () => {
    const out = anthropicRequestToResponses(
      {
        model: "grok-4.5",
        messages: [],
        thinking: { type: "disabled" },
        output_config: { effort: "high" },
      },
      { mapReasoningEffort: mapGrokReasoningEffort },
    );
    expect(out.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("preserves xhigh reasoning for grok-4.6", () => {
    const out = anthropicRequestToResponses(
      {
        model: "grok-4.6",
        messages: [],
        output_config: { effort: "max" },
      },
      { mapReasoningEffort: mapGrokReasoningEffort },
    );
    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });
});

describe("anthropicRequestToResponses — reasoning replay", () => {
  const scope = reasoningReplayScope("openai-responses", "gpt-6-astra");
  const signed = (id: string, blob: string, thinking = "") => ({
    type: "thinking",
    thinking,
    signature: encodeReasoningSignature({ scope, id, encryptedContent: blob }),
  });

  it("requests reasoning.encrypted_content whenever replay is scoped, even without explicit effort", () => {
    const scoped = anthropicRequestToResponses(
      { model: "gpt-6-astra", messages: [], output_config: { effort: "medium" } },
      { reasoningReplayScope: scope },
    );
    expect(scoped.include).toEqual(["reasoning.encrypted_content"]);

    const unscoped = anthropicRequestToResponses({
      model: "gpt-6-astra",
      messages: [],
      output_config: { effort: "medium" },
    });
    expect(unscoped.include).toBeUndefined();

    // thinking.enabled + budget, no output_config.effort: mapper leaves the
    // vendor default in effect, but we still need the blob for carry-over.
    const defaultEffort = anthropicRequestToResponses(
      {
        model: "gpt-6-astra",
        messages: [],
        thinking: { type: "enabled", budget_tokens: 10000 },
      },
      { reasoningReplayScope: scope },
    );
    expect(defaultEffort.reasoning).toBeUndefined();
    expect(defaultEffort.include).toEqual(["reasoning.encrypted_content"]);

    const grokDefault = anthropicRequestToResponses(
      {
        model: "grok-4.5",
        messages: [],
        thinking: { type: "enabled", budget_tokens: 10000 },
      },
      { reasoningReplayScope: scope, mapReasoningEffort: mapGrokReasoningEffort },
    );
    expect(grokDefault.reasoning).toBeUndefined();
    expect(grokDefault.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("can request a fresh blob without replaying prior reasoning items", () => {
    const { body, replayedReasoning } = buildResponsesRequest(
      {
        model: "gpt-6-astra",
        messages: [
          {
            role: "assistant",
            content: [
              signed("rs_1", "BLOB1", "planned"),
              { type: "tool_use", id: "call_1", name: "Read", input: {} },
            ],
          },
        ],
      },
      { reasoningReplayScope: scope, replayPriorReasoning: false },
    );
    expect(replayedReasoning).toBe(0);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect((body.input as Array<{ type?: string }>).some((i) => i.type === "reasoning")).toBe(
      false,
    );
  });

  it("replays a signed thinking block as a reasoning item ahead of its function_call", () => {
    const { body, replayedReasoning } = buildResponsesRequest(
      {
        model: "gpt-6-astra",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [
              signed("rs_1", "BLOB1", "**Planning**\n\nfirst"),
              { type: "tool_use", id: "call_1", name: "Read", input: { path: "a" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
        ],
      },
      { reasoningReplayScope: scope },
    );
    expect(replayedReasoning).toBe(1);
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "go" }] },
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "BLOB1",
        summary: [{ type: "summary_text", text: "**Planning**\n\nfirst" }],
      },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  it("keeps block order: reasoning → message → function_call, with an empty summary array", () => {
    const { body } = buildResponsesRequest(
      {
        model: "gpt-6-astra",
        messages: [
          {
            role: "assistant",
            content: [
              signed("rs_1", "BLOB1"),
              { type: "text", text: "Looking now." },
              { type: "tool_use", id: "call_1", name: "Read", input: {} },
            ],
          },
        ],
      },
      { reasoningReplayScope: scope },
    );
    expect((body.input as Array<{ type?: string; role?: string }>).map((i) => i.type ?? i.role)).toEqual([
      "reasoning",
      "assistant",
      "function_call",
    ]);
    expect((body.input as Array<Record<string, unknown>>)[0].summary).toEqual([]);
  });

  it("drops an orphan reasoning block (nothing follows it) — the vendor 400s on those", () => {
    const { body, replayedReasoning } = buildResponsesRequest(
      {
        model: "gpt-6-astra",
        messages: [{ role: "assistant", content: [signed("rs_1", "BLOB1", "dangling")] }],
      },
      { reasoningReplayScope: scope },
    );
    expect(replayedReasoning).toBe(0);
    expect(body.input).toEqual([]);
  });

  it("drops reasoning minted under another scope (model/upstream switch) and unsigned thinking", () => {
    const other = encodeReasoningSignature({
      scope: reasoningReplayScope("xai-responses", "grok-4.6"),
      id: "rs_x",
      encryptedContent: "XBLOB",
    });
    const { body, replayedReasoning } = buildResponsesRequest(
      {
        model: "gpt-6-astra",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "unsigned", signature: "" },
              { type: "thinking", thinking: "claude", signature: "ErUBCkYIBRgCIkD" },
              { type: "thinking", thinking: "grok", signature: other },
              { type: "text", text: "hi" },
            ],
          },
        ],
      },
      { reasoningReplayScope: scope },
    );
    expect(replayedReasoning).toBe(0);
    expect(body.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
  });

  it("never replays reasoning when no scope is configured", () => {
    const { body, replayedReasoning } = buildResponsesRequest({
      model: "gpt-6-astra",
      messages: [
        { role: "assistant", content: [signed("rs_1", "BLOB1", "t"), { type: "text", text: "hi" }] },
      ],
    });
    expect(replayedReasoning).toBe(0);
    expect(body.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
  });

  it("replays each reasoning id once even if the block was duplicated", () => {
    const { replayedReasoning } = buildResponsesRequest(
      {
        model: "gpt-6-astra",
        messages: [
          {
            role: "assistant",
            content: [signed("rs_1", "BLOB1", "a"), signed("rs_1", "BLOB1", "a"), { type: "text", text: "hi" }],
          },
        ],
      },
      { reasoningReplayScope: scope },
    );
    expect(replayedReasoning).toBe(1);
  });
});

describe("responsesResponseToAnthropic", () => {
  it("maps output message + function_call into Anthropic content blocks", () => {
    const out = responsesResponseToAnthropic({
      id: "resp_1",
      model: "gpt-5.5",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "call_1", name: "search", arguments: '{"q":"x"}' },
      ],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
    });
    expect(out.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
    ]);
    expect(out.stop_reason).toBe("tool_use");
    expect(out.usage).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30,
    });
  });

  it("text-only response stops with end_turn", () => {
    const out = responsesResponseToAnthropic({
      id: "resp_2",
      model: "gpt-5.5",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    });
    expect(out.stop_reason).toBe("end_turn");
  });

  it("emits a thinking block only when the reasoning summary is non-empty", () => {
    const withSummary = responsesResponseToAnthropic({
      id: "resp_r1",
      model: "gpt-5.5",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "weighing options" }] },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
      ],
    });
    expect(withSummary.content).toEqual([
      { type: "thinking", thinking: "weighing options" },
      { type: "text", text: "done" },
    ]);

    const emptySummary = responsesResponseToAnthropic({
      id: "resp_r2",
      model: "gpt-5.5",
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
      ],
    });
    expect(emptySummary.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("signs thinking blocks with the encrypted reasoning when replay is scoped", () => {
    const scope = reasoningReplayScope("openai-responses", "gpt-6-astra");
    const out = responsesResponseToAnthropic(
      {
        id: "resp_r3",
        model: "gpt-6-astra",
        output: [
          { type: "reasoning", id: "rs_a", encrypted_content: "ENC_A", summary: [{ type: "summary_text", text: "plan" }] },
          { type: "reasoning", id: "rs_b", encrypted_content: "ENC_B", summary: [] },
          { type: "reasoning", id: "rs_c", encrypted_content: null, summary: [] },
          { type: "message", content: [{ type: "output_text", text: "done" }] },
        ],
      },
      "gpt-6-astra",
      { reasoningReplayScope: scope },
    );
    const content = out.content as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(["thinking", "thinking", "text"]);
    expect(content[0].thinking).toBe("plan");
    expect(decodeReasoningSignature(content[0].signature)).toEqual({ scope, id: "rs_a", encryptedContent: "ENC_A" });
    // Summary-less reasoning still surfaces (as an empty block) so its blob replays.
    expect(content[1].thinking).toBe("");
    expect(decodeReasoningSignature(content[1].signature)).toEqual({ scope, id: "rs_b", encryptedContent: "ENC_B" });
  });

  it("leaves thinking blocks unsigned when replay is not scoped", () => {
    const out = responsesResponseToAnthropic({
      id: "resp_r4",
      model: "gpt-6-astra",
      output: [
        { type: "reasoning", id: "rs_a", encrypted_content: "ENC_A", summary: [{ type: "summary_text", text: "plan" }] },
      ],
    });
    expect(out.content).toEqual([{ type: "thinking", thinking: "plan" }]);
  });

  it("overrides OpenAI's dated snapshot model with the canonical id", () => {
    const out = responsesResponseToAnthropic(
      {
        id: "resp_3",
        model: "gpt-5.5-2026-04-23",
        output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      },
      "gpt-5.5",
    );
    expect(out.model).toBe("gpt-5.5");
  });
});

describe("responsesSSEToAnthropicSSE", () => {
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  function sourceFrom(events: unknown[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const e of events) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
  }

  it("translates a text stream into Anthropic events with usage", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hel" },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "lo" },
      { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain("event: message_start");
    expect(out).toContain('"type":"text_delta","text":"Hel"');
    expect(out).toContain('"type":"text_delta","text":"lo"');
    expect(out).toContain("event: content_block_stop");
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain("event: message_stop");
  });

  it("emits the canonical model in message_start, not OpenAI's dated snapshot", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_1", model: "gpt-5.5-2026-04-23" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source, "gpt-5.5"));
    expect(out).toContain('"model":"gpt-5.5"');
    expect(out).not.toContain("gpt-5.5-2026-04-23");
  });

  it("reports service_tier snapshots to the callback, last one winning", async () => {
    const tiers: string[] = [];
    const source = sourceFrom([
      // response.created echoes the REQUESTED tier; only the terminal event
      // reflects what was granted.
      { type: "response.created", response: { id: "r", model: "gpt-5.5", service_tier: "priority" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
      {
        type: "response.completed",
        response: { service_tier: "default", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);
    await collect(
      responsesSSEToAnthropicSSE(source, "gpt-5.5", (t) => tiers.push(t)),
    );
    expect(tiers).toEqual(["priority", "default"]);
    expect(tiers[tiers.length - 1]).toBe("default");
  });

  it("does not invoke the tier callback when no event carries service_tier", async () => {
    const tiers: string[] = [];
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", model: "gpt-5.5" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    await collect(
      responsesSSEToAnthropicSSE(source, "gpt-5.5", (t) => tiers.push(t)),
    );
    expect(tiers).toEqual([]);
  });

  it("echoes the served tier into translated usage: priority → speed fast", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", model: "gpt-5.5", service_tier: "priority" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
      {
        type: "response.completed",
        response: { service_tier: "priority", usage: { input_tokens: 3, output_tokens: 1 } },
      },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source, "gpt-5.5"));
    const delta = out
      .split("\n\n")
      .find((frame) => frame.includes("message_delta"));
    expect(delta).toContain('"speed":"fast"');
  });

  it("echoes flex as speed slow, and omits speed for the default tier", async () => {
    const flex = await collect(
      responsesSSEToAnthropicSSE(
        sourceFrom([
          { type: "response.created", response: { id: "r", service_tier: "flex" } },
          {
            type: "response.completed",
            response: { service_tier: "flex", usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
        "gpt-5.5",
      ),
    );
    expect(flex).toContain('"speed":"slow"');

    const standard = await collect(
      responsesSSEToAnthropicSSE(
        sourceFrom([
          { type: "response.created", response: { id: "r", service_tier: "default" } },
          {
            type: "response.completed",
            response: { service_tier: "default", usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
        "gpt-5.5",
      ),
    );
    expect(standard).not.toContain('"speed"');
  });

  it("falls back to the last snapshot when the terminal event omits service_tier", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", service_tier: "priority" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source, "gpt-5.5"));
    expect(out).toContain('"speed":"fast"');
  });

  it("streams reasoning summary as thinking_delta", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_r", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking..." },
      { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain('"type":"thinking"');
    expect(out).toContain('"type":"thinking_delta","thinking":"thinking..."');
  });

  it("emits no thinking block when a reasoning item has no summary", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_r", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
      { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).not.toContain('"type":"thinking"');
    expect(out).toContain('"type":"text_delta","text":"hi"');
  });

  it("ignores empty-string reasoning deltas (no thinking block, no stray stop)", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_r", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "" },
      { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
      { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).not.toContain('"type":"thinking"');
    const stops = out.match(/event: content_block_stop/g) ?? [];
    expect(stops).toHaveLength(1);
  });

  it("emits the thinking block before the text block when reasoning is non-empty", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_r", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "think" },
      { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "answer" },
      { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out.indexOf('"type":"thinking"')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('"type":"thinking"')).toBeLessThan(out.indexOf('"type":"text"'));
  });

  describe("reasoning replay signatures", () => {
    const scope = reasoningReplayScope("openai-responses", "gpt-6-astra");
    const frames = (out: string) =>
      out
        .split("\n\n")
        .filter((f) => f.startsWith("event: "))
        .map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)) as Record<string, unknown>);

    it("emits signature_delta with the encrypted blob before the thinking block stops", async () => {
      const source = sourceFrom([
        { type: "response.created", response: { id: "resp_r", model: "gpt-6-astra" } },
        { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", summary: [] } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "think" },
        { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning", encrypted_content: "ENC1", summary: [{ type: "summary_text", text: "think" }] } },
        { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
        { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      const out = frames(
        await collect(responsesSSEToAnthropicSSE(source, "gpt-6-astra", undefined, { reasoningReplayScope: scope })),
      );
      const types = out.map((e) => `${e.type}${(e.delta as Record<string, unknown> | undefined)?.type ? ":" + (e.delta as Record<string, unknown>).type : ""}`);
      expect(types).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta:thinking_delta",
        "content_block_delta:signature_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta:input_json_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      const sig = (out[3].delta as Record<string, unknown>).signature;
      expect(decodeReasoningSignature(sig)).toEqual({ scope, id: "rs_1", encryptedContent: "ENC1" });
      expect(out[3].index).toBe(0);
      expect(out[4].index).toBe(0);
    });

    it("opens an empty thinking block at output_item.done for summary-less reasoning that carries a blob", async () => {
      const source = sourceFrom([
        { type: "response.created", response: { id: "resp_r", model: "gpt-6-astra" } },
        { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", summary: [] } },
        { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning", encrypted_content: "ENC1", summary: [] } },
        { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
        { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      const out = frames(
        await collect(responsesSSEToAnthropicSSE(source, "gpt-6-astra", undefined, { reasoningReplayScope: scope })),
      );
      const starts = out.filter((e) => e.type === "content_block_start");
      expect(starts.map((e) => (e.content_block as Record<string, unknown>).type)).toEqual(["thinking", "text"]);
      expect(starts[0].index).toBe(0);
      expect(starts[1].index).toBe(1);
      const sigs = out.filter((e) => (e.delta as Record<string, unknown> | undefined)?.type === "signature_delta");
      expect(sigs).toHaveLength(1);
      expect(out.filter((e) => e.type === "content_block_stop")).toHaveLength(2);
    });

    it("does not surface summary-less reasoning without a blob, even when scoped", async () => {
      const source = sourceFrom([
        { type: "response.created", response: { id: "resp_r", model: "gpt-6-astra" } },
        { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", summary: [] } },
        { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning", encrypted_content: null, summary: [] } },
        { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
        { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      const out = await collect(
        responsesSSEToAnthropicSSE(source, "gpt-6-astra", undefined, { reasoningReplayScope: scope }),
      );
      expect(out).not.toContain('"type":"thinking"');
      expect(out).not.toContain("signature_delta");
    });

    it("never emits a signature when replay is not scoped", async () => {
      const source = sourceFrom([
        { type: "response.created", response: { id: "resp_r", model: "gpt-6-astra" } },
        { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "think" },
        { type: "response.output_item.done", item: { id: "rs_1", type: "reasoning", encrypted_content: "ENC1" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      const out = await collect(responsesSSEToAnthropicSSE(source, "gpt-6-astra"));
      expect(out).toContain('"type":"thinking_delta","thinking":"think"');
      expect(out).not.toContain("signature_delta");
    });

    it("signs from the response.completed snapshot when output_item.done was missed", async () => {
      const source = sourceFrom([
        { type: "response.created", response: { id: "resp_r", model: "gpt-6-astra" } },
        { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "think" },
        {
          type: "response.completed",
          response: {
            output: [{ id: "rs_1", type: "reasoning", encrypted_content: "ENC1", summary: [] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]);
      const out = frames(
        await collect(responsesSSEToAnthropicSSE(source, "gpt-6-astra", undefined, { reasoningReplayScope: scope })),
      );
      const sigs = out.filter((e) => (e.delta as Record<string, unknown> | undefined)?.type === "signature_delta");
      expect(sigs).toHaveLength(1);
      expect(out.filter((e) => e.type === "content_block_stop")).toHaveLength(1);
      expect(out.indexOf(sigs[0])).toBeLessThan(out.findIndex((e) => e.type === "content_block_stop"));
    });
  });

  it("emits exactly one content_block_stop per block (no double-stop)", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
      { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    const stops = out.match(/event: content_block_stop/g) ?? [];
    expect(stops).toHaveLength(1);
  });

  it("translates a function-call stream with tool_use stop_reason", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_2", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "search" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"q":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"x"}' },
      { type: "response.output_item.done", item: { id: "fc_1", type: "function_call" } },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 8 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"search"');
    expect(out).toContain('"type":"input_json_delta","partial_json":"{\\"q\\":"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });

  it("maps incomplete streams to max_tokens", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_3", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "partial" },
      { type: "response.incomplete", response: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain('"type":"text_delta","text":"partial"');
    expect(out).toContain('"stop_reason":"max_tokens"');
    expect(out).not.toContain('"stop_reason":"end_turn"');
  });

  it("emits an error event for failed streams", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "resp_fail", model: "gpt-5.5" } },
      {
        type: "response.failed",
        response: {
          error: { message: "upstream failed" },
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain("event: error");
    expect(out).toContain('"type":"openai_response_failed"');
    expect(out).toContain('"message":"upstream failed"');
    expect(out).not.toContain('"stop_reason":"end_turn"');
    expect(out).not.toContain("event: message_stop");
  });

  it("surfaces an empty stream (no terminal event) as a retryable error, not a silent success", async () => {
    const out = await collect(responsesSSEToAnthropicSSE(sourceFrom([])));
    expect(out).toContain("event: error");
    expect(out).toContain('"type":"overloaded_error"');
    expect(out).not.toContain("event: message_stop");
    expect(out).not.toContain('"stop_reason":"end_turn"');
  });

  it("surfaces a stream truncated mid-generation as a retryable error", async () => {
    const reasons: string[] = [];
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", model: "grok-4.6" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "partial tex" },
      // No response.completed — the upstream connection died mid-stream.
    ]);
    const out = await collect(
      responsesSSEToAnthropicSSE(source, "grok-4.6", undefined, {
        onAbnormalEnd: (reason) => reasons.push(reason),
      }),
    );
    expect(out).toContain('"type":"text_delta","text":"partial tex"');
    expect(out).toContain("event: content_block_stop");
    expect(out).toContain('"type":"overloaded_error"');
    expect(out).not.toContain("event: message_stop");
    expect(reasons).toEqual(["truncated"]);
  });

  it("keeps the clean finish when a terminal event was seen (no abnormal-end callback)", async () => {
    const reasons: string[] = [];
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(
      responsesSSEToAnthropicSSE(source, "gpt-5.5", undefined, {
        onAbnormalEnd: (reason) => reasons.push(reason),
      }),
    );
    expect(out).toContain("event: message_stop");
    expect(out).not.toContain("event: error");
    expect(reasons).toEqual([]);
  });

  it("translates a top-level error SSE event into an error frame instead of swallowing it", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", model: "grok-4.6" } },
      { type: "error", code: "server_error", message: "The server had an error" },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain("event: error");
    expect(out).toContain('"type":"openai_response_failed"');
    expect(out).toContain('"message":"The server had an error"');
    expect(out).not.toContain("event: message_stop");
  });

  it("propagates a client cancel to the upstream source (stops vendor-side generation)", async () => {
    // The manual pump replaced pipeThrough's automatic cancel plumbing — pin
    // it: a Stop press must close the vendor connection, not leak it.
    const enc = new TextEncoder();
    let cancelReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "grok-4.5" } })}\n\n`,
          ),
        );
        // Held open — the client walks away mid-generation.
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const out = responsesSSEToAnthropicSSE(source, "grok-4.5");
    const reader = out.getReader();
    await reader.read(); // message_start arrives
    await reader.cancel("user pressed stop");
    expect(cancelReason).toBe("user pressed stop");
  });

  it("aborts a stalled stream after the idle timeout with a retryable error", async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    // Emits one event, then holds the connection open forever (the observed
    // xAI grok stall shape).
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "grok-4.5" } })}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const reasons: string[] = [];
    const out = await collect(
      responsesSSEToAnthropicSSE(source, "grok-4.5", undefined, {
        idleTimeoutMs: 25,
        onAbnormalEnd: (reason) => reasons.push(reason),
      }),
    );
    expect(out).toContain("event: message_start");
    expect(out).toContain('"type":"overloaded_error"');
    expect(out).toContain("stalled");
    expect(out).not.toContain("event: message_stop");
    expect(reasons).toEqual(["stalled"]);
    expect(cancelled).toBe(true);
  });

  it("lazily opens a text block when output_text.delta arrives without output_item.added", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", model: "gpt-5.5" } },
      { type: "response.output_text.delta", item_id: "msg_x", delta: "hi" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain('"content_block":{"type":"text"');
    expect(out).toContain('"type":"text_delta","text":"hi"');
    expect((out.match(/event: content_block_stop/g) ?? [])).toHaveLength(1);
  });

  it("assigns distinct indices to two function calls", async () => {
    const source = sourceFrom([
      { type: "response.created", response: { id: "r", model: "gpt-5.5" } },
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "c1", name: "a" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
      { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", call_id: "c2", name: "b" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: "{}" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain('"index":0,"content_block":{"type":"tool_use","id":"c1","name":"a"');
    expect(out).toContain('"index":1,"content_block":{"type":"tool_use","id":"c2","name":"b"');
  });

  it("ignores unknown event types and [DONE] without crashing", async () => {
    const enc = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-5.5" } })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.some_future_event" })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", delta: "x" })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`));
        controller.enqueue(enc.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });
    const out = await collect(responsesSSEToAnthropicSSE(source));
    expect(out).toContain('"type":"text_delta","text":"x"');
    expect(out).toContain("event: message_stop");
  });
});

describe("anthropicRequestToResponses — edge cases", () => {
  it("joins a system block array into instructions and strips telemetry prefix", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      system: [
        { type: "text", text: "x-anthropic-billing-header: cch=abc123\n\nReal prompt." },
      ],
      messages: [],
    });
    expect(out.instructions).toBe("Real prompt.");
  });

  it("drops temperature/top_p (reasoning models reject them on /v1/responses)", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [],
      temperature: 0.7,
      top_p: 0.9,
    });
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
  });

  it("flattens tool_result array content to a function_call_output string", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
          ],
        },
      ],
    });
    expect(out.input).toEqual([
      { type: "function_call_output", call_id: "c1", output: "a\n\nb" },
    ]);
  });

  it("re-surfaces a mid-turn steer reminder from tool_result output as a user input item", () => {
    const reminder =
      "<system-reminder>\nThe user sent a new message while you were working:\nand the docs as well\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>";
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c1", content: `done\n\n${reminder}` },
          ],
        },
      ],
    });
    expect(out.input).toEqual([
      { type: "function_call_output", call_id: "c1", output: "done" },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "The user sent a new message while you were working:\nand the docs as well\n\nAddress the message above as you continue this turn.",
          },
        ],
      },
    ]);
  });

  it("extracts each steer reminder when a tool_result carries more than one", () => {
    const wrap = (msg: string) =>
      `<system-reminder>\nThe user sent a new message while you were working:\n${msg}\n</system-reminder>`;
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: `ok\n${wrap("first follow-up")}\n${wrap("second follow-up")}`,
            },
          ],
        },
      ],
    });
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ type: "function_call_output", call_id: "c1", output: "ok" });
    expect(input).toHaveLength(3);
    expect(JSON.stringify(input[1])).toContain("first follow-up");
    expect(JSON.stringify(input[2])).toContain("second follow-up");
  });

  it("leaves tool_result output untouched when it has an unrelated system-reminder", () => {
    const text =
      "done\n\n<system-reminder>\nThe TODO list has been updated.\n</system-reminder>";
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: text }],
        },
      ],
    });
    expect(out.input).toEqual([
      { type: "function_call_output", call_id: "c1", output: text },
    ]);
  });

  it("passes a system-role message through as a system input item instead of dropping it", () => {
    const out = anthropicRequestToResponses({
      model: "grok-4.6",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "Available agent types for the Agent tool:\n- claude: ..." },
      ],
    });
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        role: "system",
        content: [{ type: "input_text", text: "Available agent types for the Agent tool:\n- claude: ..." }],
      },
    ]);
  });

  it("re-surfaces a system-role mid-turn steer as a user input item", () => {
    // Exact shape Claude Code sends non-Anthropic models: steer + explainer +
    // appended token-budget reminder, all in one system message.
    const steerMessage =
      "The user sent a new message while you were working:\nand also one vegetable\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n\n<total_tokens>14983079 tokens left</total_tokens>";
    const out = anthropicRequestToResponses({
      model: "grok-4.6",
      messages: [
        { role: "user", content: "run the command" },
        { role: "system", content: steerMessage },
      ],
    });
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "run the command" }] },
      {
        role: "system",
        content: [
          { type: "input_text", text: "<total_tokens>14983079 tokens left</total_tokens>" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "The user sent a new message while you were working:\nand also one vegetable\n\nAddress the message above as you continue this turn.",
          },
        ],
      },
    ]);
  });

  it("omits reasoning + tool_choice when neither effort nor a valid forced tool is present", () => {
    const out = anthropicRequestToResponses({ model: "gpt-5.5", messages: [] });
    expect(out.reasoning).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
  });

  it("converts a user base64 image block to input_image (data URL, detail high)", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    });
    expect(out.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
        ],
      },
    ]);
  });

  it("passes a user url image block through as input_image", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
        },
      ],
    });
    expect(out.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_image", image_url: "https://x/y.png", detail: "high" }],
      },
    ]);
  });

  it("surfaces a tool_result image as a follow-up user input_image (not base64 text)", () => {
    const out = anthropicRequestToResponses({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [
                { type: "text", text: "here is the file" },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZZ" } },
              ],
            },
          ],
        },
      ],
    });
    expect(out.input).toEqual([
      { type: "function_call_output", call_id: "c1", output: "here is the file" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "[image output from tool c1]" },
          { type: "input_image", image_url: "data:image/jpeg;base64,ZZZZ", detail: "high" },
        ],
      },
    ]);
    // The base64 must NOT leak into the function_call_output text.
    expect((out.input as Array<{ output?: string }>)[0].output).not.toContain("ZZZZ");
  });

  it("with mapImageSource, omits GIF tool_result image and inserts the reason text", () => {
    const out = anthropicRequestToResponses(
      {
        model: "grok-4.5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "c1",
                content: [
                  { type: "text", text: "here is the gif" },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/gif",
                      data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        mapImageSource: () => ({
          reason: "[image omitted: image/gif not supported by this model]",
          mediaType: "image/gif",
        }),
      },
    );
    expect(out.input).toEqual([
      { type: "function_call_output", call_id: "c1", output: "here is the gif" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "[image output from tool c1]" },
          {
            type: "input_text",
            text: "[image omitted: image/gif not supported by this model]",
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(out.input);
    expect(serialized).not.toContain("input_image");
    expect(serialized).not.toContain("R0lGOD");
  });

  it("with mapImageSource, passes allowed PNG images unchanged", () => {
    const out = anthropicRequestToResponses(
      {
        model: "grok-4.5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" },
              },
            ],
          },
        ],
      },
      { mapImageSource: () => null },
    );
    expect(out.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgo",
            detail: "high",
          },
        ],
      },
    ]);
  });
});

describe("responsesResponseToAnthropic — edge cases", () => {
  it("maps status=incomplete to max_tokens", () => {
    const out = responsesResponseToAnthropic({
      id: "r",
      model: "gpt-5.5",
      status: "incomplete",
      output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
    });
    expect(out.stop_reason).toBe("max_tokens");
  });

  it("extracts reasoning summary array into a thinking block", () => {
    const out = responsesResponseToAnthropic({
      id: "r",
      model: "gpt-5.5",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "because" }] },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    expect(out.content).toEqual([
      { type: "thinking", thinking: "because" },
      { type: "text", text: "answer" },
    ]);
  });

  it("handles empty output with end_turn and zero usage", () => {
    const out = responsesResponseToAnthropic({ id: "r", model: "gpt-5.5", output: [] });
    expect(out.content).toEqual([]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it("falls back to {} for malformed function_call arguments", () => {
    const out = responsesResponseToAnthropic({
      id: "r",
      model: "gpt-5.5",
      output: [{ type: "function_call", call_id: "c1", name: "x", arguments: "not json" }],
    });
    expect(out.content).toEqual([
      { type: "tool_use", id: "c1", name: "x", input: {} },
    ]);
  });
});
