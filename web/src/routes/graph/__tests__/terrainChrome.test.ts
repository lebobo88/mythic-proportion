// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-TERRAIN: "hillshade surface plus contour lines"; Section 5.2 Terrain
// tokens: `--graph-terrain-hillshade-strength`, `--graph-terrain-contour-
// major/minor-*"). Pure, dependency-free math -- no generated hillshade
// texture exists yet (that is Phase 6's optional A3 asset, plan Section 5.4);
// this is the PROCEDURAL fallback the plan requires every generated asset to
// have (Section 5.4 "Fallback": "A3 absent -> computeVertexNormals flat plus
// tier banding"), computed directly off the SAME shared `ElevationGrid`
// `TerrainSurface.tsx`/the worker already use -- never a second,
// independently-computed heightfield.
import { describe, expect, it } from "vitest";
import { computeHillshade, contourBandFactor } from "../three/terrainChrome";
import type { ElevationGrid } from "../three/terrainElevation";

function flatGrid(height: number, size = 4, cellSize = 10): ElevationGrid {
  return { size, minX: 0, minZ: 0, cellSize, heights: new Float32Array(size * size).fill(height) };
}

function slopedGrid(size = 8, cellSize = 1): ElevationGrid {
  // Elevation increases steeply along +x, flat along z -- a simple ramp,
  // deliberately steep (5x per cell, cellSize=1) so its slope is
  // unambiguously distinguishable from the flat grid's zero slope.
  const heights = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      heights[row * size + col] = (col / (size - 1)) * 5;
    }
  }
  return { size, minX: 0, minZ: 0, cellSize, heights };
}

describe("computeHillshade", () => {
  it("returns the same value everywhere on a perfectly flat grid (zero slope)", () => {
    const grid = flatGrid(0.5);
    const a = computeHillshade(grid, 15, 15);
    const b = computeHillshade(grid, 25, 5);
    expect(a).toBeCloseTo(b, 5);
  });

  it("returns a value in [0, 1]", () => {
    const grid = slopedGrid();
    const value = computeHillshade(grid, 4, 4);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it("a sloped surface reads differently from a flat surface (the slope is actually detected)", () => {
    const flat = computeHillshade(flatGrid(0.5, 8, 1), 4, 4);
    const sloped = computeHillshade(slopedGrid(), 4, 4);
    expect(sloped).not.toBeCloseTo(flat, 2);
  });

  it("is deterministic for the same grid/position (no randomness)", () => {
    const grid = slopedGrid();
    expect(computeHillshade(grid, 4, 4)).toBe(computeHillshade(grid, 4, 4));
  });
});

describe("contourBandFactor", () => {
  it("is 1 exactly on a contour line (elevation is an exact multiple of step)", () => {
    expect(contourBandFactor(0.4, 0.2, 0.02)).toBeCloseTo(1, 5);
  });

  it("is 0 once the distance to the nearest contour exceeds halfWidth", () => {
    expect(contourBandFactor(0.5, 0.2, 0.02)).toBe(0);
  });

  it("fades linearly between the line and halfWidth", () => {
    const value = contourBandFactor(0.41, 0.2, 0.02);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });

  it("degenerates to 0 for a non-positive step instead of dividing by zero", () => {
    expect(contourBandFactor(0.5, 0, 0.02)).toBe(0);
  });
});
