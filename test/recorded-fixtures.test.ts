import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractResponsesUsage,
  messagesResponseToResponses,
  messagesStreamToResponsesStream,
  responsesResponseToMessages,
  responsesStreamToMessagesStream,
} from "../src";
import { recordedResponsesTurns, responsesVendors } from "./fixtures/responses-corpus";
import { assertMessagesStreamGrammar, assertResponsesStreamGrammar } from "./helpers/grammar";
import { readChunksFile, readText, parseSse, streamFromPayloads, type Json } from "./helpers/sse";
import { messagesResponse } from "./schemas/messages";
import { responseObject } from "./schemas/responses";

const EXTERNAL = join(import.meta.dirname, "fixtures/external/vercel-ai");
const GOLDEN = join(import.meta.dirname, "fixtures/golden/vercel-ai");

function list(dir: string, suffix: string): string[] {
  return readdirSync(join(EXTERNAL, dir))
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

function readJson(dir: string, name: string): Json {
  return JSON.parse(readFileSync(join(EXTERNAL, dir, `${name}.json`), "utf8")) as Json;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("recorded Responses stream → Messages stream", () => {
  it.each(recordedResponsesTurns)("$vendor/$name", async ({ vendor, name, source }) => {
    const text = await readText(responsesStreamToMessagesStream(streamFromPayloads(source, 97)));
    const events = assertMessagesStreamGrammar(parseSse(text));

    const sourceText = source
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta)
      .join("");
    const outText = events.flatMap((e) =>
      e.type === "content_block_delta" && e.delta.type === "text_delta" ? [e.delta.text] : [],
    );
    expect(outText.join("")).toBe(sourceText);

    const sourceArgs = source
      .filter((e) => e.type === "response.function_call_arguments.done")
      .map((e) => e.arguments);
    const argsByIndex = new Map<number, string>();
    for (const e of events) {
      if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") {
        argsByIndex.set(e.index, (argsByIndex.get(e.index) ?? "") + e.delta.partial_json);
      }
    }
    expect([...argsByIndex.values()]).toEqual(sourceArgs);

    const completed = source.find((e) => e.type === "response.completed");
    const last = events[events.length - 1];
    if (completed) {
      expect(last.type).toBe("message_stop");
      const delta = events.find((e) => e.type === "message_delta");
      const usage = (completed.response as Json).usage as Json;
      expect(delta && delta.type === "message_delta" && delta.usage).toMatchObject(extractResponsesUsage(usage));
    } else {
      expect(last.type).toBe("error");
    }

    await expect(text).toMatchFileSnapshot(join(GOLDEN, vendor, `${name}.messages.sse`));
  });
});

describe.each(responsesVendors)("recorded %s Responses JSON → Messages JSON", (vendor) => {
  const names = list(vendor, ".json").filter((name) => !name.includes("-error."));
  it.skipIf(names.length === 0).each(names)("%s", async (name) => {
    const out = responsesResponseToMessages(readJson(vendor, name));
    messagesResponse.parse(out);
    await expect(JSON.stringify(out, null, 2) + "\n").toMatchFileSnapshot(
      join(GOLDEN, vendor, `${name}.messages.json`),
    );
  });
});

describe("recorded Anthropic Messages stream → Responses stream", () => {
  it.each(list("anthropic", ".chunks.txt"))("%s", async (name) => {
    const source = readChunksFile(join(EXTERNAL, "anthropic", `${name}.chunks.txt`));
    const text = await readText(messagesStreamToResponsesStream(streamFromPayloads(source, 97)));
    const events = assertResponsesStreamGrammar(parseSse(text));

    const textIndexes = new Set(
      source
        .filter((e) => e.type === "content_block_start" && (e.content_block as Json).type === "text")
        .map((e) => e.index),
    );
    const sourceText = source
      .filter((e) => e.type === "content_block_delta" && textIndexes.has(e.index))
      .map((e) => (e.delta as Json).text)
      .join("");
    const outText = events
      .flatMap((e) => (e.type === "response.output_text.delta" ? [e.delta] : []))
      .join("");
    expect(outText).toBe(sourceText);

    const sawStop = source.some((e) => e.type === "message_stop");
    expect(events[events.length - 1].type).toMatch(
      sawStop ? /^response\.(completed|incomplete)$/ : /^response\.failed$/,
    );

    await expect(text).toMatchFileSnapshot(join(GOLDEN, "anthropic", `${name}.responses.sse`));
  });
});

describe("recorded Anthropic Messages JSON → Responses JSON", () => {
  it.each(list("anthropic", ".json"))("%s", async (name) => {
    const out = messagesResponseToResponses(readJson("anthropic", name));
    responseObject.parse(out);
    await expect(JSON.stringify(out, null, 2) + "\n").toMatchFileSnapshot(
      join(GOLDEN, "anthropic", `${name}.responses.json`),
    );
  });
});
