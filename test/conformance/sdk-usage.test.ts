import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import {
  chatCompletionsResponseToMessages,
  chatCompletionsStreamToMessagesStream,
  messagesErrorToResponsesError,
  messagesRequestToChatCompletions,
  messagesRequestToResponses,
  messagesResponseToResponses,
  messagesStreamToResponsesStream,
  responsesErrorToMessagesError,
  responsesRequestToMessages,
  responsesResponseToMessages,
  responsesStreamToMessagesStream,
  shortenToolName,
  toolNameRestoreMap,
  TranslationError,
} from "../../src";
import { toSseText, type Json } from "../helpers/sse";

// Each test wires a real SDK client to a minimal host proxy built from the public API.
type Upstream = (body: Json) => Response;

const sseHeaders = { "content-type": "text/event-stream" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (payloads: Json[]) => new Response(toSseText(payloads), { headers: sseHeaders });
const chatSse = (chunks: Json[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: sseHeaders,
  });
const readBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as Json;

function messagesToResponsesProxy(upstream: Upstream): typeof fetch {
  return async (_url, init) => {
    const request = readBody(init);
    const toolNames = toolNameRestoreMap(request);
    const reply = upstream(messagesRequestToResponses(request).body);
    if (!reply.ok) return json(responsesErrorToMessagesError(await reply.json(), reply.status), reply.status);
    if (request.stream === true) {
      return new Response(responsesStreamToMessagesStream(reply.body!, { toolNames }), { headers: sseHeaders });
    }
    return json(responsesResponseToMessages(await reply.json(), { toolNames }));
  };
}

function messagesToChatProxy(upstream: Upstream): typeof fetch {
  return async (_url, init) => {
    const request = readBody(init);
    const toolNames = toolNameRestoreMap(request);
    const reply = upstream(messagesRequestToChatCompletions(request));
    if (!reply.ok) return json(responsesErrorToMessagesError(await reply.json(), reply.status), reply.status);
    if (request.stream === true) {
      return new Response(chatCompletionsStreamToMessagesStream(reply.body!, { toolNames }), { headers: sseHeaders });
    }
    return json(chatCompletionsResponseToMessages(await reply.json(), { toolNames }));
  };
}

function responsesToMessagesProxy(upstream: Upstream): typeof fetch {
  return async (_url, init) => {
    const request = readBody(init);
    let translated: Json;
    try {
      translated = responsesRequestToMessages(request);
    } catch (err) {
      if (!(err instanceof TranslationError)) throw err;
      return json({ error: { message: err.message, type: err.code, code: null, param: null } }, 400);
    }
    const reply = upstream(translated);
    if (!reply.ok) return json(messagesErrorToResponsesError(await reply.json()), reply.status);
    if (request.stream === true) {
      return new Response(messagesStreamToResponsesStream(reply.body!), { headers: sseHeaders });
    }
    return json(messagesResponseToResponses(await reply.json()));
  };
}

const anthropic = (proxy: typeof fetch) =>
  new Anthropic({ apiKey: "test", baseURL: "http://proxy.test", fetch: proxy, maxRetries: 0 });
const openai = (proxy: typeof fetch) =>
  new OpenAI({ apiKey: "test", baseURL: "http://proxy.test/v1", fetch: proxy, maxRetries: 0 });

const usage = { input_tokens: 12, output_tokens: 4 };

describe("Anthropic SDK → Responses upstream", () => {
  it("messages.create: sends a Responses request and reads back text and usage", async () => {
    const seen: Json[] = [];
    const client = anthropic(
      messagesToResponsesProxy((body) => {
        seen.push(body);
        return json({
          id: "resp_1",
          model: "gpt-5.5",
          status: "completed",
          output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "Paris." }] }],
          usage,
        });
      }),
    );

    const message = await client.messages.create({
      model: "gpt-5.5",
      max_tokens: 256,
      system: "Answer in one word.",
      messages: [{ role: "user", content: "Capital of France?" }],
    });

    expect(seen[0]).toMatchObject({
      model: "gpt-5.5",
      instructions: "Answer in one word.",
      max_output_tokens: 256,
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "Capital of France?" }] }],
    });
    expect(message.content).toEqual([{ type: "text", text: "Paris." }]);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage).toMatchObject({ input_tokens: 12, output_tokens: 4 });
  });

  it("tool loop: a long MCP tool name is shortened upstream and restored for the client", async () => {
    const longName = "mcp__company_internal_knowledge_base__search_documents_by_semantic_similarity";
    const shortName = shortenToolName(longName);
    const tools = [{ name: longName, input_schema: { type: "object" as const, properties: { q: { type: "string" } } } }];
    const seen: Json[] = [];
    const client = anthropic(
      messagesToResponsesProxy((body) => {
        seen.push(body);
        if (seen.length === 1) {
          return json({
            id: "resp_1",
            status: "completed",
            output: [{ type: "function_call", call_id: "call_1", name: shortName, arguments: '{"q":"refunds"}' }],
            usage,
          });
        }
        return json({
          id: "resp_2",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Refunds take 5 days." }] }],
          usage,
        });
      }),
    );

    const first = await client.messages.create({
      model: "gpt-5.5",
      max_tokens: 256,
      tools,
      messages: [{ role: "user", content: "How long do refunds take?" }],
    });
    expect(first.stop_reason).toBe("tool_use");
    const call = first.content.find((b) => b.type === "tool_use");
    expect(call).toMatchObject({ id: "call_1", name: longName, input: { q: "refunds" } });

    const second = await client.messages.create({
      model: "gpt-5.5",
      max_tokens: 256,
      tools,
      messages: [
        { role: "user", content: "How long do refunds take?" },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "5 business days" }] },
      ],
    });

    expect(seen[0].tools).toEqual([expect.objectContaining({ type: "function", name: shortName })]);
    expect(seen[1].input).toEqual(
      expect.arrayContaining([
        { type: "function_call", call_id: "call_1", name: shortName, arguments: '{"q":"refunds"}' },
        { type: "function_call_output", call_id: "call_1", output: "5 business days" },
      ]),
    );
    expect(second.content).toEqual([{ type: "text", text: "Refunds take 5 days." }]);
  });

  it("messages.stream: text and thinking callbacks fire and finalMessage is complete", async () => {
    const client = anthropic(
      messagesToResponsesProxy(() =>
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
          { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
          { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Recall geography." },
          { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
          { type: "response.output_item.added", output_index: 1, item: { id: "msg_1", type: "message" } },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "Par" },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "is." },
          { type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message" } },
          { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage } },
        ]),
      ),
    );

    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const stream = client.messages
      .stream({
        model: "gpt-5.5",
        max_tokens: 256,
        thinking: { type: "enabled", budget_tokens: 4096 },
        messages: [{ role: "user", content: "Capital of France?" }],
      })
      .on("text", (delta) => textDeltas.push(delta))
      .on("thinking", (delta) => thinkingDeltas.push(delta));
    const final = await stream.finalMessage();

    expect(textDeltas).toEqual(["Par", "is."]);
    expect(thinkingDeltas).toEqual(["Recall geography."]);
    expect(final.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(final.stop_reason).toBe("end_turn");
  });

  it("upstream 429 surfaces as Anthropic.RateLimitError with the upstream message", async () => {
    const client = anthropic(
      messagesToResponsesProxy(() =>
        json({ error: { message: "Rate limit reached for gpt-5.5", type: "requests", code: "rate_limit_exceeded" } }, 429),
      ),
    );
    const error = await client.messages
      .create({ model: "gpt-5.5", max_tokens: 1, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.RateLimitError);
    expect((error as Error).message).toContain("Rate limit reached for gpt-5.5");
  });
});

describe("Anthropic SDK → Chat Completions upstream", () => {
  it("messages.create: a PDF and a thinking budget reach the upstream as a file part and reasoning_effort", async () => {
    const seen: Json[] = [];
    const client = anthropic(
      messagesToChatProxy((body) => {
        seen.push(body);
        return json({
          id: "chatcmpl_1",
          model: "glm-5",
          choices: [{ index: 0, message: { role: "assistant", content: "It is an invoice." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 5 },
        });
      }),
    );

    const message = await client.messages.create({
      model: "glm-5",
      max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [
        {
          role: "user",
          content: [
            { type: "document", title: "invoice.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" } },
            { type: "text", text: "What is this?" },
          ],
        },
      ],
    });

    expect(seen[0].reasoning_effort).toBe("medium");
    expect(seen[0].messages).toEqual([
      {
        role: "user",
        content: [
          { type: "file", file: { filename: "invoice.pdf", file_data: "data:application/pdf;base64,JVBERi0x" } },
          { type: "text", text: "What is this?" },
        ],
      },
    ]);
    expect(message.content).toEqual([{ type: "text", text: "It is an invoice." }]);
    expect(message.usage).toMatchObject({ input_tokens: 40, output_tokens: 5 });
  });

  it("messages.stream: streamed tool arguments arrive through inputJson and parse in finalMessage", async () => {
    const chunk = (delta: Json, extra: Json = {}) => ({ id: "c1", model: "glm-5", choices: [{ index: 0, delta, ...extra }] });
    const client = anthropic(
      messagesToChatProxy((body) => {
        expect(body.stream_options).toEqual({ include_usage: true });
        return chatSse([
          chunk({ role: "assistant", content: "Checking." }),
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }),
          chunk({}, { finish_reason: "tool_calls" }),
          { id: "c1", model: "glm-5", choices: [], usage: { prompt_tokens: 9, completion_tokens: 7 } },
        ]);
      }),
    );

    const partials: string[] = [];
    const final = await client.messages
      .stream({
        model: "glm-5",
        max_tokens: 256,
        tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
        messages: [{ role: "user", content: "Weather in Oslo?" }],
      })
      .on("inputJson", (partial) => partials.push(partial))
      .finalMessage();

    expect(partials.join("")).toBe('{"city":"Oslo"}');
    expect(final.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Oslo" } },
    ]);
    expect(final.stop_reason).toBe("tool_use");
    expect(final.usage).toMatchObject({ input_tokens: 9, output_tokens: 7 });
  });

  it("refusal: stop_reason refusal reaches the SDK caller", async () => {
    const client = anthropic(
      messagesToChatProxy(() =>
        json({
          id: "c1",
          choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I can't help with that." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 6 },
        }),
      ),
    );
    const message = await client.messages.create({ model: "gpt-4o", max_tokens: 64, messages: [{ role: "user", content: "x" }] });
    expect(message.stop_reason).toBe("refusal");
    expect(message.content).toEqual([{ type: "text", text: "I can't help with that." }]);
  });
});

describe("OpenAI SDK → Messages upstream", () => {
  it("responses.create: sends a Messages request and reads back output_text", async () => {
    const seen: Json[] = [];
    const client = openai(
      responsesToMessagesProxy((body) => {
        seen.push(body);
        return json({
          id: "msg_01",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Paris." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        });
      }),
    );

    const response = await client.responses.create({
      model: "claude-sonnet-4-5",
      instructions: "Answer in one word.",
      input: "Capital of France?",
      max_output_tokens: 100,
    });

    expect(seen[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      system: "Answer in one word.",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "Capital of France?" }] }],
    });
    expect(response.status).toBe("completed");
    expect(response.output_text).toBe("Paris.");
    expect(response.usage).toMatchObject({ input_tokens: 12, output_tokens: 4 });
  });

  it("responses.stream: text deltas arrive as events and finalResponse has the full text", async () => {
    const client = openai(
      responsesToMessagesProxy(() =>
        sse([
          {
            type: "message_start",
            message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Par" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "is." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
          { type: "message_stop" },
        ]),
      ),
    );

    const deltas: string[] = [];
    const stream = client.responses.stream({ model: "claude-sonnet-4-5", input: "Capital of France?" });
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") deltas.push(event.delta);
    }
    const final = await stream.finalResponse();

    expect(deltas).toEqual(["Par", "is."]);
    expect(final.output_text).toBe("Paris.");
  });

  it("an unsupported stateful field becomes OpenAI.BadRequestError without calling the upstream", async () => {
    let called = false;
    const client = openai(
      responsesToMessagesProxy(() => {
        called = true;
        return json({});
      }),
    );
    const error = await client.responses
      .create({ model: "claude-sonnet-4-5", input: "x", previous_response_id: "resp_old" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as Error).message).toContain("previous_response_id");
    expect(called).toBe(false);
  });
});
