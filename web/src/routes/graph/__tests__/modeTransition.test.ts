// Phase 4a de-risking spike (plan Section 6.3, bet 1 -- mode-switch
// transition continuity): unit coverage for the pure blend engine. See
// `modeTransition.ts`'s header comment for why this deliberately blends
// toward REAL worker-computed positions rather than a scripted path.
import { describe, expect, it } from "vitest";
import {
  blendPositions,
  isTransitionActive,
  MODE_TRANSITION_DURATION_MS,
  startModeTransition,
  transitionAlpha,
} from "../three/modeTransition";

describe("startModeTransition / transitionAlpha", () => {
  it("snapshots ids/positions and starts at alpha 0", () => {
    const ids = ["a", "b"];
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const state = startModeTransition(ids, positions, 1000);
    expect(state.fromPositions.get("a")).toEqual([1, 2, 3]);
    expect(state.fromPositions.get("b")).toEqual([4, 5, 6]);
    expect(transitionAlpha(state, 1000)).toBe(0);
  });

  it("is bounded at (at most) ~800ms per the design handoff's M1 spec", () => {
    expect(MODE_TRANSITION_DURATION_MS).toBeLessThanOrEqual(800);
  });

  it("reaches alpha 1 once durationMs has fully elapsed, and clamps beyond it", () => {
    const state = startModeTransition(["a"], new Float32Array([0, 0, 0]), 0, 800);
    expect(transitionAlpha(state, 400)).toBeGreaterThan(0);
    expect(transitionAlpha(state, 400)).toBeLessThan(1);
    expect(transitionAlpha(state, 800)).toBe(1);
    expect(transitionAlpha(state, 5000)).toBe(1); // clamped, never > 1
  });

  it("eases (is not linear) -- alpha at the midpoint is not exactly 0.5", () => {
    const state = startModeTransition(["a"], new Float32Array([0, 0, 0]), 0, 800);
    expect(transitionAlpha(state, 400)).not.toBeCloseTo(0.5, 5);
  });

  it("a durationMs of 0 (reduced-motion path) resolves to alpha 1 immediately -- no interpolation window at all", () => {
    const state = startModeTransition(["a"], new Float32Array([0, 0, 0]), 1000, 0);
    expect(transitionAlpha(state, 1000)).toBe(1);
  });

  it("isTransitionActive is false once alpha reaches 1, true while still ramping", () => {
    const state = startModeTransition(["a"], new Float32Array([0, 0, 0]), 0, 800);
    expect(isTransitionActive(state, 0)).toBe(true);
    expect(isTransitionActive(state, 400)).toBe(true);
    expect(isTransitionActive(state, 800)).toBe(false);
    expect(isTransitionActive(null, 800)).toBe(false);
  });
});

describe("blendPositions", () => {
  it("at alpha 0, output equals the FROM snapshot (not the target) -- proves the blend actually starts from the old mode's positions", () => {
    const ids = ["a"];
    const from = new Float32Array([0, 0, 0]);
    const state = startModeTransition(ids, from, 0, 800);
    const to = new Float32Array([100, 200, 300]);
    const out = new Float32Array(3);
    blendPositions(state, ids, to, 0, out);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it("at alpha 1 (duration elapsed), output equals the live TARGET positions exactly -- proves it converges to whatever the worker actually computed, not a fixed endpoint", () => {
    const ids = ["a"];
    const from = new Float32Array([0, 0, 0]);
    const state = startModeTransition(ids, from, 0, 800);
    const to = new Float32Array([100, 200, 300]);
    const out = new Float32Array(3);
    blendPositions(state, ids, to, 800, out);
    expect(Array.from(out)).toEqual([100, 200, 300]);
  });

  it("mid-transition, output is strictly between from and to on every axis", () => {
    const ids = ["a"];
    const from = new Float32Array([0, 0, 0]);
    const state = startModeTransition(ids, from, 0, 800);
    const to = new Float32Array([100, 200, 300]);
    const out = new Float32Array(3);
    blendPositions(state, ids, to, 400, out);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeLessThan(100);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(200);
  });

  it("re-targets to a DIFFERENT live target on a later call with the same state -- this is what makes it 'never a canned animation': the worker's own tick output keeps moving and the blend keeps chasing it", () => {
    const ids = ["a"];
    const from = new Float32Array([0, 0, 0]);
    const state = startModeTransition(ids, from, 0, 800);
    const out = new Float32Array(3);

    blendPositions(state, ids, new Float32Array([100, 0, 0]), 400, out);
    const firstBlendX = out[0];

    // A DIFFERENT still-settling target at the same elapsed time -- the
    // physics kept moving between these two calls, exactly as it would tick
    // by tick in Graph3DScene's real onTick handler.
    blendPositions(state, ids, new Float32Array([140, 0, 0]), 400, out);
    expect(out[0]).not.toBe(firstBlendX);
    expect(out[0]).toBeGreaterThan(firstBlendX); // tracks the moved target, not a frozen path
  });

  it("a node absent from the FROM snapshot (newly visible) renders at its current/target position immediately -- nothing to blend from", () => {
    const state = startModeTransition(["a"], new Float32Array([0, 0, 0]), 0, 800);
    const out = new Float32Array(3);
    blendPositions(state, ["new-node"], new Float32Array([9, 9, 9]), 100, out);
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  it("handles multiple ids independently in one call, matching the worker's batched-tick shape", () => {
    const ids = ["a", "b"];
    const from = new Float32Array([0, 0, 0, 10, 10, 10]);
    const state = startModeTransition(ids, from, 0, 800);
    const to = new Float32Array([100, 100, 100, 20, 20, 20]);
    const out = new Float32Array(6);
    blendPositions(state, ids, to, 0, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 10, 10, 10]);
  });
});
