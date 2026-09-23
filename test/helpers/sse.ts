import { readFileSync } from "node:fs";

export type Json = Record<string, unknown>;
export type SseFrame = { event?: string; data: Json };

const encoder = new TextEncoder();

export function readChunksFile(path: string): Json[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Json);
}

/** Serialize payloads as SSE, with `event:` lines like the Anthropic/OpenAI servers send. */
export function toSseText(payloads: Json[]): string {
  return payloads
    .map((p) => `event: ${String(p.type)}\ndata: ${JSON.stringify(p)}\n\n`)
    .join("");
}

export function streamFromBytes(bytes: Uint8Array, splitAt: number[] = []): ReadableStream<Uint8Array> {
  const cuts = [0, ...splitAt.filter((n) => n > 0 && n < bytes.length).sort((a, b) => a - b), bytes.length];
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < cuts.length - 1; i++) controller.enqueue(bytes.slice(cuts[i], cuts[i + 1]));
      controller.close();
    },
  });
}

export function streamFromPayloads(payloads: Json[], chunkSize?: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(toSseText(payloads));
  const cuts: number[] = [];
  if (chunkSize) for (let i = chunkSize; i < bytes.length; i += chunkSize) cuts.push(i);
  return streamFromBytes(bytes, cuts);
}

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

export function parseSse(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim())
    .map((frame) => {
      let event: string | undefined;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      return { event, data: JSON.parse(data) as Json };
    });
}

export async function readSse(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  return parseSse(await readText(stream));
}
