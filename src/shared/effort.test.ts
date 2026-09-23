import { describe, expect, it } from "vitest";

import { clampEffort, createEffortMapper, defaultEffortMapper } from "./effort.js";

describe("defaultEffortMapper", () => {
  it("maps low/medium/high/xhigh straight through", () => {
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      expect(defaultEffortMapper({ output_config: { effort } })).toBe(effort);
    }
  });

  it("clamps max → xhigh", () => {
    expect(defaultEffortMapper({ output_config: { effort: "max" } })).toBe("xhigh");
  });

  it("maps disabled thinking → none, winning over an explicit effort", () => {
    expect(
      defaultEffortMapper({ thinking: { type: "disabled" }, output_config: { effort: "high" } }),
    ).toBe("none");
  });

  it("returns undefined when there is no effort, an unknown effort, or enabled thinking only", () => {
    expect(defaultEffortMapper({})).toBeUndefined();
    expect(defaultEffortMapper({ output_config: { effort: "bogus" } })).toBeUndefined();
    expect(defaultEffortMapper({ thinking: { type: "enabled", budget_tokens: 2048 } })).toBeUndefined();
  });

  it("never emits minimal", () => {
    expect(defaultEffortMapper({ thinking: { type: "disabled" } })).not.toBe("minimal");
  });
});

describe("createEffortMapper", () => {
  const lowFloorHighCeiling = createEffortMapper({ disabledEffort: "low", maxEffort: "high" });
  const maxCeiling = createEffortMapper({ disabledEffort: "none", maxEffort: "max" });

  it("maps disabled thinking to the configured floor", () => {
    expect(lowFloorHighCeiling({ thinking: { type: "disabled" } })).toBe("low");
  });

  it("collapses xhigh/max to a high ceiling", () => {
    expect(lowFloorHighCeiling({ output_config: { effort: "xhigh" } })).toBe("high");
    expect(lowFloorHighCeiling({ output_config: { effort: "max" } })).toBe("high");
  });

  it("preserves xhigh and max under a max ceiling", () => {
    expect(maxCeiling({ output_config: { effort: "xhigh" } })).toBe("xhigh");
    expect(maxCeiling({ output_config: { effort: "max" } })).toBe("max");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "rejects inherited Object property name %j as an effort",
    (effort) => {
      expect(defaultEffortMapper({ output_config: { effort } })).toBeUndefined();
      expect(lowFloorHighCeiling({ output_config: { effort } })).toBeUndefined();
    },
  );
});

describe("clampEffort", () => {
  it("returns undefined for a missing effort", () => {
    expect(clampEffort(undefined, "max")).toBeUndefined();
  });

  it("does not raise an effort below the ceiling", () => {
    expect(clampEffort("low", "high")).toBe("low");
  });
});
