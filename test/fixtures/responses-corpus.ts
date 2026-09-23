// Recorded OpenAI/xAI Responses streams, one entry per HTTP turn.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { readChunksFile, type Json } from "../helpers/sse";

const EXTERNAL = join(import.meta.dirname, "external/vercel-ai");

export const responsesVendors = ["openai", "xai"] as const;

const RESPONSES_TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

// Some recordings hold several agent-loop turns back to back; each turn is its own HTTP stream.
function splitResponses(events: Json[]): Json[][] {
  const turns: Json[][] = [[]];
  for (const event of events) {
    turns[turns.length - 1].push(event);
    if (RESPONSES_TERMINAL.has(String(event.type))) turns.push([]);
  }
  return turns.filter((turn) => turn.length > 0);
}

export const recordedResponsesTurns = responsesVendors.flatMap((vendor) =>
  readdirSync(join(EXTERNAL, vendor))
    .filter((file) => file.endsWith(".chunks.txt"))
    .sort()
    .flatMap((file) => {
      const name = file.slice(0, -".chunks.txt".length);
      const turns = splitResponses(readChunksFile(join(EXTERNAL, vendor, file)));
      return turns.map((source, i) => ({ vendor, name: turns.length > 1 ? `${name}.turn${i + 1}` : name, source }));
    }),
);
