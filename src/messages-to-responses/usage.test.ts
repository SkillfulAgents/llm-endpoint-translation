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

  it("splits cache_write_tokens out of input_tokens as cache_creation", () => {
    // OpenAI's documented example: 2,600 input = 2,000 read + 400 written + 200 fresh.
    expect(
      extractResponsesUsage({
        input_tokens: 2600,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 400 },
      }),
    ).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 2000,
    });
  });

  it("counts OpenAI web_search_call items with a search action", () => {
    const output = [
      { type: "web_search_call", action: { type: "search", query: "weather in Paris" } },
      { type: "web_search_call", action: { type: "open_page", url: "https://example.com" } },
      { type: "web_search_call", action: { type: "search", query: "Paris forecast" } },
      { type: "message", content: [] },
    ];
    expect(extractResponsesUsage({ input_tokens: 10, output_tokens: 5 }, output)).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 2 },
    });
  });

  it("prefers xAI's successful web_search_calls count over output items", () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 2 },
    };
    const output = [
      { type: "web_search_call", action: { type: "search" } },
      { type: "web_search_call", action: { type: "search" } },
    ];
    expect(extractResponsesUsage(usage, output).server_tool_use).toEqual({
      web_search_requests: 1,
    });
  });

  it("omits server_tool_use when no search ran", () => {
    expect(extractResponsesUsage({ input_tokens: 10 }, [])).not.toHaveProperty("server_tool_use");
  });

  it("reports cache writes when nothing was read from the cache", () => {
    // First turn of a GPT-5.6 conversation: the prefix is written, not read.
    expect(
      extractResponsesUsage({
        input_tokens: 5000,
        output_tokens: 300,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 4096 },
      }),
    ).toEqual({
      input_tokens: 904,
      output_tokens: 300,
      cache_creation_input_tokens: 4096,
      cache_read_input_tokens: 0,
    });
  });

  it("keeps cache_creation at 0 for models that report cache_write_tokens: 0", () => {
    // gpt-5.5 and earlier send the field as 0 (see the tier fixtures).
    expect(
      extractResponsesUsage({
        input_tokens: 12,
        output_tokens: 19,
        input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      }),
    ).toEqual({
      input_tokens: 12,
      output_tokens: 19,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("keeps the three input buckets summing to the vendor's input_tokens", () => {
    for (const [total, read, write] of [
      [100_000, 80_000, 15_000],
      [272_001, 200_000, 72_001],
      [1_024, 0, 1_024],
      [50, 50, 0],
    ]) {
      const u = extractResponsesUsage({
        input_tokens: total,
        input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
      });
      expect(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens).toBe(total);
    }
  });

  it("clamps input_tokens at 0 when reads plus writes exceed input", () => {
    const u = extractResponsesUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 40 },
    });
    expect(u.input_tokens).toBe(0);
    expect(u.cache_read_input_tokens).toBe(80);
    expect(u.cache_creation_input_tokens).toBe(40);
  });

  it("ignores a non-numeric cache_write_tokens", () => {
    expect(
      extractResponsesUsage({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 30, cache_write_tokens: "40" },
      } as never),
    ).toEqual({
      input_tokens: 70,
      output_tokens: 0,
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
