export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type EffortCeiling = "high" | "xhigh" | "max";

export type EffortMapper = (body: Record<string, unknown>) => ReasoningEffort | undefined;

export type EffortMapperOptions = {
  /** What `thinking.type: "disabled"` maps to: the cheapest tier the target accepts. */
  disabledEffort: "none" | "low";
  /** Highest accepted tier; requests above it clamp down to this. */
  maxEffort: EffortCeiling;
};

const EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/** Anthropic effort → OpenAI-style tier, clamped to `ceiling`. */
export function clampEffort(
  effort: string | undefined,
  ceiling: EffortCeiling,
): Exclude<ReasoningEffort, "none"> | undefined {
  // hasOwn, not `in`: "constructor" / "__proto__" must not read as a tier.
  if (effort === undefined || !Object.hasOwn(EFFORT_RANK, effort)) return undefined;
  return EFFORT_RANK[effort] > EFFORT_RANK[ceiling]
    ? ceiling
    : (effort as Exclude<ReasoningEffort, "none">);
}

export function readAnthropicEffort(body: Record<string, unknown>): string | undefined {
  const outputConfig = body.output_config as { effort?: unknown } | undefined;
  return typeof outputConfig?.effort === "string" ? outputConfig.effort : undefined;
}

// Budget buckets match LiteLLM's defaults; explicit `output_config.effort` always wins.
const HIGH_THINKING_BUDGET = 4096;
const MEDIUM_THINKING_BUDGET = 2048;

/** `thinking: { type: "enabled", budget_tokens }` → effort tier; undefined without a budget. */
export function effortFromThinkingBudget(body: Record<string, unknown>): "low" | "medium" | "high" | undefined {
  const thinking = body.thinking as { type?: unknown; budget_tokens?: unknown } | undefined;
  if (thinking?.type !== "enabled" || typeof thinking.budget_tokens !== "number") return undefined;
  if (thinking.budget_tokens >= HIGH_THINKING_BUDGET) return "high";
  if (thinking.budget_tokens >= MEDIUM_THINKING_BUDGET) return "medium";
  return "low";
}

export function isThinkingDisabled(body: Record<string, unknown>): boolean {
  const thinking = body.thinking as { type?: unknown } | undefined;
  return thinking?.type === "disabled";
}

/**
 * Anthropic thinking config → Responses `reasoning.effort`. Disabled thinking wins
 * over effort; undefined leaves the vendor default.
 */
export function createEffortMapper(options: EffortMapperOptions): EffortMapper {
  return (body) => {
    if (isThinkingDisabled(body)) return options.disabledEffort;
    return clampEffort(readAnthropicEffort(body) ?? effortFromThinkingBudget(body), options.maxEffort);
  };
}

export const defaultEffortMapper: EffortMapper = createEffortMapper({
  disabledEffort: "none",
  maxEffort: "xhigh",
});
