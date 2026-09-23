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
    return clampEffort(readAnthropicEffort(body), options.maxEffort);
  };
}

export const defaultEffortMapper: EffortMapper = createEffortMapper({
  disabledEffort: "none",
  maxEffort: "xhigh",
});
