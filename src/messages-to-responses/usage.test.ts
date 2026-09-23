import { describe, expect, it } from "vitest";

import { extractResponsesUsage, servedSpeedEcho } from "./usage.js";

describe("servedSpeedEcho", () => {
  it("maps flex → slow and both priority spellings → fast", () => {
    expect(servedSpeedEcho("flex")).toBe("slow");
    expect(servedSpeedEcho("priority")).toBe("fast");
    // gpt-6-astra echoes priority as "fast".
    expect(servedSpeedEcho("fast")).toBe("fast");
  });

  it("returns undefined for default/unknown/non-string tiers", () => {
    for (const tier of ["default", "auto", "", undefined, null, 3]) {
      expect(servedSpeedEcho(tier)).toBeUndefined();
    }
  });
});

describe("extractResponsesUsage", () => {
  it("returns zeros for undefined usage", () => {
    expect(extractResponsesUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("subtracts cached_tokens from input_tokens and reports cache_read", () => {
    expect(
      extractResponsesUsage({
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 30 },
      }),
    ).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30,
    });
  });

  it("clamps input_tokens at 0 when cached exceeds input", () => {
    const u = extractResponsesUsage({
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 40 },
    });
    expect(u.input_tokens).toBe(0);
    expect(u.cache_read_input_tokens).toBe(40);
  });

  it("handles missing details / non-numeric fields gracefully", () => {
    expect(extractResponsesUsage({ input_tokens: 12 })).toEqual({
      input_tokens: 12,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(
      extractResponsesUsage({ input_tokens: "x", output_tokens: null } as never),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});
