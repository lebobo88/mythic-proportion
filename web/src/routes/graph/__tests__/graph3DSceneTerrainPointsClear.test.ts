// Verifier remediation cycle 2 (VERIFICATION_NEEDS_FIX, blocker): a REAL
// render/commit-timing behavioral test for `useTerrainPointsClearOnLeave`
// (`Graph3DScene.tsx`) -- the class of bug this guards against (an
// effect reading a React STATE value that is one commit behind a REF
// mutation written earlier in the SAME commit) is, by construction,
// invisible to a structural source-regex test: the buggy source and the
// fixed source both literally contain the string
// `outgoingModeRef.current === "terrain"` -- only the surrounding boolean
// condition (and its actual runtime commit-by-commit behavior) differs.
// Uses `@testing-library/react`'s `renderHook`, which mounts a REAL React
// tree and drives REAL commits/effects -- no WebGL/`<Canvas>` involved at
// all, since this hook's own logic never touches R3F/Three.js APIs.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState, type MutableRefObject } from "react";
import { useTerrainPointsClearOnLeave } from "../three/Graph3DScene";
import type { GraphMode } from "../types";
import type { ElevationPoint } from "../three/terrainElevation";

/**
 * Small harness mirroring exactly how `SceneContents` uses the hook: owns
 * the `terrainPoints` state itself (seeded non-empty, as a real in-flight
 * Terrain surface would be) and exposes it alongside the setter, so the
 * test can assert on the ACTUAL state across renders/commits, not a mock
 * call count.
 */
function useHarness(mode: GraphMode, outgoingModeRef: MutableRefObject<GraphMode | null>, transitioning: boolean) {
  const [terrainPoints, setTerrainPoints] = useState<ElevationPoint[]>([{ x: 1, z: 1, weight: 1 }]);
  useTerrainPointsClearOnLeave(mode, outgoingModeRef, transitioning, setTerrainPoints);
  return terrainPoints;
}

describe("useTerrainPointsClearOnLeave: real commit-timing behavior", () => {
  it("does NOT clear terrainPoints in the SAME commit `mode` first leaves terrain, even though `transitioning` (React state) has not yet caught up to `outgoingModeRef` (already-synchronous ref) -- this is the exact race Verifier reproduced", () => {
    // `outgoingModeRef` is a plain ref object the test owns directly,
    // exactly like `SceneContents`'s mode-change effect would mutate it
    // SYNCHRONOUSLY before `setTransitioning(true)` merely schedules a
    // future render.
    const outgoingModeRef: MutableRefObject<GraphMode | null> = { current: null };

    const { result, rerender } = renderHook(
      ({ mode, transitioning }: { mode: GraphMode; transitioning: boolean }) =>
        useHarness(mode, outgoingModeRef, transitioning),
      { initialProps: { mode: "terrain" as GraphMode, transitioning: false } },
    );
    expect(result.current).toEqual([{ x: 1, z: 1, weight: 1 }]);

    // Simulate the mode-change effect's SYNCHRONOUS ref write, then the
    // SAME commit that flips `mode` away from terrain -- `transitioning`
    // deliberately STAYS `false` here (the stale value from before
    // `setTransitioning(true)` has had a chance to commit), reproducing
    // the exact one-commit-behind race.
    act(() => {
      outgoingModeRef.current = "terrain";
    });
    rerender({ mode: "cloud", transitioning: false });

    // THE regression assertion: must still be the original, non-empty
    // points -- a fading-out Terrain surface, not an empty/flat heightfield.
    expect(result.current).toEqual([{ x: 1, z: 1, weight: 1 }]);
  });

  it("stays deferred through the rest of the fade once `transitioning` catches up to `true`, still governed by the ref", () => {
    const outgoingModeRef: MutableRefObject<GraphMode | null> = { current: "terrain" };
    const { result, rerender } = renderHook(
      ({ mode, transitioning }: { mode: GraphMode; transitioning: boolean }) =>
        useHarness(mode, outgoingModeRef, transitioning),
      { initialProps: { mode: "cloud" as GraphMode, transitioning: false } },
    );

    rerender({ mode: "cloud", transitioning: true });
    expect(result.current).toEqual([{ x: 1, z: 1, weight: 1 }]);
  });

  it("clears terrainPoints once the transition genuinely completes (outgoingModeRef reset, transitioning catches up to false) -- never permanently stuck deferred", () => {
    const outgoingModeRef: MutableRefObject<GraphMode | null> = { current: "terrain" };
    const { result, rerender } = renderHook(
      ({ mode, transitioning }: { mode: GraphMode; transitioning: boolean }) =>
        useHarness(mode, outgoingModeRef, transitioning),
      { initialProps: { mode: "cloud" as GraphMode, transitioning: true } },
    );
    expect(result.current).toEqual([{ x: 1, z: 1, weight: 1 }]);

    // Simulate the tick handler's completion branch: the ref is cleared
    // SYNCHRONOUSLY, in the same conceptual step `setTransitioning(false)`
    // is called -- by the time the resulting re-render's effect actually
    // runs, the ref already reads `null`.
    act(() => {
      outgoingModeRef.current = null;
    });
    rerender({ mode: "cloud", transitioning: false });

    expect(result.current).toEqual([]);
  });

  it("never clears while terrain is the CURRENT (incoming) mode, regardless of transitioning", () => {
    const outgoingModeRef: MutableRefObject<GraphMode | null> = { current: "orbital" };
    const { result, rerender } = renderHook(
      ({ mode, transitioning }: { mode: GraphMode; transitioning: boolean }) =>
        useHarness(mode, outgoingModeRef, transitioning),
      { initialProps: { mode: "terrain" as GraphMode, transitioning: true } },
    );
    rerender({ mode: "terrain", transitioning: false });
    expect(result.current).toEqual([{ x: 1, z: 1, weight: 1 }]);
  });
});
