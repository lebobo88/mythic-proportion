// Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section 5.3
// "Safe-tier choreography" / Section 6 Phase 4: "a `PerformanceMonitor`-
// driven safe-tier degradation ladder (bloom -> ambient freeze -> chrome ->
// LOD) with polite `aria-live` announcements; a user-facing effects/quality
// control (Auto/Full/Balanced/Minimal)"). Pure, fully unit-testable logic --
// same "extract the decision into a pure function, test it directly without
// a real WebGL context" convention this directory already uses for
// `computeLodDistances`/`transitionAlpha`/`computeBoundingSphere`. The
// REACT-level wiring (PerformanceMonitor onIncline/onDecline, the effects
// control UI, the aria-live region) is covered separately by structural
// wiring tests (see graph3DSceneBloomWiring.structural.test.ts and
// GraphView.test.tsx), matching this directory's established split.
import { describe, expect, it } from "vitest";
import {
  bloomFadeDurationMs,
  bloomTargetIntensity,
  currentBloomIntensity,
  effectiveSafeTierLevel,
  safeTierFlags,
  SAFE_TIER_LEVEL_MAX,
  SAFE_TIER_LEVEL_MIN,
  startBloomFade,
  stepAnnouncement,
  stepSafeTierLevel,
  tierChangeAnnouncement,
  type EffectsTier,
} from "../three/safeTier";

describe("stepSafeTierLevel", () => {
  it("steps down (worse performance) by exactly one level, clamped at the max", () => {
    expect(stepSafeTierLevel(0, "down")).toBe(1);
    expect(stepSafeTierLevel(3, "down")).toBe(4);
    expect(stepSafeTierLevel(SAFE_TIER_LEVEL_MAX, "down")).toBe(SAFE_TIER_LEVEL_MAX);
  });

  it("steps up (recovering performance) by exactly one level, clamped at the min", () => {
    expect(stepSafeTierLevel(4, "up")).toBe(3);
    expect(stepSafeTierLevel(1, "up")).toBe(0);
    expect(stepSafeTierLevel(SAFE_TIER_LEVEL_MIN, "up")).toBe(SAFE_TIER_LEVEL_MIN);
  });
});

describe("effectiveSafeTierLevel", () => {
  it("auto uses the live PerformanceMonitor-driven level", () => {
    expect(effectiveSafeTierLevel("auto", 0)).toBe(0);
    expect(effectiveSafeTierLevel("auto", 3)).toBe(3);
  });

  // Phase 7 closeout 10k-crash fix (T3-diagnosed): Full is a quality
  // CEILING, not a floor -- under healthy conditions nothing is degraded,
  // but Full must NEVER discard the live, already-hysteresis-debounced
  // PerformanceMonitor decline signal (the emergency GPU-pressure safety
  // valve, plan Section 5.3), because doing so is exactly what let
  // Cloud+Full at 10k nodes crash instead of degrading.
  it("full under healthy conditions (no decline signal) stays at level 0 -- no proactive degradation", () => {
    expect(effectiveSafeTierLevel("full", 0)).toBe(SAFE_TIER_LEVEL_MIN);
  });

  it("full under a genuine sustained decline follows the live emergency ladder, all the way to the full safe-tier rig", () => {
    expect(effectiveSafeTierLevel("full", 1)).toBe(1);
    expect(effectiveSafeTierLevel("full", 2)).toBe(2);
    expect(effectiveSafeTierLevel("full", 3)).toBe(3);
    expect(effectiveSafeTierLevel("full", 4)).toBe(SAFE_TIER_LEVEL_MAX);
  });

  it("full recovers back to level 0 when the live signal recovers (recovery reverses the order)", () => {
    expect(effectiveSafeTierLevel("full", 0)).toBe(SAFE_TIER_LEVEL_MIN);
  });

  it.each([0, 1, 2, 3, 4])(
    "minimal forces the maximum level regardless of the live auto level (%i) -- genuinely maps to the safe-tier rig (regression guard: unaffected by the Full-tier ceiling fix)",
    (autoLevel) => {
      expect(effectiveSafeTierLevel("minimal", autoLevel)).toBe(SAFE_TIER_LEVEL_MAX);
    },
  );

  it.each([0, 1, 2, 3, 4])(
    "balanced forces the fixed mid-ladder level 2 regardless of the live auto level (%i) -- bloom off + ambient frozen, chrome/LOD retained (regression guard: unaffected by the Full-tier ceiling fix)",
    (autoLevel) => {
      expect(effectiveSafeTierLevel("balanced", autoLevel)).toBe(2);
    },
  );
});

describe("safeTierFlags -- ladder order per Section 5.3: bloom -> ambient freeze -> chrome -> LOD", () => {
  it("level 0: nothing degraded", () => {
    expect(safeTierFlags(0)).toEqual({
      bloomEnabled: true,
      ambientFrozen: false,
      chromeThinned: false,
      lodDropped: false,
    });
  });

  it("level 1: bloom off only", () => {
    expect(safeTierFlags(1)).toEqual({
      bloomEnabled: false,
      ambientFrozen: false,
      chromeThinned: false,
      lodDropped: false,
    });
  });

  it("level 2: bloom off + ambient frozen", () => {
    expect(safeTierFlags(2)).toEqual({
      bloomEnabled: false,
      ambientFrozen: true,
      chromeThinned: false,
      lodDropped: false,
    });
  });

  it("level 3: + chrome thinned", () => {
    expect(safeTierFlags(3)).toEqual({
      bloomEnabled: false,
      ambientFrozen: true,
      chromeThinned: true,
      lodDropped: false,
    });
  });

  it("level 4 (Minimal/safe-tier rig): + LOD dropped -- every earlier step stays engaged (monotonic ladder, never a la carte)", () => {
    expect(safeTierFlags(4)).toEqual({
      bloomEnabled: false,
      ambientFrozen: true,
      chromeThinned: true,
      lodDropped: true,
    });
  });
});

describe("stepAnnouncement -- one aria-live message per single ladder-step crossing, recovery reverses the order symmetrically", () => {
  it("announces each down-step by the correct ladder item, in order", () => {
    expect(stepAnnouncement(0, 1)).toMatch(/bloom/i);
    expect(stepAnnouncement(1, 2)).toMatch(/ambient/i);
    expect(stepAnnouncement(2, 3)).toMatch(/chrome/i);
    expect(stepAnnouncement(3, 4)).toMatch(/level of detail/i);
  });

  it("down-step announcements read as a reduction", () => {
    expect(stepAnnouncement(0, 1)).toMatch(/reduced/i);
  });

  it("announces each up-step (recovery) by the SAME ladder item, in reverse order, read as a restoration", () => {
    expect(stepAnnouncement(4, 3)).toMatch(/level of detail/i);
    expect(stepAnnouncement(3, 2)).toMatch(/chrome/i);
    expect(stepAnnouncement(2, 1)).toMatch(/ambient/i);
    expect(stepAnnouncement(1, 0)).toMatch(/bloom/i);
    expect(stepAnnouncement(1, 0)).toMatch(/restored/i);
  });

  it("returns an empty string for a no-op (same level)", () => {
    expect(stepAnnouncement(2, 2)).toBe("");
  });

  it("returns an empty string for a jump of more than one level (the manual tier-change path uses tierChangeAnnouncement instead)", () => {
    expect(stepAnnouncement(0, 4)).toBe("");
    expect(stepAnnouncement(4, 0)).toBe("");
  });
});

describe("tierChangeAnnouncement -- a direct manual Auto/Full/Balanced/Minimal selection, not a step-by-step ladder message", () => {
  it.each<[EffectsTier, string]>([
    ["auto", "Auto"],
    ["full", "Full"],
    ["balanced", "Balanced"],
    ["minimal", "Minimal"],
  ])("announces %s as %s", (tier, label) => {
    expect(tierChangeAnnouncement(tier)).toBe(`Graph detail: ${label}.`);
  });
});

describe("bloomTargetIntensity -- bloom is suppressed by EITHER an in-flight mode transition OR safe-tier degradation, never additive/conflicting", () => {
  it("uses the token intensity when neither transitioning nor safe-tier-suppressed", () => {
    expect(bloomTargetIntensity(0.6, false, true)).toBe(0.6);
  });

  it("is 0 while a mode transition is in flight, regardless of safe tier", () => {
    expect(bloomTargetIntensity(0.6, true, true)).toBe(0);
  });

  it("is 0 when the safe tier has disabled bloom, regardless of transition state", () => {
    expect(bloomTargetIntensity(0.6, false, false)).toBe(0);
  });

  it("is 0 when both suppress it", () => {
    expect(bloomTargetIntensity(0.6, true, false)).toBe(0);
  });
});

describe("bloomFadeDurationMs -- Section 5.3: transition suppress 150ms/restore 225ms (asymmetric); safe-tier bloom step 150ms both ways", () => {
  const motion = { suppressMs: 150, restoreMs: 225 };

  it("transition-start uses the suppress duration", () => {
    expect(bloomFadeDurationMs("transition-start", motion)).toBe(150);
  });

  it("transition-end uses the restore duration -- restore only after the far-tier LOD restore, which is instant and precedes this fade's first frame", () => {
    expect(bloomFadeDurationMs("transition-end", motion)).toBe(225);
  });

  it("a safe-tier bloom-off/on step uses the suppress duration in both directions (\"recovery reverses the order with the SAME fades\")", () => {
    expect(bloomFadeDurationMs("safe-tier-down", motion)).toBe(150);
    expect(bloomFadeDurationMs("safe-tier-up", motion)).toBe(150);
  });

  it("a no-op trigger is instant (0ms)", () => {
    expect(bloomFadeDurationMs("none", motion)).toBe(0);
  });
});

describe("startBloomFade / currentBloomIntensity -- eased-over-time bloom intensity, mirroring modeTransition.ts's transitionAlpha/blendPositions convention", () => {
  it("interpolates linearly from the CURRENT value (hard interruptible, no reset pop) to the new target over the given duration", () => {
    const state = startBloomFade(0.6, 0, 1000, 150);
    expect(currentBloomIntensity(state, 1000)).toBeCloseTo(0.6, 5);
    expect(currentBloomIntensity(state, 1075)).toBeCloseTo(0.3, 5);
    expect(currentBloomIntensity(state, 1150)).toBeCloseTo(0, 5);
  });

  it("clamps at the target once the duration has elapsed", () => {
    const state = startBloomFade(0.6, 0, 1000, 150);
    expect(currentBloomIntensity(state, 5000)).toBe(0);
  });

  it("resolves to the target immediately when durationMs is 0 (reduced motion / an instant safe-tier step)", () => {
    const state = startBloomFade(0.6, 0, 1000, 0);
    expect(currentBloomIntensity(state, 1000)).toBe(0);
  });
});
