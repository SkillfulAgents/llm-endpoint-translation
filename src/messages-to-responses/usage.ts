/**
 * OpenAI Responses API `usage` → Anthropic-shaped usage.
 *
 * Responses reports `input_tokens` as the TOTAL input, with cache reads under
 * `input_tokens_details.cached_tokens` and (GPT-5.6+) cache writes under
 * `input_tokens_details.cache_write_tokens`. Anthropic's `input_tokens`
 * excludes both, so we subtract them.
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
  // Billable hosted web searches, in Anthropic's shape. Absent when zero.
  server_tool_use?: { web_search_requests: number };
};

/** Vendor `service_tier` response echo → the `usage.speed` wire echo. */
export function servedSpeedEcho(tier: unknown): "slow" | "fast" | undefined {
  if (tier === "flex") return "slow";
  // gpt-6-astra echoes priority as "fast"; gpt-5.x echo "priority".
  if (tier === "priority" || tier === "fast") return "fast";
  return undefined;
}

/**
 * Billable hosted web searches. xAI reports successful calls in
 * `usage.server_side_tool_usage_details.web_search_calls`. OpenAI has no count;
 * it bills `web_search_call` items whose action is `search` (page opens and
 * in-page finds are free).
 */
export function countWebSearchRequests(
  usage: Record<string, unknown> | undefined,
  output: unknown,
): number {
  const details = usage?.server_side_tool_usage_details as
    | Record<string, unknown>
    | undefined;
  if (details && typeof details.web_search_calls === "number") {
    return details.web_search_calls;
  }
  if (!Array.isArray(output)) return 0;
  return output.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const { type, action } = item as Record<string, unknown>;
    return (
      type === "web_search_call" &&
      !!action &&
      typeof action === "object" &&
      (action as Record<string, unknown>).type === "search"
    );
  }).length;
}

export function extractResponsesUsage(
  usage: Record<string, unknown> | undefined,
  output?: unknown,
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
  const cacheWriteTokens =
    details && typeof details.cache_write_tokens === "number"
      ? details.cache_write_tokens
      : 0;
  const webSearchRequests = countWebSearchRequests(usage, output);
  return {
    input_tokens: Math.max(inputTokens - cachedTokens - cacheWriteTokens, 0),
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    cache_read_input_tokens: cachedTokens,
    ...(webSearchRequests > 0
      ? { server_tool_use: { web_search_requests: webSearchRequests } }
      : {}),
  };
}
