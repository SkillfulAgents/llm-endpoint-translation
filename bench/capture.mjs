// Records one real OpenAI stream per wire (same prompt) into bench/captures/ for paced replay.
// Needs UPSTREAM_API_KEY. The Anthropic capture is the Responses capture run through the library.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { responsesStreamToMessagesStream } from "../dist/index.js";

const OUT = join(import.meta.dirname, "captures");
const MODEL = process.env.CAPTURE_MODEL ?? "gpt-4.1-mini";
const PROMPT =
  "First, answer in plain text with a detailed ~600 word explanation of how TCP congestion control works. " +
  "Only after the full explanation is written, call the save_note tool with a one-line summary.";
const TOOL = {
  name: "save_note",
  description: "Save a note",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

async function capture(path, body) {
  const res = await fetch(`https://api.openai.com/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.UPSTREAM_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

mkdirSync(OUT, { recursive: true });

const responses = await capture("/responses", {
  model: MODEL,
  stream: true,
  store: false,
  input: PROMPT,
  tools: [{ type: "function", ...TOOL }],
  tool_choice: "auto",
});
writeFileSync(join(OUT, "responses.sse"), responses);

const chat = await capture("/chat/completions", {
  model: MODEL,
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: "user", content: PROMPT }],
  tools: [{ type: "function", function: TOOL }],
});
writeFileSync(join(OUT, "chat.sse"), chat);

const anthropic = await new Response(
  responsesStreamToMessagesStream(new Response(responses).body, { model: "claude-bench" }),
).arrayBuffer();
writeFileSync(join(OUT, "anthropic.sse"), new Uint8Array(anthropic));

for (const name of ["responses", "chat", "anthropic"]) {
  const text = new TextDecoder().decode(
    name === "responses" ? responses : name === "chat" ? chat : new Uint8Array(anthropic),
  );
  const events = text.split("\n\n").filter((e) => e.trim()).length;
  const tool = /save_note/.test(text);
  console.log(`${name}: ${events} events, ${text.length} bytes, tool call: ${tool}`);
}
