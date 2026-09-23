// Recorded OpenAI-compatible Chat Completions traffic across vendors.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readChunksFile, type Json } from "../helpers/sse";

const CHAT = join(import.meta.dirname, "external/vercel-ai/chat-completions");

const vendors = readdirSync(CHAT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function files(vendor: string, suffix: string): string[] {
  return readdirSync(join(CHAT, vendor))
    .filter((file) => file.endsWith(suffix))
    .map((file) => file.slice(0, -suffix.length))
    .sort();
}

export const chatStreams: Array<{ vendor: string; name: string; chunks: Json[] }> = vendors.flatMap((vendor) =>
  files(vendor, ".chunks.txt").map((name) => ({
    vendor,
    name,
    chunks: readChunksFile(join(CHAT, vendor, `${name}.chunks.txt`)),
  })),
);

export const chatReplies: Array<{ vendor: string; name: string; body: Json }> = vendors.flatMap((vendor) =>
  files(vendor, ".json").map((name) => ({
    vendor,
    name,
    body: JSON.parse(readFileSync(join(CHAT, vendor, `${name}.json`), "utf8")) as Json,
  })),
);

/** Chat Completions chunks as the upstream sends them: `data:` lines and a closing `[DONE]`. */
export function chatSseText(chunks: Json[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}
