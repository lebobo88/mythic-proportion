// T3-advised escalation remediation round 2 (plan Section 11 escalation
// track -- residual Terrain-mode WebGL context loss). T3's Issue 1 finding
// (b-half): the prior round's disposal fix stopped superseded geometries
// LEAKING, but TerrainSurface still allocated a brand-new ~9.4k-vertex
// BufferGeometry (position + color + index + recomputed normals) on EVERY
// 800ms settle tick for the multi-second settle window -- a
// full-GPU-reupload allocate/dispose cycle at exactly the moment the GPU is
// already under physics-settle pressure. The fix under test replaces that
// churn with IN-PLACE attribute updates on a single persistent
// BufferGeometry: `createTerrainGeometry` allocates the fixed-topology
// lattice ONCE (the vertex count and triangle index depend only on the
// MESH_SEGMENTS constant, never on the data), and `updateTerrainGeometry`
// rewrites position/color arrays, flags `needsUpdate`, recomputes normals in
// place (three r169's `computeVertexNormals` reuses the existing normal
// attribute and flags it itself -- verified against the installed source),
// and refreshes the bounding sphere (frustum culling would otherwise keep
// using the FIRST update's bounds while the terrain footprint grows).
//
// The prior round's two guards must COMPOSE with this model, not be thrown
// away: `useDisposeOnReplace` still disposes the (now single) geometry on
// unmount, and Graph3DScene's `elevationPointsEqual` settle-skip still means
// a settled layout triggers zero update work at all (same points reference
// -> same grid -> the update memo never re-runs).
//
// Coverage follows the suite's established split: pure-function equivalence
// and in-place behavior; real commit-driven hook behavior via `renderHook`
// (same as terrainSurfaceGeometryDisposal.test.ts); structural source scan
// for the R3F wiring jsdom cannot render.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook } from "@testing-library/react";
import { BufferAttribute, BufferGeometry, Color } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerrainGeometry,
  updateTerrainGeometry,
  useTerrainGeometry,
  MESH_SEGMENTS,
} from "../three/TerrainSurface";
import { buildElevationGrid, TERRAIN_GRID_SIZE, type ElevationPoint } from "../three/terrainElevation";
import { readTerrainChromeParams } from "../../../lib/graph-colors";

function readTerrainSource(): string {
  return readFileSync(join(__dirname, "..", "three", "TerrainSurface.tsx"), "utf-8");
}

const TIER_COLORS = [new Color("#223344"), new Color("#334455"), new Color("#445566"), new Color("#556677"), new Color("#667788")];

const POINTS_A: ElevationPoint[] = [
  { x: 0, z: 0, weight: 1 },
  { x: 30, z: 10, weight: 0.6 },
  { x: -12, z: 22, weight: 0.3 },
];
// A moved/spread layout, as the settle window produces every 800ms.
const POINTS_B: ElevationPoint[] = [
  { x: 4, z: -6, weight: 1 },
  { x: 55, z: 31, weight: 0.6 },
  { x: -40, z: 48, weight: 0.3 },
];

function gridOf(points: ElevationPoint[]) {
  return buildElevationGrid(points, TERRAIN_GRID_SIZE);
}

function positionsOf(geo: BufferGeometry): Float32Array {
  return (geo.getAttribute("position") as BufferAttribute).array as Float32Array;
}
function colorsOf(geo: BufferGeometry): Float32Array {
  return (geo.getAttribute("color") as BufferAttribute).array as Float32Array;
}
function normalsOf(geo: BufferGeometry): Float32Array {
  return (geo.getAttribute("normal") as BufferAttribute).array as Float32Array;
}

describe("createTerrainGeometry/updateTerrainGeometry: pure in-place update semantics", () => {
  it("an updated geometry is content-identical to a freshly built one for the same inputs -- in-place updating can never drift from a full rebuild", () => {
    // jsdom-parsed chrome defaults: activates the hillshade/contour branch
    // so the equivalence proof covers the full vertex-color math, not only
    // the plain tier-banding path.
    const chrome = readTerrainChromeParams();

    const updated = createTerrainGeometry();
    updateTerrainGeometry(updated, gridOf(POINTS_A), TIER_COLORS, chrome);
    updateTerrainGeometry(updated, gridOf(POINTS_B), TIER_COLORS, chrome);

    const fresh = createTerrainGeometry();
    updateTerrainGeometry(fresh, gridOf(POINTS_B), TIER_COLORS, chrome);

    expect(Array.from(positionsOf(updated))).toEqual(Array.from(positionsOf(fresh)));
    expect(Array.from(colorsOf(updated))).toEqual(Array.from(colorsOf(fresh)));
    expect(Array.from(normalsOf(updated))).toEqual(Array.from(normalsOf(fresh)));
    expect(Array.from(updated.index!.array)).toEqual(Array.from(fresh.index!.array));

    updated.dispose();
    fresh.dispose();
  });

  it("updates write through the SAME attribute arrays (no per-update allocation) and flag needsUpdate via attribute version bumps", () => {
    const geo = createTerrainGeometry();
    updateTerrainGeometry(geo, gridOf(POINTS_A), TIER_COLORS, undefined);

    const positionAttr = geo.getAttribute("position") as BufferAttribute;
    const colorAttr = geo.getAttribute("color") as BufferAttribute;
    const positionArray = positionsOf(geo);
    const colorArray = colorsOf(geo);
    const indexBefore = geo.index;
    const positionVersion = positionAttr.version;
    const colorVersion = colorAttr.version;

    updateTerrainGeometry(geo, gridOf(POINTS_B), TIER_COLORS, undefined);

    // Same attribute objects, same backing arrays, same static index --
    // only the CONTENT changed (and its GPU-upload flags advanced).
    expect(geo.getAttribute("position")).toBe(positionAttr);
    expect(geo.getAttribute("color")).toBe(colorAttr);
    expect(positionsOf(geo)).toBe(positionArray);
    expect(colorsOf(geo)).toBe(colorArray);
    expect(geo.index).toBe(indexBefore);
    expect(positionAttr.version).toBeGreaterThan(positionVersion);
    expect(colorAttr.version).toBeGreaterThan(colorVersion);
    expect(Array.from(positionArray)).not.toEqual([]);

    geo.dispose();
  });

  it("refreshes the bounding sphere on every update -- a growing terrain footprint must never be frustum-culled against the first update's bounds", () => {
    const geo = createTerrainGeometry();
    updateTerrainGeometry(geo, gridOf(POINTS_A), TIER_COLORS, undefined);
    const radiusA = geo.boundingSphere!.radius;

    updateTerrainGeometry(geo, gridOf(POINTS_B), TIER_COLORS, undefined);
    const radiusB = geo.boundingSphere!.radius;

    // POINTS_B spans a wider footprint, so the recomputed sphere must grow.
    expect(radiusB).toBeGreaterThan(radiusA);

    geo.dispose();
  });

  it("the fixed-topology lattice matches the documented budget: (MESH_SEGMENTS+1)^2 vertices, MESH_SEGMENTS^2 * 2 triangles", () => {
    const geo = createTerrainGeometry();
    const verticesPerSide = MESH_SEGMENTS + 1;
    expect(geo.getAttribute("position").count).toBe(verticesPerSide * verticesPerSide);
    expect(geo.index!.count).toBe(MESH_SEGMENTS * MESH_SEGMENTS * 6);
    geo.dispose();
  });
});

describe("useTerrainGeometry: real commit-driven persistence (renderHook, same convention as terrainSurfaceGeometryDisposal.test.ts)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function useHarness(points: ElevationPoint[]): BufferGeometry {
    // Mirrors TerrainSurface's exact composition: the points-keyed grid memo
    // feeding the persistent-geometry hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useTerrainGeometry(gridOf(points), TIER_COLORS, undefined);
  }

  it("keeps ONE geometry instance across settle-window updates -- fresh points arrays update in place, never allocate-and-dispose (the exact 800ms churn T3 identified)", () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const { result, rerender } = renderHook(({ points }: { points: ElevationPoint[] }) => useHarness(points), {
      initialProps: { points: POINTS_A },
    });
    const first = result.current;
    const firstPositions = positionsOf(first);

    rerender({ points: POINTS_B });
    expect(result.current).toBe(first);
    expect(positionsOf(result.current)).toBe(firstPositions);
    expect(dispose).not.toHaveBeenCalled();

    rerender({ points: POINTS_A.map((p) => ({ ...p })) });
    expect(result.current).toBe(first);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("still disposes the (single) geometry on unmount -- the prior round's useDisposeOnReplace composes with the persistent model", () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const { result, unmount } = renderHook(({ points }: { points: ElevationPoint[] }) => useHarness(points), {
      initialProps: { points: POINTS_A },
    });
    const geometry = result.current;

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.instances[0]).toBe(geometry);
  });

  it("performs ZERO update work when the grid identity is unchanged (the settled state behind Graph3DScene's elevationPointsEqual bail-out)", () => {
    const grid = gridOf(POINTS_A);
    const { result, rerender } = renderHook(
      ({ g }: { g: ReturnType<typeof gridOf> }) => useTerrainGeometry(g, TIER_COLORS, undefined),
      { initialProps: { g: grid } },
    );
    const positionAttr = result.current.getAttribute("position") as BufferAttribute;
    const versionAfterMount = positionAttr.version;

    // Same grid reference -- exactly what the settle-skip guarantees once
    // the layout froze. No rewrite, no needsUpdate bump, no GPU re-upload.
    rerender({ g: grid });
    expect((result.current.getAttribute("position") as BufferAttribute).version).toBe(versionAfterMount);
  });
});

describe("structural wiring (jsdom has no WebGL -- same convention as TerrainSurfaceChrome.structural.test.ts)", () => {
  const source = readTerrainSource();

  it("the component renders through useTerrainGeometry's persistent geometry, and the ONLY BufferGeometry construction lives in createTerrainGeometry", () => {
    expect(source).toMatch(/useTerrainGeometry\(grid, tierColors, chrome\)/);
    // Exactly one allocation site for the ground mesh's geometry.
    expect(source.match(/new BufferGeometry\(\)/g)).toHaveLength(1);
  });

  it("the persistent geometry is created once (empty-deps memo) and updated in place, keyed on grid/tierColors/chrome", () => {
    expect(source).toMatch(/useMemo\(\(\) => createTerrainGeometry\(\), \[\]\)/);
    expect(source).toMatch(/updateTerrainGeometry\(geometry, grid, tierColors, chrome\)/);
  });

  it("the prior round's disposal hook still guards the geometry (unmount disposal)", () => {
    expect(source).toMatch(/useDisposeOnReplace\(geometry\)/);
  });
});
