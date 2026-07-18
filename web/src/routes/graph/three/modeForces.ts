// Phase 4a de-risking spike (plan Section 6.3, bet 1): pure, unit-testable
// per-mode physics-target helpers consumed by `forceLayout.worker.ts`. Kept
// separate from the worker module itself so the radius/layer formulas can
// be exercised directly in vitest (jsdom has no Worker; see this
// directory's established convention in `CameraRig.tsx`/
// `cameraRigUserInterrupt.test.ts` of extracting the pure math out of the
// R3F/worker boundary specifically so it's testable without one).
//
// These are the spike's per-mode FORCE CONFIGURATIONS, not its final visual
// design: Orbital/Strata's exact metaphor already passed independent Studio
// design review (plan Section 5.2) on different grounds -- this spike's job
// (Section 6.3) is proving the TRANSITION mechanic and TERRAIN feasibility
// specifically, so these force configs only need to be genuinely distinct
// per-mode physics targets (to exercise a real matrix-interpolation
// transition across different worker outputs), not pixel-perfect
// implementations of Phase 4c's eventual production visual spec.
import type { GraphMode } from "../types";

export interface ModeForceNode {
  community?: number;
  level?: number;
  centrality?: number;
}

/** Orbital Systems: nodes settle into concentric shells keyed by community, radiating outward from the origin. */
const ORBITAL_BASE_RADIUS = 60;
const ORBITAL_SHELL_SPACING = 45;

export function orbitalRadiusForNode(node: ModeForceNode, communityCount: number): number {
  const community = node.community ?? 0;
  const bounded = communityCount > 0 ? community % communityCount : 0;
  return ORBITAL_BASE_RADIUS + bounded * ORBITAL_SHELL_SPACING;
}

/** Strata: nodes stack into horizontal layers keyed by hierarchy `level` (0 = coarsest, sits lowest). */
const STRATA_LAYER_SPACING = 70;

export function strataLayerY(node: ModeForceNode, levelCount: number): number {
  const level = node.level ?? 0;
  const bounded = levelCount > 0 ? level % levelCount : 0;
  // Centered around y=0 so the whole stack frames the same as Cloud/Orbital's origin-centered layouts.
  const mid = (levelCount - 1) / 2;
  return (bounded - mid) * STRATA_LAYER_SPACING;
}

/** Terrain: nodes settle flat (XZ only) via ordinary force-directed physics; the worker overwrites y post-tick via `terrainElevation.ts`'s heightfield -- this mode contributes no y-targeting force of its own. */
export const TERRAIN_FLATTEN_STRENGTH = 0.35;

// T2 remediation (production Graph-tab regression, BLOCKER, browser-audit
// finding): the default/"cloud" path's force configuration -- BIT-FOR-BIT
// the exact values Phase 3's live-Chrome browser-audit remediation verified
// (distanceMax tightened 600 -> 250, plus a weak 0.1-strength per-axis
// origin-containment force; numerically verified there to bound a
// demo-vault-shaped 20-node/4-edge fixture to ~radius 146 and the
// ~1500-node disclosure cap to ~radius 596 -- independently re-verified as
// part of THIS remediation job, at N=20/300/1500, all stable/non-collapsing
// across a full alpha-decay settle; see `forceLayoutModes.test.ts`'s "cloud
// mode's full settle does not collapse over time" coverage). These were
// previously inline literals split across `buildSimulation`'s shared
// (charge/link/center/collide) setup and its cloud/else force branch --
// values a reader could edit in the wrong branch (or a future mode addition
// could shadow) without any test catching the drift. Extracted here as the
// single source of truth so `forceLayout.worker.ts` CONSUMES these directly
// (never re-literals them) and this exact remediation job's regression test
// can assert against them without regex-matching source text.
export const SHARED_CHARGE_STRENGTH = -80;
export const SHARED_CHARGE_DISTANCE_MAX = 250;
export const SHARED_COLLIDE_RADIUS = 3;
export const CLOUD_LINK_DISTANCE = 40;
/** Cloud-only per-axis origin-containment strength (the "else" branch in `buildSimulation`). */
export const CLOUD_CONTAINMENT_STRENGTH = 0.1;

/** Distinct link/charge distance tuning per mode -- Orbital/Strata need shorter link distances so shell/layer grouping stays legible instead of being swamped by charge repulsion. */
export function linkDistanceForMode(mode: GraphMode): number {
  switch (mode) {
    case "orbital":
      return 24;
    case "strata":
      return 28;
    case "terrain":
      return 36;
    case "cloud":
    default:
      return CLOUD_LINK_DISTANCE;
  }
}
