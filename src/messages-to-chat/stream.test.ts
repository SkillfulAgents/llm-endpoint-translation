import { describe, expect, it } from "vitest";

import { assertMessagesStreamGrammar } from "../../test/helpers/grammar.js";
import { parseSse, readText } from "../../test/helpers/sse.js";
import type { MessagesStreamEvent } from "../../test/schemas/messages.js";
import { chatCompletionsStreamToMessagesStream } from "./stream.js";

type Json = Record<string, unknown>;

async function translate(chunks: Json[]): Promise<Json[]> {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  const input = new Response(body).body!;
  const text = await new Response(chatCompletionsStreamToMessagesStream(input, { model: "m" })).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Json);
}

function toolCalls(events: Json[]): Array<{ id: unknown; name: unknown; args: string }> {
  const calls = new Map<unknown, { id: unknown; name: unknown; args: string }>();
  for (const event of events) {
    const block = event.content_block as Json | undefined;
    const delta = event.delta as Json | undefined;
    if (event.type === "content_block_start" && block?.type === "tool_use") {
      calls.set(event.index, { id: block.id, name: block.name, args: "" });
    } else if (event.type === "content_block_delta" && delta?.type === "input_json_delta") {
      calls.get(event.index)!.args += delta.partial_json as string;
    }
  }
  return [...calls.values()];
}

describe("chatCompletionsStreamToMessagesStream", () => {
  it("keeps parallel tool calls without `index` as separate tool_use blocks", async () => {
    const events = await translate([
      { id: "c1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      {
        id: "c1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { id: "a", type: "function", function: { name: "weather", arguments: "" } },
                { id: "b", type: "function", function: { name: "time", arguments: "" } },
              ],
            },
          },
        ],
      },
      {
        id: "c1",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ function: { arguments: '{"city":"SF"}' } }, { function: { arguments: '{"tz":"UTC"}' } }] },
          },
        ],
      },
      { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);

    expect(toolCalls(events)).toEqual([
      { id: "a", name: "weather", args: '{"city":"SF"}' },
      { id: "b", name: "time", args: '{"tz":"UTC"}' },
    ]);
    expect(events.at(-1)).toEqual({ type: "message_stop" });
  });

  it("still streams a single indexless tool call across chunks into one block", async () => {
    const events = await translate([
      { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ id: "a", function: { name: "f", arguments: '{"x"' } }] } }] },
      { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: ":1}" } }] } }] },
      { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);

    expect(toolCalls(events)).toEqual([{ id: "a", name: "f", args: '{"x":1}' }]);
  });

  it("surfaces an upstream error chunk's message instead of a generic truncation error", async () => {
    const events = await translate([
      { id: "c1", choices: [{ index: 0, delta: { content: "partial" } }] },
      { error: { message: "Internal server error", type: "server_error", code: "upstream_failure" } },
    ]);

    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ]);
    expect(events.at(-1)).toEqual({ type: "error", error: { type: "api_error", message: "Internal server error" } });
  });

  it("skips a malformed data line and keeps translating", async () => {
    const body =
      `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "a" } }] })}\n\n` +
      "data: {not json\n\n" +
      `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "b" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`;
    const text = await new Response(chatCompletionsStreamToMessagesStream(new Response(body).body!)).text();

    expect(text).toContain('"text":"a"');
    expect(text).toContain('"text":"b"');
    expect(text).toContain("message_stop");
  });

  it("errors the output stream when the upstream read fails", async () => {
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    await expect(new Response(chatCompletionsStreamToMessagesStream(input)).text()).rejects.toThrow("socket reset");
  });

  it("cancels the upstream when the consumer cancels", async () => {
    let cancelled: unknown;
    const input = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    await chatCompletionsStreamToMessagesStream(input).cancel("client gone");
    expect(cancelled).toBe("client gone");
  });

  it("ends a stalled stream after the idle timeout with a retryable error and cancels the upstream", async () => {
    const reasons: string[] = [];
    let cancelled = false;
    const first = new TextEncoder().encode(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "par" } }] })}\n\n`);
    let sent = false;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(first);
          return;
        }
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const text = await new Response(
      chatCompletionsStreamToMessagesStream(input, { idleTimeoutMs: 25, onAbnormalEnd: (r) => reasons.push(r) }),
    ).text();

    expect(text).toContain('"text":"par"');
    expect(text).toContain('"type":"overloaded_error"');
    expect(text).toContain("stalled");
    expect(text).not.toContain("message_stop");
    expect(reasons).toEqual(["stalled"]);
    expect(cancelled).toBe(true);
  });

  it("closes normally when it stalls after a finish_reason (only the usage chunk is missing)", async () => {
    const reasons: string[] = [];
    const first = new TextEncoder().encode(
      `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\n`,
    );
    let sent = false;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(first);
          return;
        }
        return new Promise(() => {});
      },
    });
    const text = await new Response(
      chatCompletionsStreamToMessagesStream(input, { idleTimeoutMs: 25, onAbnormalEnd: (r) => reasons.push(r) }),
    ).text();

    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain("message_stop");
    expect(text).not.toContain("overloaded_error");
    expect(reasons).toEqual([]);
  });

  it("reports a truncated stream through onAbnormalEnd", async () => {
    const reasons: string[] = [];
    const body = `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "par" } }] })}\n\n`;
    const text = await new Response(
      chatCompletionsStreamToMessagesStream(new Response(body).body!, { onAbnormalEnd: (r) => reasons.push(r) }),
    ).text();

    expect(text).toContain('"type":"overloaded_error"');
    expect(reasons).toEqual(["truncated"]);
  });

  it("keeps an Anthropic-typed upstream error type as-is", async () => {
    const events = await translate([{ error: { message: "slow down", type: "rate_limit_error" } }]);

    expect(events.map((e) => e.type)).toEqual(["message_start", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  });
});

describe("chatCompletionsStreamToMessagesStream — one open block at a time", () => {
  const usage = { prompt_tokens: 1, completion_tokens: 1 };
  const chunk = (delta: Json, extra: Json = {}) => ({ id: "c1", model: "m", choices: [{ index: 0, delta, ...extra }] });
  const sequential = async (chunks: Json[], truncated = false) => {
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (truncated ? "" : "data: [DONE]\n\n");
    const text = await readText(chatCompletionsStreamToMessagesStream(new Response(body).body!));
    return assertMessagesStreamGrammar(parseSse(text));
  };
  const blocks = (events: MessagesStreamEvent[]) => {
    const out: Array<{ type: string; body: string }> = [];
    for (const e of events) {
      if (e.type === "content_block_start") out.push({ type: e.content_block.type, body: "" });
      if (e.type === "content_block_delta") {
        const d = e.delta as { text?: string; thinking?: string; partial_json?: string };
        out[e.index].body += d.text ?? d.thinking ?? d.partial_json ?? "";
      }
    }
    return out;
  };

  it("closes the text block before reasoning that arrives after it", async () => {
    const events = await sequential([
      chunk({ content: "Hi." }),
      chunk({ reasoning_content: "Now think." }),
      chunk({ content: " Done." }, { finish_reason: "stop", usage }),
    ]);
    expect(blocks(events)).toEqual([
      { type: "text", body: "Hi." },
      { type: "thinking", body: "Now think." },
      { type: "text", body: " Done." },
    ]);
  });

  it("emits text that arrives after a tool call as its own block after the tool call", async () => {
    const events = await sequential([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: '{"x":' } }] }),
      chunk({ content: "while calling" }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, { finish_reason: "tool_calls", usage }),
    ]);
    expect(blocks(events)).toEqual([
      { type: "tool_use", body: '{"x":1}' },
      { type: "text", body: "while calling" },
    ]);
  });

  it("keeps interleaved parallel tool-call arguments with their own call", async () => {
    const events = await sequential([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "weather", arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "time", arguments: '{"tz":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"UTC"}' } }] }),
      chunk({ tool_calls: [{ index: 2, id: "c", function: { name: "noop" } }] }, { finish_reason: "tool_calls", usage }),
    ]);
    expect(toolCalls(events)).toEqual([
      { id: "a", name: "weather", args: '{"city":"SF"}' },
      { id: "b", name: "time", args: '{"tz":"UTC"}' },
      { id: "c", name: "noop", args: "" },
    ]);
  });

  it("flushes buffered tool calls before the error on a truncated stream", async () => {
    const events = await sequential(
      [
        chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{}" } }] }),
        chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "g", arguments: '{"p' } }] }),
      ],
      true,
    );
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ]);
  });
});
