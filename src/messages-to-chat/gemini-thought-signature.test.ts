import { describe, expect, it } from "vitest";

import { messagesRequestToChatCompletions } from "./request.js";
import { chatCompletionsResponseToMessages, extractChatCompletionsUsage } from "./response.js";
import { chatCompletionsStreamToMessagesStream } from "./stream.js";

type Json = Record<string, unknown>;

const SCOPE = "gemini/gemini-4-argon";
const SIGNATURE = "ElkKVwFpFH0T63hqQjENvMbJAdxTWx/iefX6YM4D1bRnwihB3XMhnVxVE6sDF2i0GYu3uHziRCPH2L/rldbjlJogzWzl86WxBJ8rXLm+F30ekF6qqvTtWdSHRw==";
const TOOLS = [
  {
    name: "get_weather",
    description: "Get weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
];
const USER_TURN = { role: "user", content: "What's the weather in Paris? Use the tool." };

// Recorded from gemini-4-argon on the OpenAI-compatible endpoint, 2026-10-14.
const toolCall = {
  extra_content: { google: { thought_signature: SIGNATURE } },
  function: { arguments: '{"city":"Paris"}', name: "get_weather" },
  id: "call_742961",
  type: "function",
};
const reply = {
  choices: [{ finish_reason: "tool_calls", index: 0, message: { role: "assistant", tool_calls: [toolCall] } }],
  id: "as7Pau6TKsv0jrEP7MUr",
  model: "gemini-4-argon",
  object: "chat.completion",
  usage: { completion_tokens: 22, prompt_tokens: 94, total_tokens: 116 },
};
const streamChunks = [
  {
    choices: [{ delta: { role: "assistant", tool_calls: [toolCall] }, index: 0 }],
    id: "bc7PauKZH8zQjMcPxNPlyQM",
    model: "gemini-4-argon",
    object: "chat.completion.chunk",
  },
  {
    choices: [{ delta: { role: "assistant" }, finish_reason: "stop", index: 0 }],
    id: "bc7PauKZH8zQjMcPxNPlyQM",
    model: "gemini-4-argon",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 22, prompt_tokens: 94, total_tokens: 116 },
  },
];

function nextRequest(assistantContent: unknown[], scope = SCOPE): Json {
  return messagesRequestToChatCompletions(
    {
      model: "gemini-4-argon",
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        USER_TURN,
        { role: "assistant", content: assistantContent },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_742961", content: "18C and sunny" }] },
      ],
    },
    { reasoningReplayScope: scope },
  );
}

function replayedToolCall(request: Json): Json {
  const assistant = (request.messages as Json[]).find((m) => m.role === "assistant")!;
  return (assistant.tool_calls as Json[])[0];
}

// Rebuild the assistant content blocks the way an Anthropic client does from the SSE events.
async function streamToContent(chunks: Json[]): Promise<Json[]> {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const text = await new Response(
    chatCompletionsStreamToMessagesStream(new Response(body).body!, {
      model: "gemini-4-argon",
      reasoningReplayScope: SCOPE,
    }),
  ).text();
  const blocks: Json[] = [];
  const args: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6)) as Json;
    const delta = event.delta as Json | undefined;
    if (event.type === "content_block_start") {
      blocks[event.index as number] = { ...(event.content_block as Json) };
      args[event.index as number] = "";
    } else if (event.type === "content_block_delta" && delta?.type === "signature_delta") {
      blocks[event.index as number].signature = delta.signature;
    } else if (event.type === "content_block_delta" && delta?.type === "input_json_delta") {
      args[event.index as number] += delta.partial_json as string;
    }
  }
  return blocks.map((b, i) => (b.type === "tool_use" ? { ...b, input: JSON.parse(args[i] || "{}") } : b));
}

describe("Gemini thought signatures on the chat wire", () => {
  it("round-trips a non-streamed tool call's signature back onto the replayed call", () => {
    const message = chatCompletionsResponseToMessages(reply, {
      model: "gemini-4-argon",
      reasoningReplayScope: SCOPE,
    });
    const content = message.content as Json[];
    expect(content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);

    expect(replayedToolCall(nextRequest(content)).extra_content).toEqual({
      google: { thought_signature: SIGNATURE },
    });
  });

  it("round-trips a streamed tool call's signature back onto the replayed call", async () => {
    const content = await streamToContent(streamChunks);
    expect(content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(content[1]).toMatchObject({ id: "call_742961", input: { city: "Paris" } });

    expect(replayedToolCall(nextRequest(content)).extra_content).toEqual({
      google: { thought_signature: SIGNATURE },
    });
  });

  it("does not replay a signature minted for another model, and never sends thinking text", () => {
    const content = chatCompletionsResponseToMessages(reply, { reasoningReplayScope: SCOPE }).content as Json[];
    const request = nextRequest(content, "gemini/another-model");
    expect(replayedToolCall(request).extra_content).toEqual({
      google: { thought_signature: "skip_thought_signature_validator" },
    });
    expect(JSON.stringify(request)).not.toContain(SIGNATURE);
    expect(JSON.stringify(request)).not.toContain("thinking");
  });

  it("sends Google's placeholder on the first unsigned call only, e.g. calls another model made", () => {
    const request = messagesRequestToChatCompletions(
      {
        model: "gemini-4-argon",
        max_tokens: 1024,
        tools: TOOLS,
        messages: [
          USER_TURN,
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_01Paris", name: "get_weather", input: { city: "Paris" } },
              { type: "tool_use", id: "toolu_02Lyon", name: "get_weather", input: { city: "Lyon" } },
            ],
          },
        ],
      },
      { reasoningReplayScope: SCOPE },
    );
    const calls = ((request.messages as Json[])[1].tool_calls as Json[]);
    expect(calls[0].extra_content).toEqual({ google: { thought_signature: "skip_thought_signature_validator" } });
    expect(calls[1].extra_content).toBeUndefined();
  });

  it("sends no placeholder when no scope is set", () => {
    const request = messagesRequestToChatCompletions({
      model: "glm-5.3-flash",
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        USER_TURN,
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01Paris", name: "get_weather", input: { city: "Paris" } }] },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("extra_content");
  });

  it("adds no thinking block when no scope is set", () => {
    const content = chatCompletionsResponseToMessages(reply).content as Json[];
    expect(content.map((b) => b.type)).toEqual(["tool_use"]);
  });
});

describe("extractChatCompletionsUsage", () => {
  it("bills Gemini thinking tokens, which only total_tokens counts, as output", () => {
    // Recorded from gemini-4-argon at reasoning_effort high, 2026-10-14.
    expect(extractChatCompletionsUsage({ completion_tokens: 6, prompt_tokens: 54, total_tokens: 5710 })).toEqual({
      input_tokens: 54,
      output_tokens: 5656,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("keeps cached tokens split out of input alongside the thinking fix", () => {
    expect(
      extractChatCompletionsUsage({
        completion_tokens: 7,
        prompt_tokens: 16021,
        prompt_tokens_details: { cached_tokens: 13972 },
        total_tokens: 16028,
      }),
    ).toEqual({ input_tokens: 2049, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 13972 });
  });
});
