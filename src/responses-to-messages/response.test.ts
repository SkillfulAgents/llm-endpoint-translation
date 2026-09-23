import { describe, expect, it } from "vitest";

import { messagesErrorToResponsesError, messagesResponseToResponses } from "./response.js";
import { messagesStreamToResponsesStream } from "./stream.js";

type Json = Record<string, unknown>;

function sse(events: Json[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  // Odd-sized chunks so frames split across reads.
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
}

async function readEvents(stream: ReadableStream<Uint8Array>): Promise<Json[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      const data = JSON.parse(dataLine.slice("data: ".length)) as Json;
      expect(eventLine).toBe(`event: ${String(data.type)}`);
      return data;
    });
}

const usage = { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 7 };

describe("messagesResponseToResponses", () => {
  it("maps text, tool calls, thinking, and usage", () => {
    const out = messagesResponseToResponses({
      id: "msg_abc",
      type: "message",
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "plan", signature: "sig" },
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
        { type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } },
      ],
      stop_reason: "tool_use",
      usage,
    });
    expect(out).toMatchObject({
      id: "resp_abc",
      object: "response",
      status: "completed",
      model: "claude-opus-5",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "th:sig" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello world" }] },
        { type: "function_call", call_id: "toolu_1", name: "f", arguments: '{"a":1}', status: "completed" },
      ],
      usage: {
        input_tokens: 16,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 1 },
        output_tokens: 7,
        total_tokens: 23,
      },
    });
  });

  it("reports max_tokens as incomplete", () => {
    const out = messagesResponseToResponses({ id: "msg_1", content: [], stop_reason: "max_tokens", usage });
    expect(out.status).toBe("incomplete");
    expect(out.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("surfaces a refusal as a message item with a refusal part carrying the explanation", () => {
    const out = messagesResponseToResponses({
      id: "msg_r",
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Blocked by policy." },
      usage,
    });
    expect(out.status).toBe("completed");
    expect(out.output).toEqual([
      {
        type: "message",
        id: "msg_0",
        status: "completed",
        role: "assistant",
        content: [{ type: "refusal", refusal: "Blocked by policy." }],
      },
    ]);
  });

  it("uses a default refusal text when stop_details is null", () => {
    const out = messagesResponseToResponses({ content: [], stop_reason: "refusal", stop_details: null, usage });
    expect(out.output).toEqual([
      expect.objectContaining({
        content: [{ type: "refusal", refusal: "The model declined to respond to this request." }],
      }),
    ]);
  });

  it("keeps partial text emitted before a refusal and appends the refusal after it", () => {
    const out = messagesResponseToResponses({
      content: [{ type: "text", text: "Sure, here" }],
      stop_reason: "refusal",
      usage,
    });
    expect((out.output as Json[]).map((item) => (item.content as Json[])[0].type)).toEqual([
      "output_text",
      "refusal",
    ]);
  });

  it("echoes the served fast tier as priority", () => {
    expect(messagesResponseToResponses({ content: [], usage: { ...usage, speed: "fast" } }).service_tier).toBe("priority");
  });
});

describe("messagesErrorToResponsesError", () => {
  it("maps the Anthropic error envelope to the OpenAI one", () => {
    expect(messagesErrorToResponsesError({ type: "error", error: { type: "unsupported_model", message: "nope" } })).toEqual({
      error: { message: "nope", type: "unsupported_model", code: "unsupported_model", param: null },
    });
  });
});

describe("messagesStreamToResponsesStream", () => {
  const textAndToolStream = [
    { type: "message_start", message: { id: "msg_s", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "f", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ];

  it("emits the Responses event sequence with a completed response", async () => {
    const events = await readEvents(messagesStreamToResponsesStream(sse(textAndToolStream), { model: "claude-opus-5" }));
    expect(events.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    const completed = events[events.length - 1].response as Json;
    expect(completed).toMatchObject({
      id: "resp_s",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Hi!" }] },
        { type: "function_call", call_id: "toolu_1", name: "f", arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 10, output_tokens: 9, total_tokens: 19 },
    });
  });

  it("streams thinking as a reasoning item carrying the signature", async () => {
    const events = await readEvents(
      messagesStreamToResponsesStream(
        sse([
          { type: "message_start", message: { id: "msg_t", model: "m", usage: { input_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ]),
        { model: "m" },
      ),
    );
    const done = events.find((e) => e.type === "response.output_item.done")!;
    expect(done.item).toEqual({
      type: "reasoning",
      id: "rs_0",
      summary: [{ type: "summary_text", text: "hmm" }],
      encrypted_content: "th:SIG",
    });
  });

  it("maps an upstream error event to response.failed", async () => {
    const events = await readEvents(
      messagesStreamToResponsesStream(
        sse([
          { type: "message_start", message: { id: "msg_e", model: "m" } },
          { type: "error", error: { type: "overloaded_error", message: "busy" } },
        ]),
        { model: "m" },
      ),
    );
    const last = events[events.length - 1];
    expect(last.type).toBe("response.failed");
    expect((last.response as Json).error).toEqual({ code: "server_error", message: "busy" });
  });

  it("maps an Anthropic rate_limit_error to the Responses rate_limit_exceeded code", async () => {
    const events = await readEvents(
      messagesStreamToResponsesStream(
        sse([
          { type: "message_start", message: { id: "msg_r", model: "m" } },
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        ]),
      ),
    );
    expect((events[events.length - 1].response as Json).error).toEqual({
      code: "rate_limit_exceeded",
      message: "slow down",
    });
  });

  it("puts items still open at failure into response.failed as partial items, not placeholders", async () => {
    const events = await readEvents(
      messagesStreamToResponsesStream(
        sse([
          { type: "message_start", message: { id: "msg_p", model: "m" } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "f", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a"' } },
        ]),
      ),
    );
    const failed = events[events.length - 1];
    expect(failed.type).toBe("response.failed");
    expect((failed.response as Json).output).toEqual([
      {
        type: "message",
        id: "msg_0",
        status: "incomplete",
        role: "assistant",
        content: [{ type: "output_text", text: "half", annotations: [], logprobs: [] }],
      },
      { type: "function_call", id: "fc_1", call_id: "t1", name: "f", arguments: '{"a"', status: "incomplete" },
    ]);
  });

  it("echoes the streamed web search query as the web_search_call action", async () => {
    const events = await readEvents(
      messagesStreamToResponsesStream(
        sse([
          { type: "message_start", message: { id: "msg_w", model: "m" } },
          { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"weather' } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ' paris"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
        ]),
      ),
    );
    const added = events.find((e) => e.type === "response.output_item.added");
    const done = events.find((e) => e.type === "response.output_item.done");
    expect(added?.item).toEqual({ type: "web_search_call", id: "srvtoolu_1", status: "in_progress", action: { type: "search" } });
    expect(done?.item).toEqual({
      type: "web_search_call",
      id: "srvtoolu_1",
      status: "completed",
      action: { type: "search", query: "weather paris", queries: ["weather paris"] },
    });
  });

  it("omits usage while in progress and includes it on the terminal response", async () => {
    const events = await readEvents(
      messagesStreamToResponsesStream(
        sse([
          { type: "message_start", message: { id: "msg_u", model: "m", usage: { input_tokens: 2 } } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]),
      ),
    );
    expect(events[0].response).not.toHaveProperty("usage");
    expect((events[events.length - 1].response as Json).usage).toMatchObject({ input_tokens: 2, output_tokens: 1 });
  });

  it("streams a refusal as the OpenAI refusal event sequence before response.completed", async () => {
    const events = await readEvents(
      messagesStreamToResponsesStream(
        sse([
          { type: "message_start", message: { id: "msg_x", model: "m", usage: { input_tokens: 4 } } },
          {
            type: "message_delta",
            delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation: "No." } },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]),
        { model: "m" },
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.refusal.delta",
      "response.refusal.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = events[events.length - 1].response as Json;
    expect(completed.status).toBe("completed");
    expect(completed.output).toEqual([
      { type: "message", id: "msg_0", status: "completed", role: "assistant", content: [{ type: "refusal", refusal: "No." }] },
    ]);
  });

  it("fails a stream that ends without message_stop", async () => {
    const events = await readEvents(messagesStreamToResponsesStream(sse(textAndToolStream.slice(0, 4)), { model: "m" }));
    expect(events[events.length - 1].type).toBe("response.failed");
  });

  it("propagates a client cancel to the source stream", async () => {
    let cancelReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_c", model: "m", usage: { input_tokens: 3 } } })}\n\n`,
          ),
        );
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const reader = messagesStreamToResponsesStream(source, { model: "m" }).getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(cancelReason).toBe("client gone");
  });
});
