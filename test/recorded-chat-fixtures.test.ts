import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatCompletionsResponseToMessages,
  chatCompletionsStreamToMessagesStream,
  extractChatCompletionsUsage,
  responsesErrorToMessagesError,
} from "../src";
import { chatReplies, chatSseText, chatStreams } from "./fixtures/chat-corpus";
import { assertMessagesStreamGrammar } from "./helpers/grammar";
import { encode, parseSse, readText, streamFromBytes, type Json } from "./helpers/sse";
import { messagesResponse } from "./schemas/messages";

const GOLDEN = join(import.meta.dirname, "fixtures/golden/vercel-ai/chat-completions");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

type ToolCallDelta = { index?: number; function?: { arguments?: string } };

function choiceDeltas(chunks: Json[]): Json[] {
  return chunks.flatMap((chunk) => {
    const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Json | undefined) : undefined;
    return choice?.delta ? [choice.delta as Json] : [];
  });
}

describe("recorded Chat Completions stream → Messages stream", () => {
  it.each(chatStreams)("$vendor/$name", async ({ vendor, name, chunks }) => {
    const bytes = encode(chatSseText(chunks));
    const text = await readText(chatCompletionsStreamToMessagesStream(streamFromBytes(bytes, [97, 211, 503])));
    const events = assertMessagesStreamGrammar(parseSse(text));

    const deltas = choiceDeltas(chunks);
    const sourceText = deltas.map((d) => (typeof d.content === "string" ? d.content : "")).join("");
    const outText = events
      .flatMap((e) => (e.type === "content_block_delta" && e.delta.type === "text_delta" ? [e.delta.text] : []))
      .join("");
    expect(outText).toBe(sourceText);

    const sourceReasoning = deltas
      .map((d) => (typeof d.reasoning_content === "string" ? d.reasoning_content : ""))
      .join("");
    const outReasoning = events
      .flatMap((e) =>
        e.type === "content_block_delta" && e.delta.type === "thinking_delta" ? [e.delta.thinking] : [],
      )
      .join("");
    expect(outReasoning).toBe(sourceReasoning);

    // Per call, not concatenated: two parallel calls merged into one block must fail here.
    const sourceCalls = new Map<string, string>();
    let lastId = "";
    for (const d of deltas) {
      for (const [position, call] of ((d.tool_calls ?? []) as ToolCallDelta[]).entries()) {
        const key = call.index ?? position;
        const id = (call as Json).id;
        if (typeof id === "string" && id) lastId = `${key}:${id}`;
        const slot = typeof id === "string" && id ? `${key}:${id}` : [...sourceCalls.keys()].find((k) => k.startsWith(`${key}:`)) ?? lastId;
        sourceCalls.set(slot, (sourceCalls.get(slot) ?? "") + (call.function?.arguments ?? ""));
      }
    }
    const outCalls = new Map<number, { id: string; args: string }>();
    for (const e of events) {
      if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
        outCalls.set(e.index, { id: e.content_block.id, args: "" });
      } else if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") {
        outCalls.get(e.index)!.args += e.delta.partial_json;
      }
    }
    expect([...outCalls.values()].map((c) => [c.id, c.args])).toEqual(
      [...sourceCalls.entries()].map(([slot, args]) => [slot.slice(slot.indexOf(":") + 1), args]),
    );

    const finished = chunks.some((chunk) =>
      Array.isArray(chunk.choices) && chunk.choices.some((c) => (c as Json).finish_reason != null),
    );
    const last = events[events.length - 1];
    expect(last.type).toBe(finished ? "message_stop" : "error");
    const upstreamError = chunks.find((chunk) => chunk.error)?.error as Json | undefined;
    if (upstreamError && last.type === "error") expect(last.error.message).toBe(upstreamError.message);

    await expect(text).toMatchFileSnapshot(join(GOLDEN, vendor, `${name}.messages.sse`));
  });
});

describe("recorded Chat Completions JSON → Messages JSON", () => {
  const replies = chatReplies.filter(({ body }) => !("error" in body));
  it.each(replies)("$vendor/$name", async ({ vendor, name, body }) => {
    const out = chatCompletionsResponseToMessages(body);
    messagesResponse.parse(out);

    const message = ((body.choices as Json[])[0].message ?? {}) as Json;
    const content = out.content as Json[];
    expect(content.filter((b) => b.type === "text").map((b) => b.text).join("")).toBe(
      typeof message.content === "string" ? message.content : "",
    );
    expect(content.filter((b) => b.type === "tool_use").map((b) => b.id)).toEqual(
      ((message.tool_calls ?? []) as Json[]).map((call) => call.id),
    );
    expect(out.usage).toEqual(extractChatCompletionsUsage(body.usage));

    await expect(JSON.stringify(out, null, 2) + "\n").toMatchFileSnapshot(
      join(GOLDEN, vendor, `${name}.messages.json`),
    );
  });
});

describe("recorded Chat Completions error → Messages error", () => {
  const errors = chatReplies.filter(({ body }) => "error" in body);
  it.each(errors)("$vendor/$name", ({ body }) => {
    const out = responsesErrorToMessagesError(body, 400);
    expect(out).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: (body.error as Json).message },
    });
  });
});
