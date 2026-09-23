import { describe, expect, it } from "vitest";

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

  it("keeps an Anthropic-typed upstream error type as-is", async () => {
    const events = await translate([{ error: { message: "slow down", type: "rate_limit_error" } }]);

    expect(events.map((e) => e.type)).toEqual(["message_start", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  });
});
