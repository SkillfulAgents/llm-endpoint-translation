import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messagesStreamToResponsesStream, responsesStreamToMessagesStream } from "../src";
import { messagesStreams } from "./fixtures/messages-corpus";
import { recordedResponsesTurns } from "./fixtures/responses-corpus";
import { encode, readText, streamFromBytes, toSseText, type Json } from "./helpers/sse";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Translate = (input: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;

const EXHAUSTIVE_LIMIT = 4096;
const SINGLE_BYTE_LIMIT = 64 * 1024;

// Deterministic PRNG so a failing split is reproducible from the seed in the test name.
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCuts(length: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const count = 1 + Math.floor(rand() * 24);
  return Array.from({ length: count }, () => 1 + Math.floor(rand() * (length - 1)));
}

const unicodeStream: Json[] = [
  { type: "message_start", message: { id: "msg_u", model: "m", usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo 世界 🎉 — ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];

const cases: Array<{ name: string; translate: Translate; payloads: Json[] }> = [
  ...messagesStreams.map(({ name, events }) => ({
    name: `messages→responses ${name}`,
    translate: messagesStreamToResponsesStream as Translate,
    payloads: events,
  })),
  { name: "messages→responses synthetic/unicode", translate: messagesStreamToResponsesStream as Translate, payloads: unicodeStream },
  ...recordedResponsesTurns.map(({ vendor, name, source }) => ({
    name: `responses→messages ${vendor}/${name}`,
    translate: responsesStreamToMessagesStream as Translate,
    payloads: source,
  })),
];

describe.each(cases)("$name", ({ translate, payloads }) => {
  const text = toSseText(payloads);
  const bytes = encode(text);
  const run = (input: Uint8Array, cuts: number[] = []) => readText(translate(streamFromBytes(input, cuts)));

  // One-byte chunks rescan the pending line each time (quadratic); cap it to keep CI fast.
  it.skipIf(bytes.length > SINGLE_BYTE_LIMIT)("is identical whether split at every byte or delivered whole", async () => {
    const whole = await run(bytes);
    expect(whole.length).toBeGreaterThan(0);
    expect(await run(bytes, Array.from({ length: bytes.length }, (_, i) => i))).toBe(whole);
  });

  it("is identical for every single split point (small inputs) or 50 seeded random splits", async () => {
    const whole = await run(bytes);
    if (bytes.length <= EXHAUSTIVE_LIMIT) {
      for (let cut = 1; cut < bytes.length; cut++) {
        const out = await run(bytes, [cut]);
        if (out !== whole) expect.fail(`output differs when split at byte ${cut}`);
      }
    } else {
      for (let seed = 1; seed <= 50; seed++) {
        const cuts = randomCuts(bytes.length, seed);
        const out = await run(bytes, cuts);
        if (out !== whole) expect.fail(`output differs for seed ${seed} cuts ${JSON.stringify(cuts)}`);
      }
    }
  });

  it("is identical with CRLF line endings", async () => {
    const whole = await run(bytes);
    const crlf = encode(text.replace(/\n/g, "\r\n"));
    expect(await run(crlf, randomCuts(crlf.length, 7))).toBe(whole);
  });
});
