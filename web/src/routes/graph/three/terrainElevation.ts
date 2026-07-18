// Phase 4a de-risking spike (plan Section 6.3, bet 2 -- Knowledge Terrain
// feasibility): a pure, dependency-free heightfield module shared by BOTH
// halves of the terrain seam:
//  - `forceLayout.worker.ts` (worker-owned physics, per the plan's
//    "worker-owned physics -- the main thread never computes positions
//    itself" invariant): after each tick's XZ settle, the worker samples
//    THIS module to write each node's y-position, so "nodes riding the
//    surface" is a worker-computed position, not a client-side visual fake.
//  - `TerrainSurface.tsx` (main thread): builds the SAME heightfield as a
//    displaced ground-plane mesh, from the same grid, so nodes and ground
//    are provably reading one shared elevation function, never two.
//
// Elevation-aggregation formula (plan Section 5.3's labeled, open decision,
// resolved here for the spike): elevation at a grid cell is the SUM of
// every node's centrality falling in that cell, box-blurred once for
// legibility, then normalized into [0, 1] and scaled to `maxHeight`. This
// reads as "hills of dense/important knowledge, valleys of sparse
// knowledge" -- a defensible, non-fabricated choice for a synthetic
// fixture, explicitly not claimed as the only possible aggregation. Phase
// 4b/4c may revisit this once real centrality/community data exists.

export interface ElevationPoint {
  x: number;
  z: number;
  /** Aggregation weight -- the spike uses node centrality (0..1); callers may pass any non-negative weight. */
  weight: number;
}

export interface ElevationGrid {
  size: number;
  minX: number;
  minZ: number;
  /** World-units spanned by one grid cell along each axis. */
  cellSize: number;
  /** Normalized elevation, 0..1, row-major (`heights[row * size + col]`). */
  heights: Float32Array;
}

export const TERRAIN_GRID_SIZE = 48;
/** World-unit padding added around the tightest node bounding box, so the surface extends slightly past the outermost nodes. */
const GRID_PADDING = 20;
/** Minimum world-unit span so a near-degenerate (few-node) fixture still gets a sane, non-zero-area grid. */
const MIN_SPAN = 40;

/**
 * Aggregates `points` (typically every node's current x/z position plus its
 * centrality) into a `size`x`size` elevation grid: per-cell weight sum,
 * one box-blur pass (3x3 mean) for contour legibility, then normalized to
 * [0, 1]. Deterministic for a given `points` array (no randomness), and
 * O(points + size^2) -- bounded regardless of how large `size` is chosen.
 */
export function buildElevationGrid(points: ElevationPoint[], size: number = TERRAIN_GRID_SIZE): ElevationGrid {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (!Number.isFinite(minX)) {
    // No points at all -- return a flat grid rather than throwing, so an
    // empty/loading fixture never crashes the terrain surface.
    minX = -MIN_SPAN / 2;
    maxX = MIN_SPAN / 2;
    minZ = -MIN_SPAN / 2;
    maxZ = MIN_SPAN / 2;
  }
  const spanX = Math.max(MIN_SPAN, maxX - minX + GRID_PADDING * 2);
  const spanZ = Math.max(MIN_SPAN, maxZ - minZ + GRID_PADDING * 2);
  const span = Math.max(spanX, spanZ);
  const originX = (minX + maxX) / 2 - span / 2;
  const originZ = (minZ + maxZ) / 2 - span / 2;
  const cellSize = span / size;

  const raw = new Float32Array(size * size);
  for (const p of points) {
    if (p.weight <= 0) continue;
    const col = clampIndex(Math.floor((p.x - originX) / cellSize), size);
    const row = clampIndex(Math.floor((p.z - originZ) / cellSize), size);
    raw[row * size + col] += p.weight;
  }

  // One 3x3 box-blur pass: turns per-cell spikes into legible, contiguous
  // "hills" instead of a single-cell noise field -- this is the whole
  // legibility bet for bounded scale; a second/third pass is a cheap future
  // knob if the browser-validated result reads too spiky, but is NOT
  // required to prove the mechanism works.
  const blurred = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let sum = 0;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          sum += raw[r * size + c];
          count += 1;
        }
      }
      blurred[row * size + col] = count > 0 ? sum / count : 0;
    }
  }

  let max = 0;
  for (let i = 0; i < blurred.length; i++) if (blurred[i] > max) max = blurred[i];
  const heights = new Float32Array(size * size);
  if (max > 0) {
    for (let i = 0; i < blurred.length; i++) heights[i] = blurred[i] / max;
  }

  return { size, minX: originX, minZ: originZ, cellSize, heights };
}

function clampIndex(i: number, size: number): number {
  return Math.max(0, Math.min(size - 1, i));
}

/**
 * Bilinear-sampled elevation (0..1) at a world-space (x, z), clamped to the
 * grid's edges outside its bounds (no wraparound, no out-of-range read).
 */
export function sampleElevation(grid: ElevationGrid, x: number, z: number): number {
  const { size, minX, minZ, cellSize, heights } = grid;
  const fx = clampFloat((x - minX) / cellSize - 0.5, 0, size - 1);
  const fz = clampFloat((z - minZ) / cellSize - 0.5, 0, size - 1);
  const col0 = Math.floor(fx);
  const row0 = Math.floor(fz);
  const col1 = Math.min(size - 1, col0 + 1);
  const row1 = Math.min(size - 1, row0 + 1);
  const tx = fx - col0;
  const tz = fz - row0;

  const h00 = heights[row0 * size + col0];
  const h10 = heights[row0 * size + col1];
  const h01 = heights[row1 * size + col0];
  const h11 = heights[row1 * size + col1];

  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * tz;
}

function clampFloat(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** World-unit height scale applied to a grid's normalized [0,1] elevation -- kept small relative to the ~1500-node default force-layout spread so the surface reads as terrain, not a wall. */
export const TERRAIN_MAX_HEIGHT = 40;

export const TERRAIN_TIER_COUNT = 5;

/**
 * Maps a normalized elevation (0..1) to a discrete contour/tier band
 * (0..tierCount-1) -- the non-color-safe legibility cue (plan Section 7's
 * `terrain.*` "elevation ramp steps 1 through 5") alongside whatever hue
 * ramp the surface material uses.
 */
export function elevationTier(elevation01: number, tierCount: number = TERRAIN_TIER_COUNT): number {
  const clamped = clampFloat(elevation01, 0, 1);
  return Math.min(tierCount - 1, Math.floor(clamped * tierCount));
}
