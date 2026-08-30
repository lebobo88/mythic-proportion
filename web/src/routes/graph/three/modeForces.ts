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
/** The PREFERRED (uncompressed) shell spacing. Exported (T3-advised escalation remediation round 2) so the shell-wall chrome height in `perModeChromeGeometry.ts` derives from THIS spacing, never a second independently-tuned constant. The EFFECTIVE spacing may compress below this at high community counts -- see `orbitalShellSpacing` below. */
export const ORBITAL_SHELL_SPACING = 45;

/**
 * Escalation remediation round 4 (live Browser Validator finding: Orbital
 * showed "nothing but the raw node/edge cluster" at the default
 * ?syntheticGraph=1500 fixture; root cause reproduced live and traced in
 * `orbitalFrameableExtent.test.ts`): ceiling on the OUTERMOST shell's
 * radius, so the whole shell system always stays inside the protected
 * camera-fit pipeline's frameable envelope. The settle fit hard-clamps at
 * `MAX_FIT_DISTANCE = 1500` (CameraRig.tsx -- protected/untouchable since
 * round 1's revert), which can frame a bounding radius of at most
 * `1500 * sin(fov / 2) / FIT_PADDING` (~469 world units at CameraRig's
 * conservative fov-50 fallback; ~676 at the live Canvas's fov 75). The
 * unbounded pre-fix ladder (`60 + community * 45`) reached 1770 at the
 * default fixture's real 39 communities, parking the clamped camera INSIDE
 * the shell system -- the default framing became a full-frame wall of
 * nearby nodes/edges with the disc/ring/wall chrome pushed out to the
 * periphery. 400 keeps the outermost shell (plus one legacy 45-unit
 * spacing of settled-node jitter) under the stricter fov-50 ceiling.
 */
export const MAX_ORBITAL_OUTERMOST_RADIUS = 400;

/**
 * EFFECTIVE per-shell spacing for a given community count: the preferred 45
 * wherever the outermost shell already fits under
 * `MAX_ORBITAL_OUTERMOST_RADIUS` (every count <= 8 -- outermost <= 375, the
 * exact scales rounds 2-3 validated, byte-identical behavior), otherwise
 * compressed exactly enough (base radius untouched) that it fits. Shells
 * always remain genuinely concentric: distinct, strictly increasing radii.
 */
export function orbitalShellSpacing(communityCount: number): number {
  if (communityCount <= 1) return ORBITAL_SHELL_SPACING;
  const fitted = (MAX_ORBITAL_OUTERMOST_RADIUS - ORBITAL_BASE_RADIUS) / (communityCount - 1);
  return Math.min(ORBITAL_SHELL_SPACING, fitted);
}

export function orbitalRadiusForNode(node: ModeForceNode, communityCount: number): number {
  const community = node.community ?? 0;
  const bounded = communityCount > 0 ? community % communityCount : 0;
  return ORBITAL_BASE_RADIUS + bounded * orbitalShellSpacing(communityCount);
}

/**
 * Escalation remediation round 8, Fix A (live runtime diagnostic finding:
 * the settled Orbital system measured ~467 world units of max node distance
 * against the compressed shell ladder's ~400-unit outermost target -- a ~17%
 * overshoot that, compounded with the settle fit's isotropic bounding-sphere
 * overestimate, left the whole system projecting to ~159x167px on a
 * 1374px-wide canvas). Root cause: the Phase 4a spike's forceRadial strength
 * (0.25) is an equilibrium between the radial pull toward each node's shell
 * target and the shared charge repulsion (`SHARED_CHARGE_STRENGTH` -80,
 * distanceMax 250, deliberately untouched -- it is cloud-baseline-pinned by
 * forceLayoutModes.test.ts) -- at 0.25 that equilibrium sits ~17% OUTSIDE
 * the target radius by the time alpha decays. Raising only the mode-scoped
 * radial strength tightens the equilibrium toward the target without
 * touching any shared force. 0.85 was tuned against the real worker settle
 * at the default N=1500 fixture (see orbitalSettleFraming.test.ts): settled
 * max node distance lands within ~10% of the 400-unit target instead of
 * ~17% over. Exported (never re-literaled inline in the worker) per this
 * file's single-source-of-truth convention.
 */
export const ORBITAL_RADIAL_STRENGTH = 0.85;

/**
 * Escalation remediation round 8, Fix B (companion to
 * `ORBITAL_RADIAL_STRENGTH` above; the same live diagnostic's cause b):
 * mode-scoped padding scale for the WHOLE-GRAPH SETTLE FIT's DISTANCE while
 * Orbital is the active mode -- supplied ONLY by Graph3DScene's settle
 * handler via `GraphFitRequest.paddingScale`, never by any selection-fit
 * path (selection fit stays untouched even in Orbital) and never consulted
 * by the protected Terrain flat-shape fit branch. Round 1 of this escalation
 * regressed axis-avoidance by changing fit DIRECTION composition and was
 * fully reverted in round 2; this constant deliberately touches DISTANCE
 * only, behind an opt-in request field no other path supplies (byte-identity
 * for every non-opted-in path is proven bit-for-bit in
 * cameraFitPaddingByteIdentity.test.ts).
 *
 * Why a scale can be safe for Orbital's whole-graph fit specifically:
 * `computeBoundingSphere` uses the AABB half-diagonal as the fit radius --
 * a systematic overestimate of the true circumscribing sphere of a
 * ball-shaped shell system. Measured overestimate ratios (half-diagonal /
 * true max node distance from the AABB center): ~1.53 at the round-start
 * live diagnostic (714.71 vs ~467, pre-Fix-A), ~1.57 on the real
 * post-Fix-A N=1500 settle, and ~1.12 at demo-vault scale (N=24) -- all
 * measured in orbitalSettleFraming.test.ts against the REAL worker settle,
 * never assumed. At 0.70 the effective padding is
 * 0.70 x FIT_PADDING(1.35) = 0.945 of the half-diagonal, which PROVABLY
 * fits every node in the vertical frustum whenever that overestimate ratio
 * is >= ~1.06 (1 / 0.945).
 *
 * Round 9 correction (Verifier's independent physics reproduction of round
 * 8): that ratio condition is NOT universal -- it is a property of the
 * dataset's settled shape, and at small/sparse N it provably fails. For
 * N=2 (a single linked pair) the AABB half-diagonal IS the true max node
 * distance (ratio exactly 1.000, mathematically inevitable for 2 points),
 * and a measured N=6 (2 communities, isolated pairs) settle also lands at
 * exactly 1.000 -- both far below the ~1.06 threshold, and a blanket 0.70
 * scale there parks the camera close enough that real nodes leave the
 * frustum (reproduced from real sampled view directions in
 * orbitalSettleFraming.test.ts). Orbital mode has no node-count gate, so
 * any small/early-stage vault reached that regime in production.
 *
 * The scale is therefore applied ADAPTIVELY, per settle, by
 * `orbitalSettleFitPaddingScale` below: Graph3DScene's settle handler
 * measures the LIVE ratio from the actual settled positions
 * (`computeBoundingSphere`'s own `maxNodeDistance` field -- real data,
 * never an estimate) and applies the 0.70 reduction only when the measured
 * ratio clears `ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO`; otherwise the fit
 * falls back to the unscaled (paddingScale 1, bit-identical pre-round-8)
 * distance, which is zero-clip for EVERY shape (unscaled FIT_PADDING 1.35
 * >= 1 covers even a ratio of exactly 1). 0.70 remains the LARGEST
 * reduction that keeps the guarantee in the regimes that clear the
 * threshold -- a tighter 0.65 was tried in round 8 and MEASURED to cross
 * under the demo-vault regime's ~1.12 ratio. Net effect at the default
 * N=1500 fixture (live ratio ~1.53-1.57, comfortably above threshold, so
 * the scale still applies there), combined with Fix A: the settle camera
 * moves from the round-start 1500-unit clamp to ~1038 world units at the
 * live fov 75 (~31% closer; ~1.4x on-screen linear size, ~2.1x area) while
 * keeping ~48% margin over the exact sphere-in-frustum minimum for the
 * true settled node ball. Small/sparse graphs below the threshold simply
 * keep the pre-round-8 framing -- an accepted tradeoff: the visual-size
 * problem this escalation exists to fix is specifically the many-community
 * large-graph regime. Cloud/Strata/Terrain settle fits never receive this
 * scale and remain bit-identical.
 */
export const ORBITAL_SETTLE_FIT_PADDING_SCALE = 0.7;

/**
 * Round 9: the minimum LIVE-measured AABB-half-diagonal /
 * true-max-node-distance overestimate ratio at which applying
 * `ORBITAL_SETTLE_FIT_PADDING_SCALE` is provably zero-clip. Derivation
 * (round 8's own safety math, now enforced per settle instead of assumed
 * universal): every settled node lies within `maxNodeDistance` of the fit
 * center, and the scaled fit distance is
 * `radius x FIT_PADDING(1.35) x 0.70 / sin(fov/2)`, so the exact
 * sphere-in-frustum condition `distance x sin(fov/2) >= maxNodeDistance`
 * holds whenever `radius / maxNodeDistance >= 1 / (1.35 x 0.70) =~ 1.058`.
 * 1.06 adds a small safety margin on top; the consistency invariant
 * (this constant >= the exact bound) is pinned in
 * cameraFitPaddingByteIdentity.test.ts.
 */
export const ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO = 1.06;

/**
 * Round 9 (Verifier's exact specified remediation): the shape-adaptive
 * padding-scale decision for Orbital's whole-graph settle fit. Returns
 * `ORBITAL_SETTLE_FIT_PADDING_SCALE` only when the live overestimate ratio
 * (fit radius / true max settled node distance from the fit center, both
 * measured from the REAL settled dataset by `computeBoundingSphere`)
 * safely clears `ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO`; otherwise `undefined`
 * -- which `GraphFitRequest.paddingScale` treats bit-identically to the
 * pre-round-8 unscaled fit (see cameraFitPaddingByteIdentity.test.ts), the
 * zero-clip-for-every-shape fallback. A missing/degenerate
 * `maxNodeDistance` (no live measurement, or a single-point cloud) also
 * falls back to unscaled: the reduction is an opt-in optimization that is
 * only ever taken on affirmative live evidence.
 */
export function orbitalSettleFitPaddingScale(
  fitRadius: number,
  maxNodeDistance: number | undefined,
): number | undefined {
  if (maxNodeDistance === undefined || !(maxNodeDistance > 0) || !Number.isFinite(fitRadius)) {
    return undefined;
  }
  return fitRadius / maxNodeDistance >= ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO
    ? ORBITAL_SETTLE_FIT_PADDING_SCALE
    : undefined;
}

/** Strata: nodes stack into horizontal layers keyed by hierarchy `level` (0 = coarsest, sits lowest). Exported (T3-advised escalation remediation round 2) for the same spacing-derived level-wall chrome height reuse as `ORBITAL_SHELL_SPACING` above. */
export const STRATA_LAYER_SPACING = 70;

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
