// T2 escalation (plan Section 11 escalation track -- Terrain-mode WebGL
// context loss, live-reproduced 4/4 runs, T3-diagnosed): TerrainSurface's
// geometry `useMemo` rebuilt a brand-new 9,409-vertex BufferGeometry every
// time Graph3DScene's 800ms `terrainPoints` interval handed it a fresh
// `points` array, but never disposed the superseded geometry's GPU buffers
// (position + color + index + computed normals). ~12-30 orphaned geometries
// accumulate over 10-25s in Terrain mode, exhausting GPU memory and killing
// the WebGL context. `CommunityHulls.tsx` already disposes its replaced
// ConvexGeometry via a `useEffect` cleanup keyed on the resource -- the fix
// under test is the equivalent hook (`useDisposeOnReplace`) wired to
// TerrainSurface's memoized geometry.
//
// Coverage follows this suite's established three-way convention:
//  - REAL commit-timing behavior via `@testing-library/react`'s `renderHook`
//    (same as `graph3DSceneTerrainPointsClear.test.ts` -- no WebGL/<Canvas>
//    needed, the hook itself never touches the renderer), spying on the REAL
//    `BufferGeometry.prototype.dispose`.
//  - Pure-function behavior for `elevationPointsEqual` (the optional
//    skip-unchanged-rebuild guard, mirroring the content-comparison
//    discipline `workerReinitStability.test.ts` pinned for the re-init fix).
//  - Structural source-scan for the R3F wiring jsdom cannot render (same as
//    `TerrainSurfaceChrome.structural.test.ts`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo } from "react";
import { renderHook } from "@testing-library/react";
import { BufferGeometry } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDisposeOnReplace } from "../three/TerrainSurface";
import { elevationPointsEqual, type ElevationPoint } from "../three/terrainElevation";

function readGraphSource(relativePath: string): string {
  return readFileSync(join(__dirname, "..", relativePath), "utf-8");
}

describe("useDisposeOnReplace: real commit-driven GPU-resource disposal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Harness mirroring exactly how TerrainSurface composes the hook with its
   * geometry memo: a `points`-keyed `useMemo` producing a REAL
   * BufferGeometry, followed by the disposal hook -- so a rerender with a
   * fresh `points` array reproduces the exact 800ms-interval invalidation
   * that leaked geometries in the live crash.
   */
  function useHarness(points: ElevationPoint[]): BufferGeometry {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const geometry = useMemo(() => new BufferGeometry(), [points]);
    useDisposeOnReplace(geometry);
    return geometry;
  }

  it("disposes the PREVIOUS geometry when the memo recomputes on a fresh points array (the 800ms terrain refresh) -- the exact leak that exhausted GPU memory", () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const { result, rerender } = renderHook(({ points }: { points: ElevationPoint[] }) => useHarness(points), {
      initialProps: { points: [{ x: 0, z: 0, weight: 1 }] },
    });
    const first = result.current;
    expect(dispose).not.toHaveBeenCalled();

    // A content-fresh array, exactly what the interval produces while the
    // layout is still moving.
    rerender({ points: [{ x: 5, z: 5, weight: 1 }] });
    const second = result.current;
    expect(second).not.toBe(first);
    expect(dispose).toHaveBeenCalledTimes(1);
    // The SUPERSEDED geometry was disposed -- never the live replacement.
    expect(dispose.mock.instances[0]).toBe(first);

    rerender({ points: [{ x: 9, z: 9, weight: 2 }] });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose.mock.instances[1]).toBe(second);
  });

  it("does NOT dispose the current geometry on a re-render that keeps the same geometry instance (memo not invalidated)", () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const stablePoints: ElevationPoint[] = [{ x: 0, z: 0, weight: 1 }];
    const { result, rerender } = renderHook(({ points }: { points: ElevationPoint[] }) => useHarness(points), {
      initialProps: { points: stablePoints },
    });
    const first = result.current;

    rerender({ points: stablePoints });
    expect(result.current).toBe(first);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("disposes the FINAL geometry on unmount -- no leak on component teardown either", () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const { result, unmount } = renderHook(({ points }: { points: ElevationPoint[] }) => useHarness(points), {
      initialProps: { points: [{ x: 0, z: 0, weight: 1 }] },
    });
    const last = result.current;

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.instances[0]).toBe(last);
  });
});

describe("elevationPointsEqual: content comparison for the 800ms terrain feed (skip-unchanged-rebuild guard)", () => {
  const base: ElevationPoint[] = [
    { x: 1, z: 2, weight: 0.5 },
    { x: -3, z: 4, weight: 0.1 },
  ];

  it("treats content-identical but reference-fresh arrays as equal -- a settled layout must NOT trigger a geometry rebuild/dispose cycle", () => {
    const fresh = base.map((p) => ({ ...p }));
    expect(fresh).not.toBe(base);
    expect(elevationPointsEqual(base, fresh)).toBe(true);
  });

  it("detects a moved node (x/z change)", () => {
    const moved = [{ ...base[0], x: 1.001 }, { ...base[1] }];
    expect(elevationPointsEqual(base, moved)).toBe(false);
  });

  it("detects a weight change", () => {
    const reweighted = [{ ...base[0] }, { ...base[1], weight: 0.9 }];
    expect(elevationPointsEqual(base, reweighted)).toBe(false);
  });

  it("detects an added/removed point (length change), including against the empty cleared state", () => {
    expect(elevationPointsEqual(base, base.slice(0, 1))).toBe(false);
    expect(elevationPointsEqual([], base)).toBe(false);
    expect(elevationPointsEqual([], [])).toBe(true);
  });
});

describe("structural wiring (jsdom has no WebGL -- same convention as TerrainSurfaceChrome.structural.test.ts)", () => {
  const terrainSource = readGraphSource(join("three", "TerrainSurface.tsx"));
  const sceneSource = readGraphSource(join("three", "Graph3DScene.tsx"));

  it("TerrainSurface wires useDisposeOnReplace to the memoized geometry -- the hook being correct is not enough, it must actually guard THE geometry that leaked", () => {
    expect(terrainSource).toMatch(/useDisposeOnReplace\(geometry\)/);
  });

  it("TerrainSurface's rebuild loop no longer allocates per-vertex Color clones -- hillshade/contour math writes through one reused scratch Color", () => {
    expect(terrainSource).not.toMatch(/\.clone\(\)/);
    expect(terrainSource).toMatch(/scratch\.copy\(/);
  });

  it("Graph3DScene's 800ms terrain feed keeps the PREVIOUS state array when point content is unchanged (functional setState bail-out through elevationPointsEqual), so a settled layout stops invalidating the geometry memo", () => {
    expect(sceneSource).toMatch(/setTerrainPoints\(\(prev\) =>\s*\(?elevationPointsEqual\(prev, points\) \? prev : points\)?\)/);
  });
});
