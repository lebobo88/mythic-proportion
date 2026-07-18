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
}

export const DEFAULT_TERRAIN_ASSETS: TerrainAssetConfig = {
  skyboxUrl: `${base}terrain/skybox-dusk.png`,
  matcapUrl: `${base}terrain/matcap-clay.png`,
  landmarks: [
    { url: `${base}terrain/landmarks/obelisk.glb`, gridFraction: [-0.5, -0.4], scale: 3 },
    { url: `${base}terrain/landmarks/spire.glb`, gridFraction: [0.55, 0.3], scale: 3 },
  ],
};

/** Every field absent -- proves the zero-generated-asset procedural fallback path (plan Section 6.7). Not a production configuration. */
export const NO_TERRAIN_ASSETS: TerrainAssetConfig = {};
