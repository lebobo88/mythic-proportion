// Phase 4e (plan Section 6.7): default placeholder chrome-layer asset
// paths for Terrain mode. PLACEHOLDER ONLY -- generated via Flux.2-klein-4B
// (fp8_e4m3fn) and Trellis2 on the local ComfyUI install at H:\LocalAI (see
// this job's report and `public/terrain/ASSET_MANIFEST.json`, which is the
// authoritative, shipped-with-the-build placeholder-labeling record). No
// fabricated production-readiness claim attaches to any path below.
//
// Every field is optional and every consumer (`TerrainSurface.tsx`,
// `TerrainEnvironment.tsx`, `TerrainLandmarks.tsx`) must render correctly
// via its existing procedural/token fallback if the referenced file is
// absent or fails to load -- see `terrainAssetLoading.ts`'s non-throwing
// loader contract. `NO_TERRAIN_ASSETS` exists specifically to exercise that
// zero-generated-asset path deterministically in tests and is not a
// production configuration.

const base = import.meta.env.BASE_URL;

export interface TerrainLandmarkAsset {
  url: string;
  /** Placement as a fraction of the elevation grid's span, in [-1, 1] on each axis, so landmarks track the terrain's re-centering instead of using fixed world coordinates. */
  gridFraction: [number, number];
  scale?: number;
}

export interface TerrainAssetConfig {
  skyboxUrl?: string;
  matcapUrl?: string;
  landmarks?: TerrainLandmarkAsset[];
  /**
   * Deep-Field Observatory Phase 6 (plan Section 3.1 item 6 / Section 5.4
   * "A3 -- terrain detail/hillshade texture"): an optional tri-planar-style
   * detail normal map layered over the existing vertex-color tier
   * banding/hillshade on the ground mesh. Normals only -- never geometry,
   * tiers, placement, or state (Section 5.4's global boundary). Loaded via
   * `useOptionalNormalTexture` (`terrainAssetLoading.ts`), which is what
   * actually applies the LINEAR/`NoColorSpace` + repeat-tiling contract this
   * field's URL is loaded through -- absent or failed, the ground mesh keeps
   * its existing flat-normal (`computeVertexNormals`) plus tier-banding look.
   */
  normalUrl?: string;
}

// T3-advised escalation remediation (plan Section 11's escalation track;
// live Browser Validator findings on Terrain in both themes): the default
// config no longer references the placeholder skybox or matcap, because both
// actively defeated Phase 5's token-driven chrome once loaded:
//
//  - `skybox-dusk.png` (a fixed DARK dusk sky) unconditionally won over the
//    theme-paired `--graph-terrain-sky-horizon` fallback in
//    `TerrainEnvironment.tsx` once loaded -- so light theme could never show
//    its specified bright high-key sky (plan Section 5.2 "Light-theme
//    Terrain"; Section 8.3 Gate B item 6). A single fixed texture cannot be
//    theme-paired; theme-aware skybox assets are Phase 6 scope.
//  - `matcap-clay.png` flattened the vertex-color hillshade: a matcap
//    samples by surface normal, and this terrain is near-flat at real scale
//    (fixed 40-unit height vs. a footprint in the hundreds), so nearly every
//    vertex sampled the same near-normal-up texel -- a near-constant
//    multiplier washing out the deliberate hillshade/contour modulation the
//    `meshStandardMaterial` + scene-light path renders correctly.
//
// Phase 6 (plan Section 3.1 item 6 / Section 6 Phase 6): `skyboxUrl` is
// re-enabled below with a REFRESHED A1 dark HDRI, but root cause 1 above is
// NOT reintroduced -- `TerrainSurface.tsx` (not this static config) now
// theme-gates it, only ever passing `skyboxUrl` into `<TerrainEnvironment>`
// in dark theme, so the fixed dark HDRI can never again unconditionally win
// over light theme's high-key sky. A2 (the new light-theme high-key HDRI,
// `skybox-light-highkey.png`) is generated and manifest-recorded but
// deliberately ships as a non-default alternate, not referenced by this
// config or any code path -- the plan's own A2 spec permits shipping it this
// way "unless you can confirm the extended contrast gate stays green in
// light theme with it enabled," which requires live Browser Validator
// image-based contrast confirmation this engineering pass cannot itself
// perform; light theme keeps its already-correct, already-gated procedural
// token sky instead. A3 (`terrain-detail-normal.png`, a tangent-space detail
// normal) is also re-enabled below -- normals-only, never implicated in the
// matcap finding, additive over the existing vertex-color hillshade/contour
// path. `matcapUrl` stays disabled; that finding is unrelated to Phase 6.
// Landmark GLBs were not implicated in any finding and stay enabled.
export const DEFAULT_TERRAIN_ASSETS: TerrainAssetConfig = {
  skyboxUrl: `${base}terrain/skybox-dusk.png`,
  normalUrl: `${base}terrain/terrain-detail-normal.png`,
  landmarks: [
    { url: `${base}terrain/landmarks/obelisk.glb`, gridFraction: [-0.5, -0.4], scale: 3 },
    { url: `${base}terrain/landmarks/spire.glb`, gridFraction: [0.55, 0.3], scale: 3 },
  ],
};

/** Every field absent -- proves the zero-generated-asset procedural fallback path (plan Section 6.7). Not a production configuration. */
export const NO_TERRAIN_ASSETS: TerrainAssetConfig = {};
