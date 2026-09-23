import { describe, expect, it } from "vitest";

import { restoreToolName, shortenToolName, toolNameRestoreMap } from "./tool-names.js";

describe("shortenToolName", () => {
  it("keeps names at exactly 64 chars unchanged", () => {
    const name = "a".repeat(64);
    expect(shortenToolName(name)).toBe(name);
  });

  it("shortens a 65-char name to exactly 64 chars", () => {
    const short = shortenToolName("a".repeat(65));
    expect(short).toHaveLength(64);
    expect(short).toMatch(/^a{55}_[0-9a-f]{8}$/);
  });

  it("gives different short names to long names that share the first 55 chars", () => {
    const prefix = "mcp__some_server__".padEnd(60, "x");
    expect(shortenToolName(`${prefix}_read`)).not.toBe(shortenToolName(`${prefix}_write`));
  });

  it("is deterministic across calls", () => {
    const name = "t".repeat(90);
    expect(shortenToolName(name)).toBe(shortenToolName(name));
  });

  it("returns an empty name unchanged", () => {
    expect(shortenToolName("")).toBe("");
  });
});

describe("toolNameRestoreMap", () => {
  it("maps only the names that were shortened", () => {
    const long = "l".repeat(80);
    expect(toolNameRestoreMap({ tools: [{ name: "short" }, { name: long }] })).toEqual({
      [shortenToolName(long)]: long,
    });
  });

  it("returns an empty map when tools is missing or not an array", () => {
    expect(toolNameRestoreMap({})).toEqual({});
    expect(toolNameRestoreMap({ tools: "nope" })).toEqual({});
  });

  it("skips null and nameless tool entries", () => {
    expect(toolNameRestoreMap({ tools: [null, { type: "web_search" }, { name: 42 }] })).toEqual({});
  });
});

describe("restoreToolName", () => {
  it("restores a shortened name and passes unknown names through", () => {
    const map = { short_abc: "original_long_name" };
    expect(restoreToolName("short_abc", map)).toBe("original_long_name");
    expect(restoreToolName("other", map)).toBe("other");
  });

  it("passes names through when no map is given", () => {
    expect(restoreToolName("x")).toBe("x");
  });

  it("does not resolve inherited object keys such as toString", () => {
    expect(restoreToolName("toString", {})).toBe("toString");
    expect(restoreToolName("__proto__", {})).toBe("__proto__");
  });
});
