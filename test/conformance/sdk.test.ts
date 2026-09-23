import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatCompletionsStreamToMessagesStream,
  messagesErrorToResponsesError,
  messagesStreamToResponsesStream,
  responsesErrorToMessagesError,
  responsesResponseToMessages,
  responsesStreamToMessagesStream,
} from "../../src";
import { mapFinishReason } from "../../src/messages-to-chat/response";
import { chatSseText, chatStreams } from "../fixtures/chat-corpus";
import { messagesStreams } from "../fixtures/messages-corpus";
import { recordedResponsesTurns } from "../fixtures/responses-corpus";
import { encode, readSse, streamFromBytes, streamFromPayloads, type Json } from "../helpers/sse";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

type Reply = { body: BodyInit; status?: number; contentType: string };

// SDK clients whose only transport is the translated body we hand them.
function fetchReturning(reply: () => Reply): typeof fetch {
  return async () => {
    const { body, status, contentType } = reply();
    return new Response(body, { status: status ?? 200, headers: { "content-type": contentType } });
  };
}

function anthropicClient(reply: () => Reply): Anthropic {
  return new Anthropic({ apiKey: "test", baseURL: "http://sdk.test", fetch: fetchReturning(reply), maxRetries: 0 });
}

function openaiClient(reply: () => Reply): OpenAI {
  return new OpenAI({ apiKey: "test", baseURL: "http://sdk.test/v1", fetch: fetchReturning(reply), maxRetries: 0 });
}

const sse = "text/event-stream";

describe("@anthropic-ai/sdk MessageStream consumes translated Responses streams", () => {
  it.each(recordedResponsesTurns)("$vendor/$name", async ({ source }) => {
    const client = anthropicClient(() => ({
      body: responsesStreamToMessagesStream(streamFromPayloads(source, 53)),
      contentType: sse,
    }));
    const stream = client.messages.stream({ model: "m", max_tokens: 1024, messages: [{ role: "user", content: "x" }] });
    const completed = source.find((e) => e.type === "response.completed");

    if (!completed) {
      await expect(stream.finalMessage()).rejects.toThrow();
      return;
    }
    const final = await stream.finalMessage();
    const fromJson = responsesResponseToMessages(completed.response as Json);
    expect(final.content).toEqual(fromJson.content);
    expect(final.stop_reason).toBe(fromJson.stop_reason);
    expect(final.usage).toMatchObject(fromJson.usage as Json);
  });

  it("accepts a refusal stream and matches the JSON translation", async () => {
    const response = {
      id: "r",
      status: "completed",
      output: [{ id: "msg", type: "message", content: [{ type: "refusal", refusal: "I can't help." }] }],
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    const source = [
      { type: "response.created", response: { id: "r", model: "m" } },
      { type: "response.output_item.added", item: { id: "msg", type: "message" } },
      { type: "response.refusal.delta", item_id: "msg", delta: "I can't help." },
      { type: "response.output_item.done", item: response.output[0] },
      { type: "response.completed", response },
    ];
    const client = anthropicClient(() => ({
      body: responsesStreamToMessagesStream(streamFromPayloads(source, 53)),
      contentType: sse,
    }));
    const final = await client.messages
      .stream({ model: "m", max_tokens: 1024, messages: [{ role: "user", content: "x" }] })
      .finalMessage();
    const fromJson = responsesResponseToMessages(response);
    expect(final.stop_reason).toBe("refusal");
    expect(final.content).toEqual(fromJson.content);
    expect(fromJson.stop_reason).toBe("refusal");
  });
});

describe("@anthropic-ai/sdk MessageStream consumes translated Chat Completions streams", () => {
  it.each(chatStreams)("$vendor/$name", async ({ chunks }) => {
    const client = anthropicClient(() => ({
      body: chatCompletionsStreamToMessagesStream(streamFromBytes(encode(chatSseText(chunks)), [53])),
      contentType: sse,
    }));
    const stream = client.messages.stream({ model: "m", max_tokens: 1024, messages: [{ role: "user", content: "x" }] });
    const choices = chunks.flatMap((chunk) => (Array.isArray(chunk.choices) ? (chunk.choices as Json[]) : []));
    const finish = choices.find((choice) => choice.finish_reason != null)?.finish_reason;

    if (finish == null) {
      await expect(stream.finalMessage()).rejects.toThrow();
      return;
    }
    const final = await stream.finalMessage();
    const deltas = choices.map((choice) => (choice.delta ?? {}) as Json);
    const text = final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    expect(text).toBe(deltas.map((d) => (typeof d.content === "string" ? d.content : "")).join(""));
    const toolIds = deltas.flatMap((d) => ((d.tool_calls ?? []) as Json[]).flatMap((c) => (c.id ? [c.id] : [])));
    expect(final.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))).toEqual(toolIds);
    expect(final.stop_reason).toBe(mapFinishReason(finish, toolIds.length > 0));
  });
});

describe("openai SDK ResponseStream consumes translated Messages streams", () => {
  it.each(messagesStreams)("$name", async ({ events }) => {
    const translated = await readSse(messagesStreamToResponsesStream(streamFromPayloads(events, 53)));
    const terminal = translated[translated.length - 1].data;
    const client = openaiClient(() => ({
      body: messagesStreamToResponsesStream(streamFromPayloads(events, 53)),
      contentType: sse,
    }));
    const stream = client.responses.stream({ model: "m", input: "x" });

    const seen: string[] = [];
    for await (const event of stream) seen.push(event.type);
    expect(seen).toEqual(translated.map((frame) => frame.data.type));

    const final = await stream.finalResponse();
    const terminalResponse = terminal.response as Json;
    expect(final.status).toBe(terminalResponse.status);
    // finalResponse() adds SDK parse helpers (`parsed`, `parsed_arguments`) on top of the wire shape.
    expect(final.output).toMatchObject(terminalResponse.output as Json[]);
    if (terminal.type === "response.failed") {
      expect(final.error).toEqual(terminalResponse.error);
      return;
    }
    expect(final.output_text).toBe(
      events
        .filter((e) => e.type === "content_block_delta" && (e.delta as Json).type === "text_delta")
        .map((e) => (e.delta as Json).text)
        .join(""),
    );
  });
});

describe("SDK error classes from translated error bodies", () => {
  it.each([
    [400, Anthropic.BadRequestError],
    [401, Anthropic.AuthenticationError],
    [403, Anthropic.PermissionDeniedError],
    [404, Anthropic.NotFoundError],
    [429, Anthropic.RateLimitError],
    [500, Anthropic.InternalServerError],
  ] as const)("@anthropic-ai/sdk raises the right class for an upstream OpenAI %i", async (status, ErrorClass) => {
    const body = responsesErrorToMessagesError({ error: { message: "boom", type: "whatever", code: null } }, status);
    const client = anthropicClient(() => ({ body: JSON.stringify(body), status, contentType: "application/json" }));
    const error = await client.messages
      .create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect((error as InstanceType<typeof Anthropic.APIError>).error).toEqual(body);
    expect((error as Error).message).toContain("boom");
  });

  it.each([
    [400, "invalid_request_error", OpenAI.BadRequestError],
    [429, "rate_limit_error", OpenAI.RateLimitError],
    [529, "overloaded_error", OpenAI.InternalServerError],
  ] as const)("openai SDK raises the right class for an upstream Anthropic %i", async (status, type, ErrorClass) => {
    const body = messagesErrorToResponsesError({ type: "error", error: { type, message: "boom" } });
    const client = openaiClient(() => ({ body: JSON.stringify(body), status, contentType: "application/json" }));
    const error = await client.responses.create({ model: "m", input: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect((error as InstanceType<typeof OpenAI.APIError>).type).toBe(type);
    expect((error as Error).message).toContain("boom");
  });
});
