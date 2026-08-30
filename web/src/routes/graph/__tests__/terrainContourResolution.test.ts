// T3-advised escalation remediation (plan Section 11's documented "T3 Opus
// advisory + Fable engineering pass" track; live Browser Validator findings
// on Phase 5's Terrain mode). Two source-verified root causes:
//
//  1. Contour bands were unresolvable at mesh density: `MESH_SEGMENTS = 32`
//     (33x33 vertices) against a contour half-width of ~0.009 in
//     elevation-fraction terms meant a band almost never landed on a vertex
//     at all -- and when one did, it smeared across a whole oversized
//     triangle. Contours are VERTEX-COLOR features: a band narrower than the
//     per-vertex elevation step simply cannot rasterize. Fix: raise the mesh
//     resolution (still a single ground mesh/draw call, still procedural,
//     rebuilt only on the existing 800ms throttle) AND widen the band's
//     elevation-fraction conversion so a major band spans at least one
//     vertex interval under a worst-case full-range slope.
//
//  2. The Phase 4e PLACEHOLDER assets defeated the token-driven Phase 5
//     chrome: the fixed dark `skybox-dusk.png`, once loaded, unconditionally
//     overrode the theme-paired `--graph-terrain-sky-horizon` fallback in
//     BOTH themes (so light theme never showed its specified bright high-key
//     sky -- plan Section 5.2 "Light-theme Terrain" / Section 8.3 Gate B
//     item 6), and the `matcap-clay.png` matcap material flattened the
//     vertex-color hillshade on near-flat terrain (a matcap samples by
//     normal, and a near-flat surface has near-uniform normals -- the matcap
//     contributes a near-constant multiplier that washes the deliberate
//     hillshade/contour modulation). Phase 6 is where asset/manifest
//     decisions belong per the plan's phase sequencing; until then the
//     DEFAULT config ships no skybox/matcap and both themes run the
//     token-driven procedural sky + standard-material hillshade path. The
//     loaders, material branches, and `TerrainAssetConfig` fields all remain
//     (enhancement-only contract unchanged) for Phase 6 to re-enable with
//     theme-aware assets.
//
//  Phase 6 update: the skybox is re-enabled below (a refreshed A1 dark HDRI)
//  plus a new A3 terrain detail normal, but root cause 2 above is NOT
//  reintroduced -- `TerrainSurface.tsx` now gates `skyboxUrl` to dark theme
//  only (see `TerrainSurfaceChrome.structural.test.ts`), so the fixed dark
//  HDRI can never again unconditionally override light theme's high-key sky.
//  The matcap stays disabled; that finding is unrelated to Phase 6.
import { describe, expect, it } from "vitest";
import { MESH_SEGMENTS, CONTOUR_WIDTH_TO_ELEVATION_FRACTION } from "../three/TerrainSurface";
import { DEFAULT_TERRAIN_ASSETS, NO_TERRAIN_ASSETS } from "../three/terrainAssetManifest";

/** Default --graph-terrain-contour-major-width token value (graph-colors.ts / tokens/graph.css, both themes). */
const CONTOUR_MAJOR_WIDTH_TOKEN = 1.5;

describe("Terrain contour bands are resolvable at the ground mesh's vertex density", () => {
  it("a major contour band's full elevation-fraction width spans at least one vertex interval under a worst-case full-range slope across half the mesh", () => {
    // Worst realistic case: the full normalized elevation range [0, 1]
    // traversed across half the mesh's vertices -- the per-vertex elevation
    // step is then 1 / (MESH_SEGMENTS / 2). A band narrower than that step
    // can fall entirely between two vertices and never rasterize.
    const perVertexElevationStep = 1 / (MESH_SEGMENTS / 2);
    const majorBandFullWidth = 2 * CONTOUR_MAJOR_WIDTH_TOKEN * CONTOUR_WIDTH_TO_ELEVATION_FRACTION;
    expect(majorBandFullWidth).toBeGreaterThanOrEqual(perVertexElevationStep);
  });

  it("the raised resolution stays a bounded single ground mesh -- under 20k vertices, far below the instanced node budget", () => {
    const vertices = (MESH_SEGMENTS + 1) * (MESH_SEGMENTS + 1);
    expect(vertices).toBeLessThanOrEqual(20000);
  });
});

describe("Phase 6 default Terrain assets: theme-aware skybox re-enabled, matcap still deferred", () => {
  it("ships a default (dark A1) skybox again -- Phase 6 re-enables it, but TerrainSurface.tsx now gates it to dark theme only (see TerrainSurfaceChrome.structural.test.ts) so it can never again unconditionally override light theme's bright high-key sky", () => {
    expect(DEFAULT_TERRAIN_ASSETS.skyboxUrl).toBeDefined();
    expect(DEFAULT_TERRAIN_ASSETS.skyboxUrl).toMatch(/terrain\/skybox-dusk\.png$/);
  });

  it("ships a default terrain detail normal (A3) -- normals-only, additive over the existing vertex-color hillshade/contour path, never implicated in the Phase 5 flattening finding", () => {
    expect(DEFAULT_TERRAIN_ASSETS.normalUrl).toBeDefined();
    expect(DEFAULT_TERRAIN_ASSETS.normalUrl).toMatch(/terrain\/terrain-detail-normal\.png$/);
  });

  it("still ships NO default matcap -- the Phase 5 flattening finding (a matcap samples by normal, and this near-flat terrain has near-uniform normals) is unrelated to Phase 6 and stays fixed", () => {
    expect(DEFAULT_TERRAIN_ASSETS.matcapUrl).toBeUndefined();
  });

  it("keeps the placeholder landmark GLBs (not implicated in any finding) and the zero-asset test config", () => {
    expect(DEFAULT_TERRAIN_ASSETS.landmarks).toHaveLength(2);
    expect(NO_TERRAIN_ASSETS).toEqual({});
  });
});
