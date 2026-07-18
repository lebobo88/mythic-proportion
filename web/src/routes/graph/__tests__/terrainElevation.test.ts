// Phase 4a de-risking spike (plan Section 6.3, bet 2 -- Knowledge Terrain
// feasibility): unit coverage for the shared heightfield module used by
// BOTH the worker (`applyTerrainElevation` in forceLayout.worker.ts) and
// the main-thread ground mesh (`TerrainSurface.tsx`).
import { describe, expect, it } from "vitest";
import {
  buildElevationGrid,
  elevationTier,
  sampleElevation,
  TERRAIN_TIER_COUNT,
  type ElevationPoint,
} from "../three/terrainElevation";

describe("buildElevationGrid", () => {
  it("never throws and returns a flat (all-zero) grid for an empty point set", () => {
    const grid = buildElevationGrid([]);
    expect(grid.heights.length).toBe(grid.size * grid.size);
    expect(Array.from(grid.heights).every((h) => h === 0)).toBe(true);
  });

  it("is deterministic for the same input (no randomness in the aggregation/blur pass)", () => {
    const points: ElevationPoint[] = [
      { x: 0, z: 0, weight: 1 },
      { x: 10, z: -5, weight: 0.5 },
      { x: -20, z: 15, weight: 0.8 },
    ];
    const a = buildElevationGrid(points, 24);
    const b = buildElevationGrid(points, 24);
    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
  });

  it("normalizes into [0, 1] -- the peak cell is exactly 1, nothing exceeds it", () => {
    const points: ElevationPoint[] = Array.from({ length: 50 }, (_, i) => ({
      x: (i % 10) * 5,
      z: Math.floor(i / 10) * 5,
      weight: i === 0 ? 10 : 0.1, // one dominant hotspot
    }));
    const grid = buildElevationGrid(points, 32);
    let max = 0;
    for (const h of grid.heights) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
      if (h > max) max = h;
    }
    expect(max).toBe(1);
  });

  it("a cell with more/denser weight aggregates higher than a sparse cell (the labeled elevation-aggregation formula: sum of centrality, box-blurred)", () => {
    const dense: ElevationPoint[] = Array.from({ length: 20 }, () => ({ x: 0, z: 0, weight: 1 }));
    const sparse: ElevationPoint[] = [{ x: 60, z: 60, weight: 1 }];
    const grid = buildElevationGrid([...dense, ...sparse], 32);
    const denseElevation = sampleElevation(grid, 0, 0);
    const sparseElevation = sampleElevation(grid, 60, 60);
    expect(denseElevation).toBeGreaterThan(sparseElevation);
  });

  it("ignores non-positive weights (a centrality of 0 contributes no elevation)", () => {
    const points: ElevationPoint[] = [{ x: 0, z: 0, weight: 0 }];
    const grid = buildElevationGrid(points, 16);
    expect(Array.from(grid.heights).every((h) => h === 0)).toBe(true);
  });

  it("bounds grid area with a minimum span even for a single/near-degenerate point set (no zero-area grid)", () => {
    const grid = buildElevationGrid([{ x: 5, z: 5, weight: 1 }], 16);
    expect(grid.cellSize).toBeGreaterThan(0);
  });
});

describe("sampleElevation (bilinear)", () => {
  it("clamps to the grid's edge outside its bounds -- no wraparound, no out-of-range read", () => {
    const grid = buildElevationGrid([{ x: 0, z: 0, weight: 1 }], 16);
    const farAway = sampleElevation(grid, 1_000_000, 1_000_000);
    expect(Number.isFinite(farAway)).toBe(true);
    expect(farAway).toBeGreaterThanOrEqual(0);
    expect(farAway).toBeLessThanOrEqual(1);
  });

  it("interpolates smoothly between two adjacent cells (no discontinuous jump within one cell width)", () => {
    const points: ElevationPoint[] = [{ x: 0, z: 0, weight: 5 }];
    const grid = buildElevationGrid(points, 24);
    const a = sampleElevation(grid, 0, 0);
    const b = sampleElevation(grid, grid.cellSize * 0.5, 0);
    const c = sampleElevation(grid, grid.cellSize, 0);
    // Monotonic-ish falloff away from the hotspot, not a sudden cliff.
    expect(Math.abs(a - b)).toBeLessThan(Math.abs(a - c) + 1e-6);
  });
});

describe("elevationTier (contour/tier legibility)", () => {
  it("maps 0 to the lowest tier and 1 to the highest tier", () => {
    expect(elevationTier(0)).toBe(0);
    expect(elevationTier(1)).toBe(TERRAIN_TIER_COUNT - 1);
  });

  it("is monotonically non-decreasing across the 0..1 range", () => {
    let prev = -1;
    for (let e = 0; e <= 1; e += 0.05) {
      const tier = elevationTier(e);
      expect(tier).toBeGreaterThanOrEqual(prev);
      prev = tier;
    }
  });

  it("clamps out-of-range input rather than throwing or returning an out-of-band tier", () => {
    expect(elevationTier(-5)).toBe(0);
    expect(elevationTier(5)).toBe(TERRAIN_TIER_COUNT - 1);
  });
});
