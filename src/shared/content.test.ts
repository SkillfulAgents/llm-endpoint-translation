import { describe, expect, it } from "vitest";

import {
  anthropicDocument,
  anthropicImageToUrl,
  extractMidTurnSteers,
  messageContentToText,
  splitSteerSystemText,
  splitToolResultContent,
  stripAnthropicTelemetryPrefix,
  systemToText,
} from "./content.js";

describe("systemToText", () => {
  it("returns empty text for missing or non-text system values", () => {
    expect(systemToText(undefined)).toBe("");
    expect(systemToText({ type: "text", text: "not an array" })).toBe("");
    expect(systemToText([{ type: "image" }, null, { type: "text", text: 1 }])).toBe("");
  });

  it("joins text blocks with a blank line and strips the telemetry prefix once", () => {
    const system = [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1\nYou are helpful." },
      { type: "text", text: "Be terse." },
    ];
    expect(systemToText(system)).toBe("You are helpful.\n\nBe terse.");
  });

  it("strips several stacked telemetry header lines but keeps later ones", () => {
    const text = "x-anthropic-a: 1\nx-anthropic-b: 2\n\nBody\nx-anthropic-c: 3";
    expect(stripAnthropicTelemetryPrefix(text)).toBe("Body\nx-anthropic-c: 3");
  });
});

describe("messageContentToText", () => {
  it("trims strings and joins only text blocks", () => {
    expect(messageContentToText("  hi  ")).toBe("hi");
    expect(
      messageContentToText([{ type: "text", text: " a" }, { type: "image" }, { type: "text", text: "b " }]),
    ).toBe("a\n\nb");
    expect(messageContentToText(42)).toBe("");
  });
});

describe("anthropicImageToUrl", () => {
  it("builds a data URL, defaulting the media type to image/jpeg", () => {
    expect(anthropicImageToUrl({ type: "base64", data: "AAA" })).toBe("data:image/jpeg;base64,AAA");
    expect(anthropicImageToUrl({ type: "base64", media_type: "image/png", data: "AAA" })).toBe(
      "data:image/png;base64,AAA",
    );
  });

  it("returns null for empty data, non-string urls, file sources, and non-objects", () => {
    expect(anthropicImageToUrl({ type: "base64", media_type: "image/png", data: "" })).toBeNull();
    expect(anthropicImageToUrl({ type: "url", url: 5 })).toBeNull();
    expect(anthropicImageToUrl({ type: "file", file_id: "f" })).toBeNull();
    expect(anthropicImageToUrl("data:image/png;base64,AAA")).toBeNull();
  });
});

describe("anthropicDocument", () => {
  it("uses the title as filename and defaults to document.pdf / application/pdf", () => {
    expect(anthropicDocument({ title: "spec.pdf", source: { type: "base64", data: "JVB" } })).toEqual({
      kind: "file",
      filename: "spec.pdf",
      dataUrl: "data:application/pdf;base64,JVB",
    });
    expect(anthropicDocument({ title: "", source: { type: "base64", media_type: "application/pdf", data: "JVB" } })).toMatchObject({
      filename: "document.pdf",
    });
  });

  it("maps url, text, and content sources", () => {
    expect(anthropicDocument({ source: { type: "url", url: "https://x.test/a.pdf" } })).toEqual({
      kind: "url",
      url: "https://x.test/a.pdf",
    });
    expect(anthropicDocument({ source: { type: "text", media_type: "text/plain", data: "plain" } })).toEqual({
      kind: "text",
      text: "plain",
    });
    expect(
      anthropicDocument({ source: { type: "content", content: [{ type: "text", text: "chunk" }] } }),
    ).toEqual({ kind: "text", text: "chunk" });
  });

  it("returns null for sources with no portable form", () => {
    expect(anthropicDocument({ source: { type: "file", file_id: "file_1" } })).toBeNull();
    expect(anthropicDocument({ source: { type: "base64", data: "" } })).toBeNull();
    expect(anthropicDocument({ source: { type: "url", url: "" } })).toBeNull();
    expect(anthropicDocument({ source: { type: "content", content: [{ type: "image" }] } })).toBeNull();
    expect(anthropicDocument({})).toBeNull();
  });
});

describe("splitToolResultContent", () => {
  it("passes string content through and stringifies non-array objects", () => {
    expect(splitToolResultContent("ok").text).toBe("ok");
    expect(splitToolResultContent({ exit: 0 }).text).toBe('{"exit":0}');
    expect(splitToolResultContent(null).text).toBe("");
    expect(splitToolResultContent(undefined).text).toBe("");
  });

  it("splits text, images, and documents in one array and keeps block order in text", () => {
    const parts = splitToolResultContent([
      { type: "text", text: "first" },
      { type: "image", source: { type: "url", url: "https://x.test/i.png" } },
      { type: "document", source: { type: "text", data: "doc text" } },
      { type: "document", source: { type: "base64", data: "JVB" } },
      { type: "search_result", title: "t" },
      null,
    ]);
    expect(parts.text).toBe('first\n\ndoc text\n\n{"type":"search_result","title":"t"}');
    expect(parts.imageUrls).toEqual(["https://x.test/i.png"]);
    expect(parts.documents).toEqual([{ kind: "file", filename: "document.pdf", dataUrl: "data:application/pdf;base64,JVB" }]);
    expect(parts.omittedNotes).toEqual([]);
  });

  it("records the omit reason instead of the image when mapImageSource rejects it", () => {
    const parts = splitToolResultContent(
      [{ type: "image", source: { type: "base64", media_type: "image/gif", data: "R0l" } }],
      () => ({ reason: "[gif omitted]" }),
    );
    expect(parts.imageUrls).toEqual([]);
    expect(parts.omittedNotes).toEqual(["[gif omitted]"]);
  });

  it("drops documents with an unportable source without leaking base64 or ids into text", () => {
    const parts = splitToolResultContent([{ type: "document", source: { type: "file", file_id: "file_1" } }]);
    expect(parts).toEqual({ text: "", imageUrls: [], omittedNotes: [], documents: [] });
  });
});

describe("extractMidTurnSteers", () => {
  const steer = (msg: string) =>
    `<system-reminder>\nThe user sent a new message while you were working:\n${msg}\n</system-reminder>`;

  it("returns the text unchanged when there is no steer", () => {
    expect(extractMidTurnSteers("plain\n\n")).toEqual({ cleaned: "plain\n\n", steers: [] });
  });

  it("pulls each steer out and trims the trailing gap", () => {
    const { cleaned, steers } = extractMidTurnSteers(`output\n\n${steer("stop")}\n\n${steer("and wait")}\n`);
    expect(cleaned).toBe("output");
    expect(steers).toEqual([
      "The user sent a new message while you were working:\nstop",
      "The user sent a new message while you were working:\nand wait",
    ]);
  });
});

describe("splitSteerSystemText", () => {
  it("returns null for a plain system note", () => {
    expect(splitSteerSystemText("Agents available: a, b")).toBeNull();
  });

  it("returns an empty steer when the text is only the prefix and reminders", () => {
    const out = splitSteerSystemText(
      "The user sent a new message while you were working:\n<total_tokens>9 left</total_tokens>",
    );
    expect(out).toEqual({
      reminders: "<total_tokens>9 left</total_tokens>",
      steer: "The user sent a new message while you were working:",
    });
  });
});
