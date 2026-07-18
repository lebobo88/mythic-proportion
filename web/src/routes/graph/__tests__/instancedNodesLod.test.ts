// T2 remediation (3D graph "collapse at ~8s" -- LOD-threshold root cause).
//
// Live diagnostic capture (2026-07-16/17, see the T2 job report) proved the
// physics NEVER collapses (worker tick radius stays ~117->~114.6 across 249
// ticks) and the camera settles at a CORRECT fit: fit radius 173.6, camera
// distance 384.9 -- exactly `computeFitDistance(173.6, 75)` (the live Canvas
// uses R3F's default fov of 75; Graph3DScene.tsx sets only position/far).
// Yet every node visually collapsed into a "small dense clump" the moment
// the camera settle completed. Root cause: InstancedNodes' LOD tier
// thresholds were HARDCODED absolute distances (LOD1=90, LOD2=260), while
// node-to-camera distances at the settled view span roughly
// [distance - radius, distance + radius] = [~211, ~559] -- so every single
// node fell past LOD2 and rendered as the flattest tier's tiny 1.4-unit
// flat quad (no 3D shading, no depth cues): real, healthy, spread-out 3D
// positions rendered as what LOOKS like a collapsed clump. Same category as
// the project's original audit bug ("every node fell into InstancedNodes'
// most distant, flattest LOD tier"), which was fixed on the graph-radius
// side only, leaving the fixed thresholds armed for any legitimately larger
// graph.
//
// Fix under test: `computeLodDistances(fitDistance, fitRadius)` scales the
// LOD tier thresholds off the ACTUAL camera-fit geometry, guaranteeing no
// visible node sits in the flat-quad tier at the settled fit view, while
// keeping the flat tier available for genuine manual zoom-out and keeping
// the original constants as floors so close-up behavior on small graphs is
// unchanged. Wiring: Graph3DScene passes its fitRequest into InstancedNodes,
// which calls InstancedMesh2.updateAllLOD with the scaled distances.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeLodDistances,
  DEFAULT_LOD1_DISTANCE,
  DEFAULT_LOD2_DISTANCE,
  LOD_FAR_TIER_SUPPRESSED_DISTANCE,
} from "../three/InstancedNodes";
import { computeFitDistance } from "../three/CameraRig";

const THREE_DIR = join(__dirname, "..", "three");
function readSource(fileName: string): string {
  return readFileSync(join(THREE_DIR, fileName), "utf-8");
}

/**
 * Mirrors `@three.ez/instanced-mesh`'s per-instance tier selection exactly
 * (see node_modules/@three.ez/instanced-mesh/src/core/feature/LOD.js,
 * `getObjectLODIndexForDistance`): level distances are stored SQUARED, the
 * search walks from the farthest level down, hysteresis is 0 here (the
 * production `addLOD`/`updateAllLOD` calls never set one).
 */
function lodTierForCameraDistance(cameraDistance: number, lod1: number, lod2: number): 0 | 1 | 2 {
  const levels = [0, lod1 ** 2, lod2 ** 2];
  const d2 = cameraDistance ** 2;
  for (let i = levels.length - 1; i > 0; i--) {
    if (d2 >= levels[i]) return i as 1 | 2;
  }
  return 0;
}

// The exact live-capture geometry that surfaced this job.
const CAPTURED_FIT_RADIUS = 173.6;
const CAPTURED_FOV = 75; // R3F default -- Graph3DScene's <Canvas> sets no fov
const CAPTURED_FIT_DISTANCE = computeFitDistance(CAPTURED_FIT_RADIUS, CAPTURED_FOV);

describe("LOD thresholds scale with the actual camera-fit geometry (T2 remediation -- flat-tier collapse root cause)", () => {
  it("sanity: the captured fit distance reproduces from the captured radius (fov 75)", () => {
    // Live capture reported distance 384.9 for radius 173.6.
    expect(CAPTURED_FIT_DISTANCE).toBeGreaterThan(380);
    expect(CAPTURED_FIT_DISTANCE).toBeLessThan(390);
  });

  it("documents the defect: with the legacy fixed thresholds, EVERY node at the captured settled view fell into the flat-quad tier", () => {
    const nearest = CAPTURED_FIT_DISTANCE - CAPTURED_FIT_RADIUS; // ~211
    const farthest = CAPTURED_FIT_DISTANCE + CAPTURED_FIT_RADIUS; // ~559
    // The live tick radius (~114.6) put the real nearest node at ~270 --
    // even the most conservative bound (fit radius 173.6) leaves the graph
    // center and everything beyond it past the fixed LOD2 threshold.
    expect(nearest).toBeGreaterThan(DEFAULT_LOD1_DISTANCE); // nothing in the near tier
    expect(CAPTURED_FIT_DISTANCE - 114.6).toBeGreaterThan(DEFAULT_LOD2_DISTANCE); // real nearest node: flat quad
    expect(
      lodTierForCameraDistance(CAPTURED_FIT_DISTANCE, DEFAULT_LOD1_DISTANCE, DEFAULT_LOD2_DISTANCE),
    ).toBe(2);
    expect(lodTierForCameraDistance(farthest, DEFAULT_LOD1_DISTANCE, DEFAULT_LOD2_DISTANCE)).toBe(2);
  });

  it("regression (the captured radius~174/distance~385 combination): no node between [distance - radius, distance + radius] selects the flat-quad tier", () => {
    const { lod1, lod2 } = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS);
    const nearest = CAPTURED_FIT_DISTANCE - CAPTURED_FIT_RADIUS;
    const farthest = CAPTURED_FIT_DISTANCE + CAPTURED_FIT_RADIUS;
    // Sample the full visible band densely, endpoints included.
    for (let d = nearest; d <= farthest + 1e-9; d += (farthest - nearest) / 64) {
      expect(lodTierForCameraDistance(d, lod1, lod2)).toBeLessThanOrEqual(1);
    }
  });

  it("the flat-quad tier still exists for genuine zoom-out well beyond the fitted view", () => {
    const { lod1, lod2 } = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS);
    expect(Number.isFinite(lod2)).toBe(true);
    expect(lodTierForCameraDistance(lod2 + 1, lod1, lod2)).toBe(2);
  });

  it("close-up detail is preserved: distances below the scaled lod1 select the near (42-vert) tier", () => {
    const { lod1, lod2 } = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS);
    expect(lodTierForCameraDistance(lod1 - 1, lod1, lod2)).toBe(0);
  });

  it("small graphs keep the original constants as floors (close-up behavior unchanged)", () => {
    // A near-degenerate graph: radius floor 8 (see computeBoundingSphere),
    // fit distance clamped to MIN_FIT_DISTANCE=20.
    const distance = computeFitDistance(8, CAPTURED_FOV);
    const { lod1, lod2 } = computeLodDistances(distance, 8);
    expect(lod1).toBe(DEFAULT_LOD1_DISTANCE);
    expect(lod2).toBe(DEFAULT_LOD2_DISTANCE);
  });

  it("invariants across the full plausible fit range: strictly increasing thresholds, floors respected, and the whole visible band always solid geometry", () => {
    for (const radius of [8, 20, 50, 114.6, 173.6, 300, 600, 1000, 2000]) {
      for (const fov of [50, 75]) {
        const distance = computeFitDistance(radius, fov); // includes MIN/MAX clamps
        const { lod1, lod2 } = computeLodDistances(distance, radius);
        expect(lod1).toBeGreaterThanOrEqual(DEFAULT_LOD1_DISTANCE);
        expect(lod2).toBeGreaterThanOrEqual(DEFAULT_LOD2_DISTANCE);
        expect(lod2).toBeGreaterThan(lod1); // updateAllLOD requires strictly increasing
        // No visible node at the settled fit view may render as a flat quad.
        expect(lod2).toBeGreaterThan(distance + radius);
      }
    }
  });
});

// T2 remediation (bounded investigation, Section 6.5 closeout finding): a
// transient "jagged black/teal" artifact was observed in roughly 1/5
// Orbital -> Cloud mode-switch attempts. Root-cause evidence: the invariant
// above ("No visible node at the settled fit view may render as a flat
// quad") only holds once `fit` reflects the CURRENT mode's actual settled
// radius. During an in-flight mode-transition blend, `fit` is still the
// PREVIOUS mode's (stale) settled geometry -- e.g. Orbital's much smaller
// shell radius (`ORBITAL_BASE_RADIUS`=60 plus shells) versus Cloud's
// documented settled radius (~596 at the ~1500-node disclosure cap, see
// `modeForces.ts`). As positions blend outward toward Cloud's live physics
// target, real nodes can transiently exceed the stale (too-small) lod2
// threshold and render via LOD2's flat, non-billboarded `PlaneGeometry`
// (`GEOMETRY_FAR`) -- unlike LOD0/1 (real icosahedra), this quad's
// world-space orientation never rotates to face the camera (`applyPositions`
// only ever mutates `.position`, never `.rotation`/`.quaternion`), so at a
// grazing view/light angle under the single `directionalLight` it renders
// near-black, and several such quads flickering in from different transient
// distances during the ~800ms blend reads as a jagged, transient artifact --
// exactly matching the observed report (transient, self-resolving once the
// new mode's own "end" event re-fits and widens the thresholds again;
// probabilistic, since it depends on how far the stale threshold undershoots
// the live blend geometry; asymmetric toward Orbital -> Cloud specifically,
// since that direction's radius growth is the largest of any mode pair).
//
// Mitigation under test: `computeLodDistances(..., suppressFarTier)` --
// while a transition is active, the flat/coarse LOD2 tier is suppressed
// entirely (pinned far beyond any plausible real distance), so no node can
// transiently render via the un-billboarded quad while positions are still
// blending. This never changes steady-state (non-transitioning) behavior.
describe("LOD2 (flat-quad) tier can be suppressed during an active mode-transition blend (T2 remediation)", () => {
  it("suppressFarTier pins lod2 far beyond any plausible real distance, while lod1 (real 3D geometry tiers) is unaffected", () => {
    const unsuppressed = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS);
    const suppressed = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS, true);
    expect(suppressed.lod1).toBe(unsuppressed.lod1);
    expect(suppressed.lod2).toBe(LOD_FAR_TIER_SUPPRESSED_DISTANCE);
    expect(suppressed.lod2).toBeGreaterThan(unsuppressed.lod2);
  });

  it("no node within the stale-threshold-undershoot band selects the flat tier while suppressed -- even far beyond the settled fit", () => {
    const { lod1, lod2 } = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS, true);
    // A Cloud-scale radius (~596, see modeForces.ts's documented settled
    // radius) blended out from an Orbital-scale stale threshold: sample well
    // past the captured fit's own visible band to cover the worst-case
    // undershoot.
    for (const d of [CAPTURED_FIT_DISTANCE, CAPTURED_FIT_DISTANCE + 200, CAPTURED_FIT_DISTANCE + 600, 5000]) {
      expect(lodTierForCameraDistance(d, lod1, lod2)).toBeLessThanOrEqual(1);
    }
  });

  it("default (suppressFarTier omitted) preserves the exact pre-remediation steady-state behavior", () => {
    const withoutArg = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS);
    const withFalse = computeLodDistances(CAPTURED_FIT_DISTANCE, CAPTURED_FIT_RADIUS, false);
    expect(withoutArg).toEqual(withFalse);
  });

  it("lod2 remains strictly greater than lod1 while suppressed, preserving updateAllLOD's strictly-increasing requirement", () => {
    for (const radius of [8, 60, 173.6, 596, 2000]) {
      const distance = computeFitDistance(radius, CAPTURED_FOV);
      const { lod1, lod2 } = computeLodDistances(distance, radius, true);
      expect(lod2).toBeGreaterThan(lod1);
    }
  });
});

describe("LOD rescale wiring (structural, same convention as graphPerf.synthetic.test.ts)", () => {
  it("InstancedNodes applies the scaled thresholds via InstancedMesh2.updateAllLOD when a fit arrives", () => {
    const source = readSource("InstancedNodes.tsx");
    expect(source).toMatch(/computeLodDistances\(/);
    expect(source).toMatch(/updateAllLOD\(/);
    expect(source).toMatch(/computeFitDistance\(/); // same distance the camera actually settles at
  });

  it("Graph3DScene feeds its fitRequest into InstancedNodes so thresholds track every re-fit (data reload / mode switch)", () => {
    const source = readSource("Graph3DScene.tsx");
    expect(source).toMatch(/<InstancedNodes[\s\S]*?fit=\{fitRequest\}/);
  });

  it("InstancedNodes threads transitionActive into computeLodDistances so the flat tier is suppressed while a mode-switch blend is in flight", () => {
    const source = readSource("InstancedNodes.tsx");
    expect(source).toMatch(/computeLodDistances\(distance, fit\.radius, transitionActive\)/);
  });

  it("Graph3DScene feeds its live transitioning state into InstancedNodes (not the transitionRef alone, which never re-renders)", () => {
    const source = readSource("Graph3DScene.tsx");
    expect(source).toMatch(/<InstancedNodes[\s\S]*?transitionActive=\{transitioning\}/);
  });
});
