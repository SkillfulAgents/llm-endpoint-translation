/**
 * OpenAI Responses API `usage` → Anthropic-shaped usage.
 *
 * Responses reports `input_tokens` as the TOTAL input (cache hits included),
 * with cached tokens under `input_tokens_details.cached_tokens`. Anthropic's
 * `input_tokens` EXCLUDES cache hits, so we subtract. There is no cache-write
 * concept, so `cache_creation_input_tokens` is always 0.
 */

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  // Served speed tier echoed into the translated response so downstream
  // JSONL consumers (the app's usage tab) can price the turn — mirrors
  // Anthropic's native fast-mode echo at `usage.speed`, extended with "slow"
  // for flex. Absent = standard. Always derived from the vendor RESPONSE
  // (what was served), never from the request.
  speed?: "slow" | "fast";
};

/** Vendor `service_tier` response echo → the `usage.speed` wire echo. */
export function servedSpeedEcho(tier: unknown): "slow" | "fast" | undefined {
  if (tier === "flex") return "slow";
  // gpt-6-astra echoes priority as "fast"; gpt-5.x echo "priority".
  if (tier === "priority" || tier === "fast") return "fast";
  return undefined;
}

export function extractResponsesUsage(
  usage: Record<string, unknown> | undefined,
): AnthropicUsage {
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const details = usage.input_tokens_details as
    | Record<string, unknown>
    | undefined;
  const cachedTokens =
    details && typeof details.cached_tokens === "number"
      ? details.cached_tokens
      : 0;
  return {
    input_tokens: Math.max(inputTokens - cachedTokens, 0),
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedTokens,
  };
}
