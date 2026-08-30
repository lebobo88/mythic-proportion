// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-TERRAIN: "hillshade surface plus contour lines plus an HDRI sky");
// Section 5.4 "Fallback": "A3 absent -> computeVertexNormals flat plus tier
// banding (an optional in-shader noise intermediate)" -- no generated
// hillshade normal texture exists yet (Phase 6's optional A3 asset), so this
// module is the PROCEDURAL fallback that fallback language anticipates:
// deterministic slope-shading and contour-line math computed directly off
// the SAME shared `ElevationGrid` `TerrainSurface.tsx`/`forceLayout.worker.ts`
// already build/sample -- never a second, independently-computed heightfield
// or a random/noise-based substitute.
import { sampleElevation, type ElevationGrid } from "./terrainElevation";

/**
 * Fixed, deterministic "sun" direction for the procedural hillshade (a
 * conventional upper-left-ish key light, matching real topographic-map
 * hillshade convention: light from the northwest, elevated) -- pre-
 * normalized so `computeHillshade` never needs to renormalize it per call.
 */
const LIGHT_DIR = normalize3([-0.5, 1, 0.35]);

function normalize3([x, y, z]: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Procedural hillshade factor (0..1) at world-space (x, z): estimates the
 * local surface normal via central-difference elevation sampling (the SAME
 * `sampleElevation` the ground mesh already reads for its own vertex
 * heights), then dots it against a fixed key-light direction. Flat ground
 * facing the light reads near 1 (bright); ground angled away reads lower --
 * a standard, deterministic topographic hillshade approximation, not a
 * baked texture or random noise. Callers blend this into the base tier
 * color by `--graph-terrain-hillshade-strength` (Section 5.2), never as the
 * sole carrier of elevation (the existing tier-color banding stays the
 * primary, non-luminance-dependent cue).
 */
export function computeHillshade(grid: ElevationGrid, x: number, z: number): number {
  const step = Math.max(grid.cellSize * 0.5, 1e-6);
  const h0 = sampleElevation(grid, x, z);
  const hx = sampleElevation(grid, x + step, z);
  const hz = sampleElevation(grid, x, z + step);
  const dHdx = (hx - h0) / step;
  const dHdz = (hz - h0) / step;
  // Surface normal of the height field y = h(x, z): (-dh/dx, 1, -dh/dz).
  const normal = normalize3([-dHdx, 1, -dHdz]);
  const dot = normal[0] * LIGHT_DIR[0] + normal[1] * LIGHT_DIR[1] + normal[2] * LIGHT_DIR[2];
  // Remap [-1, 1] -> [0, 1]; a perfectly flat surface facing straight up
  // lands well above the midpoint (matching the light's upward bias) without
  // ever fully saturating either end, so tier-color banding stays visible.
  return Math.min(1, Math.max(0, 0.5 + 0.5 * dot));
}

/**
 * Distance-to-nearest-contour-line factor (0..1) for a normalized elevation
 * value: 1 exactly ON a line (a multiple of `step`), fading linearly to 0 at
 * `halfWidth` away, 0 beyond that. Used for BOTH major and minor contour
 * bands (Section 5.2 "Terrain ... `--graph-terrain-contour-major/minor-*`"),
 * called once per band with that band's own step/width -- never a single
 * hardcoded band spacing. `step <= 0` degenerates to 0 (no contour) rather
 * than dividing by zero.
 */
export function contourBandFactor(elevation01: number, step: number, halfWidth: number): number {
  if (step <= 0 || halfWidth <= 0) return 0;
  const nearestLine = Math.round(elevation01 / step) * step;
  const distance = Math.abs(elevation01 - nearestLine);
  if (distance >= halfWidth) return 0;
  return 1 - distance / halfWidth;
}
