// Phase 4a de-risking spike (plan Section 6.3, bet 2 -- Knowledge Terrain
// feasibility): the heightfield ground mesh. Reads the SAME `ElevationGrid`
// the worker samples in `forceLayout.worker.ts`'s `applyTerrainElevation`
// (built here on the main thread from the latest tick's positions, via the
// shared, pure `terrainElevation.ts` module) so nodes visibly sit ON the
// surface, never floating above or clipping through it.
//
// Contour/tier legibility (the second half of this bet): vertex colors are
// banded into `TERRAIN_TIER_COUNT` discrete steps via `elevationTier`
// (a non-color-only cue is layered on top by `--terrain-*` line/contour
// tokens in the eventual Phase 4c production build -- this spike proves the
// banding itself renders as visually discrete tiers, not a smooth gradient
// that would defeat "contour" legibility).
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, Color } from "three";
import {
  buildElevationGrid,
  elevationTier,
  sampleElevation,
  TERRAIN_GRID_SIZE,
  TERRAIN_MAX_HEIGHT,
  TERRAIN_TIER_COUNT,
  type ElevationGrid,
  type ElevationPoint,
} from "./terrainElevation";
import { computeHillshade, contourBandFactor } from "./terrainChrome";
import { useOptionalNormalTexture, useOptionalTexture } from "./terrainAssetLoading";
import { DEFAULT_TERRAIN_ASSETS, type TerrainAssetConfig } from "./terrainAssetManifest";
import { TerrainEnvironment } from "./TerrainEnvironment";
import { TerrainLandmarks } from "./TerrainLandmarks";
import type { GraphColors, TerrainChromeParams } from "../../../lib/graph-colors";

/** Contour band spacing (major = one line per tier boundary; minor = one every quarter-tier) -- Section 5.7 permitted variation: exact numerics may be tuned, provided they stay token-driven for color/width. */
const CONTOUR_MAJOR_STEP = 1 / TERRAIN_TIER_COUNT;
const CONTOUR_MINOR_STEP = CONTOUR_MAJOR_STEP / 4;
/**
 * Converts the `--graph-terrain-contour-*-width` token (a small px-ish
 * number, default 1.5/0.75) into an elevation-fraction half-width for
 * `contourBandFactor` -- a documented, labeled simplification (Section 5.7),
 * not a literal pixel measurement.
 *
 * T3-advised escalation remediation (live Browser Validator finding:
 * contour lines never appeared): raised 0.006 -> 0.01, IN TANDEM with
 * `MESH_SEGMENTS` below. Contours here are VERTEX-COLOR features -- a band
 * narrower than the per-vertex elevation step can fall entirely between two
 * vertices and never rasterize at all. At the old values (33x33 vertices, a
 * major half-width of 1.5 x 0.006 = 0.009 against a worst-case per-vertex
 * elevation step of ~0.06), that was the norm, not the edge case. The
 * relationship "major band full width >= one vertex interval's elevation
 * step" is now pinned by `terrainContourResolution.test.ts`. Exported for
 * that test only.
 */
export const CONTOUR_WIDTH_TO_ELEVATION_FRACTION = 0.01;

export interface TerrainSurfaceProps {
  /** Every visible node's current [x, z] plus its centrality weight -- the same aggregation input the worker uses. */
  points: ElevationPoint[];
  /** Sequential single-hue ramp (design handoff, plan Section 5.1: "Terrain uses a sequential single-hue ramp plus elevation contours") -- one THREE.Color per tier, low (valley) to high (peak). Falls back to a neutral gray ramp if the token bridge hasn't produced one yet. */
  tierColors?: Color[];
  /**
   * Optional Phase 4e (plan Section 6.7) placeholder chrome-layer assets:
   * skybox/HDRI, matcap atlas, optional landmark GLBs. Defaults to the
   * shipped placeholder set in `terrainAssetManifest.ts`. PLACEHOLDER ONLY,
   * enhancement-only, never required -- pass `{}` (or let any individual
   * file fail to load) to exercise the plain procedural/vertex-color ground
   * this component already rendered before this job, which remains fully
   * functional either way.
   */
  assets?: TerrainAssetConfig;
  /**
   * Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
   * J-TERRAIN: "hillshade surface plus contour lines plus ... a theme-paired
   * sky"). Optional/defaults to `undefined` so every pre-Phase-5 caller
   * (tests, `ModeSpikeView`) keeps the exact prior tier-banding-only ground
   * mesh and no procedural sky fallback -- only `Graph3DScene`'s real
   * terrain-mode call site passes live `colors`, which activates hillshade
   * shading, major/minor contour bands, and the theme-paired sky fallback
   * together.
   */
  colors?: GraphColors;
  /**
   * Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix b):
   * Terrain must participate in the SAME incoming/outgoing mode-transition
   * cross-fade Cloud/Orbital/Strata already have (Section 5.3), not a hard
   * mount/unmount boundary. Defaults to 1 (fully opaque) so every
   * pre-remediation caller is byte-identical. Threaded into the ground
   * mesh's material only -- `TerrainEnvironment`'s sky and any landmarks
   * stay at their own existing enhancement-only fallback behavior; the
   * ground mesh's opacity is the dominant visual element this fix targets.
   */
  opacity?: number;
}

const DEFAULT_TIER_COLORS = Array.from(
  { length: TERRAIN_TIER_COUNT },
  (_, tier) => new Color().setHSL(0.55, 0.35, 0.25 + (tier / (TERRAIN_TIER_COUNT - 1)) * 0.5),
);

/**
 * Grid resolution for the ground MESH's vertex lattice. T3-advised
 * escalation remediation: raised 32 -> 96 so contour bands are actually
 * resolvable as vertex-color features (see
 * `CONTOUR_WIDTH_TO_ELEVATION_FRACTION` above -- both halves of one fix;
 * chosen over widening the band alone because a band wide enough to survive
 * 33x33 vertices would have been ~a third of each tier's span, reading as
 * stripes rather than contour LINES). Finer than `TERRAIN_GRID_SIZE`'s
 * 48x48 aggregation grid is fine -- `sampleElevation` interpolates
 * bilinearly, so extra mesh vertices refine the CONTOUR/hillshade shading,
 * not the underlying data. Budget (why this stays within the plan's
 * performance discipline): still exactly ONE ground mesh/draw call, 97x97 =
 * 9,409 vertices / ~18.4k triangles (static GPU cost, far below the
 * instanced node budget); the CPU rebuild runs only on the existing 800ms
 * `terrainPoints` throttle -- O(vertices) with ~4 bilinear grid samples per
 * vertex (~38k samples, sub-millisecond-to-low-ms) -- and `buildElevationGrid`
 * itself stays O(points + grid), unchanged, at the 10k-node stress scale.
 * Exported for `terrainContourResolution.test.ts` only.
 */
export const MESH_SEGMENTS = 96;

/**
 * T2 escalation (plan Section 11 escalation track -- Terrain-mode WebGL
 * context loss, live-reproduced 4/4 runs, T3-diagnosed root cause): dispose
 * a replaced or unmounted Three.js resource's GPU buffers. In round 1 the
 * geometry memo rebuilt a brand-new 9,409-vertex BufferGeometry whenever
 * Graph3DScene's 800ms `terrainPoints` interval handed this component a
 * fresh `points` array -- but nothing ever disposed the superseded
 * geometry, so its position/color/index/normal GPU buffers leaked on every
 * rebuild (~12-30 orphaned geometries over 10-25s in Terrain mode),
 * exhausting GPU memory and killing the WebGL context. Round 2
 * (`useTerrainGeometry` below) removed the rebuild itself -- the geometry
 * identity is now permanent per mount, so this hook's on-replace half is
 * simply never triggered and its unmount half remains the single disposal
 * path. This is the same
 * `useEffect`-cleanup-keyed-on-the-resource disposal convention
 * `CommunityHulls.tsx` already uses for its replaced ConvexGeometry: the
 * cleanup for the PREVIOUS resource runs exactly when the memo produces a
 * replacement (disposing the old one), and the FINAL resource is disposed
 * on unmount. Safe under StrictMode's dev-mode double-invoke: Three.js
 * re-uploads a disposed geometry's still-held CPU-side attribute arrays on
 * its next render use. Exported (same convention as Graph3DScene's
 * `useTerrainPointsClearOnLeave`) so `terrainSurfaceGeometryDisposal.test.ts`
 * can drive it through real React commits via `renderHook`.
 */
export function useDisposeOnReplace(disposable: { dispose(): void }) {
  useEffect(() => {
    return () => {
      disposable.dispose();
    };
  }, [disposable]);
}

/**
 * T3-advised escalation remediation round 2 (plan Section 11 escalation
 * track, residual Terrain context loss): allocates the ground mesh's
 * fixed-topology vertex lattice exactly ONCE. Vertex count and the triangle
 * index depend only on the `MESH_SEGMENTS` constant -- never on the
 * elevation data -- so the position/color arrays and the index can be
 * permanent, and every subsequent data change is an IN-PLACE rewrite via
 * `updateTerrainGeometry` below. This is what removes the settle-window
 * churn at its source: the prior round's disposal fix stopped superseded
 * geometries LEAKING, but still allocated (and disposed) a full ~9.4k-vertex
 * geometry -- a complete GPU buffer re-upload -- every ~800ms for the whole
 * multi-second settle window, exactly when the GPU is already under
 * physics-settle pressure. Exported for `terrainGeometryInPlaceUpdate.test.ts`.
 */
export function createTerrainGeometry(): BufferGeometry {
  const geo = new BufferGeometry();
  const verticesPerSide = MESH_SEGMENTS + 1;
  const vertexCount = verticesPerSide * verticesPerSide;
  geo.setAttribute("position", new BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(vertexCount * 3), 3));
  const indices: number[] = [];
  for (let row = 0; row < MESH_SEGMENTS; row++) {
    for (let col = 0; col < MESH_SEGMENTS; col++) {
      const a = row * verticesPerSide + col;
      const b = a + 1;
      const c = a + verticesPerSide;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(indices);
  return geo;
}

/**
 * Rewrites the persistent geometry's position/color content for a new
 * elevation grid -- the exact per-vertex math the old rebuild used
 * (heightfield sampling, tier banding, hillshade, contour bands, one reused
 * scratch Color), now writing through the EXISTING attribute arrays instead
 * of allocating fresh ones. Flags `needsUpdate` on both attributes (bumping
 * their upload versions), recomputes normals in place
 * (`computeVertexNormals` reuses the existing normal attribute and flags it
 * itself -- verified against the installed three r169 source), and refreshes
 * the bounding sphere so frustum culling tracks the terrain's growing
 * footprint instead of the first update's bounds (a fresh-geometry rebuild
 * used to get this implicitly via lazy first-render computation). Pure with
 * respect to everything except `geo`; exported for
 * `terrainGeometryInPlaceUpdate.test.ts`, including its updated-equals-
 * freshly-built equivalence proof.
 */
export function updateTerrainGeometry(
  geo: BufferGeometry,
  grid: ElevationGrid,
  tierColors: Color[],
  chrome: TerrainChromeParams | undefined,
): void {
  const spanValue = grid.cellSize * grid.size;
  const verticesPerSide = MESH_SEGMENTS + 1;
  const positionAttr = geo.getAttribute("position") as BufferAttribute;
  const colorAttr = geo.getAttribute("color") as BufferAttribute;
  const positions = positionAttr.array as Float32Array;
  const colors = colorAttr.array as Float32Array;
  // One reused scratch Color for the whole rewrite (carried over from the
  // prior round's CPU-churn fix): the hillshade/contour branch below never
  // allocates per-vertex Color objects, and the shared `tierColors` entries
  // are never mutated.
  const scratch = new Color();

  for (let row = 0; row < verticesPerSide; row++) {
    for (let col = 0; col < verticesPerSide; col++) {
      const worldX = grid.minX + (col / MESH_SEGMENTS) * spanValue;
      const worldZ = grid.minZ + (row / MESH_SEGMENTS) * spanValue;
      const elevation01 = sampleElevation(grid, worldX, worldZ);
      const worldY = elevation01 * TERRAIN_MAX_HEIGHT;

      const i = row * verticesPerSide + col;
      positions[i * 3] = worldX;
      positions[i * 3 + 1] = worldY;
      positions[i * 3 + 2] = worldZ;

      const tier = elevationTier(elevation01);
      let color = tierColors[Math.min(tier, tierColors.length - 1)] ?? tierColors[0];

      // Deep-Field Observatory Phase 5 (plan Section 5.1 J-TERRAIN:
      // "hillshade surface plus contour lines"): only active when live
      // `colors` (a terrain-mode caller) is supplied -- every pre-Phase-5
      // caller keeps the exact prior tier-color-only ground mesh.
      if (chrome) {
        const shade = computeHillshade(grid, worldX, worldZ);
        // Darkens faces angled away from the fixed key light,
        // proportionally to the token-driven strength; a fully-lit face
        // (shade === 1) is left unchanged.
        const shadeFactor = 1 - chrome.hillshadeStrength * (1 - shade);
        color = scratch.copy(color).multiplyScalar(Math.max(0.2, shadeFactor));

        const majorHalfWidth = chrome.contourMajorWidth * CONTOUR_WIDTH_TO_ELEVATION_FRACTION;
        const minorHalfWidth = chrome.contourMinorWidth * CONTOUR_WIDTH_TO_ELEVATION_FRACTION;
        const majorFactor = contourBandFactor(elevation01, CONTOUR_MAJOR_STEP, majorHalfWidth);
        const minorFactor = contourBandFactor(elevation01, CONTOUR_MINOR_STEP, minorHalfWidth);
        // Major lines win where both bands coincide (a major step is
        // always also a minor-step multiple) -- never additively blended,
        // so a contour crossing never overshoots into an over-bright/
        // over-dark seam.
        if (majorFactor > 0) {
          // `color` already aliases `scratch` here (the hillshade copy
          // above), so in-place lerp mutates only the scratch, never a
          // shared tier color.
          color.lerp(chrome.contourMajorColor.color, majorFactor * chrome.contourMajorColor.alpha);
        } else if (minorFactor > 0) {
          color.lerp(chrome.contourMinorColor.color, minorFactor * chrome.contourMinorColor.alpha);
        }
      }

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }

  positionAttr.needsUpdate = true;
  colorAttr.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.boundingBox = null;
}

/**
 * The persistent-geometry composition the component (and the tests) use:
 * one `createTerrainGeometry` instance per mount (empty-deps memo), the
 * prior round's `useDisposeOnReplace` disposing it exactly once on unmount
 * (its identity never changes, so the on-replace half is simply never
 * triggered), and an input-keyed in-place rewrite. The rewrite runs in a
 * `useMemo` (not an effect) deliberately, matching the old build-in-a-memo
 * convention: the data is written during render, BEFORE R3F's next frame
 * can rasterize the mesh, so the first paint never shows an empty lattice.
 * It is idempotent, so StrictMode's dev-mode double-invoke is safe; the
 * double-invoked EMPTY-deps memo also transiently creates a second, never-
 * rendered lattice in dev -- CPU-side only (three uploads GPU buffers only
 * on first render use), and discarded to GC, matching how the old code's
 * double-invoked rebuild memo behaved.
 *
 * Graph3DScene's `elevationPointsEqual` settle-skip composes unchanged: a
 * settled layout keeps the same `points` reference, so the caller's grid
 * memo keeps the same `grid` identity and this update memo never re-runs --
 * zero geometry work at steady state, and only in-place rewrites (never
 * allocation) during the settle window itself.
 */
export function useTerrainGeometry(
  grid: ElevationGrid,
  tierColors: Color[],
  chrome: TerrainChromeParams | undefined,
): BufferGeometry {
  const geometry = useMemo(() => createTerrainGeometry(), []);
  useDisposeOnReplace(geometry);
  useMemo(() => {
    updateTerrainGeometry(geometry, grid, tierColors, chrome);
  }, [geometry, grid, tierColors, chrome]);
  return geometry;
}

export function TerrainSurface({
  points,
  tierColors = DEFAULT_TIER_COLORS,
  assets = DEFAULT_TERRAIN_ASSETS,
  colors,
  opacity = 1,
}: TerrainSurfaceProps) {
  // Placeholder matcap atlas (Section 6.7): enhancement-only, on top of --
  // never instead of -- the vertex-color tier banding below, which is why
  // `matcapStatus` failing/absent still leaves a fully legible ground mesh.
  const { status: matcapStatus, value: matcapTexture } = useOptionalTexture(assets.matcapUrl);

  // Deep-Field Observatory Phase 6 (plan Section 3.1 item 6 / Section 5.4
  // "A3"): the optional detail/hillshade normal map, layered over the
  // existing vertex-color tier banding -- enhancement-only, same fallback
  // discipline as the matcap above (absent/failed leaves the existing flat
  // `computeVertexNormals` look untouched).
  const { status: normalStatus, value: normalTexture } = useOptionalNormalTexture(assets.normalUrl);
  const normalLoaded = normalStatus === "loaded" && normalTexture != null;

  // Deep-Field Observatory Phase 6: theme-gates the skybox at the CALL SITE
  // (not in `terrainAssetManifest.ts`'s static `DEFAULT_TERRAIN_ASSETS`)
  // rather than baking it into a mutable config object. This is the fix that
  // keeps the Phase 5 finding fixed: `skybox-dusk.png` is a fixed DARK HDRI,
  // so it must never be handed to `<TerrainEnvironment>` in light theme,
  // where it would once again unconditionally win over the theme-paired
  // `--graph-terrain-sky-horizon` procedural fallback (see
  // `terrainAssetManifest.ts`'s `DEFAULT_TERRAIN_ASSETS` comment and
  // `terrainContourResolution.test.ts`'s Phase 5/6 history). A2 (the new
  // light-theme high-key HDRI) is deliberately NOT wired here -- it ships as
  // a manifest-recorded, non-default alternate per the plan's own A2 spec
  // (Section 5.4), so light theme keeps its already-correct, already-gated
  // procedural token sky below via `fallbackColor` instead.
  const isDarkTheme =
    typeof document === "undefined" || document.documentElement.getAttribute("data-theme") !== "light";

  // Shared with `TerrainLandmarks` below (and with the geometry memo) so a
  // landmark's placement reads the SAME elevation grid the ground mesh and
  // the worker use -- never a third, independently-computed heightfield.
  const grid = useMemo(() => buildElevationGrid(points, TERRAIN_GRID_SIZE), [points]);

  const chrome = colors?.terrainChrome;

  // T3-advised escalation remediation round 2: ONE persistent geometry per
  // mount, rewritten in place on each (throttled, settle-skipped) `points`
  // change -- see `createTerrainGeometry`/`updateTerrainGeometry`/
  // `useTerrainGeometry` above for the full churn-removal trace. The
  // aggregation grid itself is still rebuilt from `points` on the caller's
  // existing 800ms throttle (an O(points + grid) CPU pass, same as before);
  // what no longer happens is any per-tick BufferGeometry allocation,
  // GPU-buffer re-upload of a brand-new lattice, or dispose churn.
  const geometry = useTerrainGeometry(grid, tierColors, chrome);

  const matcapLoaded = matcapStatus === "loaded" && matcapTexture != null;

  return (
    <>
      <mesh geometry={geometry} position={[0, 0, 0]} receiveShadow={false}>
        {matcapLoaded ? (
          <meshMatcapMaterial
            vertexColors
            matcap={matcapTexture}
            normalMap={normalLoaded ? normalTexture : undefined}
            transparent={opacity < 1}
            opacity={opacity}
          />
        ) : (
          <meshStandardMaterial
            vertexColors
            roughness={0.9}
            metalness={0}
            normalMap={normalLoaded ? normalTexture : undefined}
            transparent={opacity < 1}
            opacity={opacity}
          />
        )}
      </mesh>
      <TerrainEnvironment
        skyboxUrl={isDarkTheme ? assets.skyboxUrl : undefined}
        fallbackColor={chrome?.skyHorizon.color}
        envIntensity={colors?.environment.intensity}
      />
      {assets.landmarks && assets.landmarks.length > 0 ? (
        <TerrainLandmarks grid={grid} landmarks={assets.landmarks} />
      ) : null}
    </>
  );
}
