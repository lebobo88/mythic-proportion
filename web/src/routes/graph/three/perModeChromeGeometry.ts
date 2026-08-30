// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-ORBITAL/J-STRATA journeys): pure, dependency-free placement math for the
// new per-mode chrome layer (`OrbitalChrome.tsx`/`StrataChrome.tsx`), kept
// separate from those R3F components so it is directly unit-testable without
// a real WebGL context -- this directory's established convention
// (`terrainElevation.ts`, `modeForces.ts`).
//
// Both helpers below deliberately REUSE `orbitalRadiusForNode`/
// `strataLayerY` from `modeForces.ts` rather than re-deriving the shell-
// radius/layer-Y formulas independently -- the chrome (rings, floor planes)
// must always agree with wherever the worker's own physics actually places
// a community/level's nodes, never a second, independently-tuned copy of
// the same formula (Section 5.6's single-source-of-truth discipline,
// applied here to geometry rather than color).
import { orbitalRadiusForNode, orbitalShellSpacing, strataLayerY, STRATA_LAYER_SPACING } from "./modeForces";

/**
 * One concentric-shell radius per community, 0..communityCount-1, in the
 * SAME units/formula `orbitalRadiusForNode` already uses for the worker's
 * own radial force target -- so the decorative orbit-ring chrome always sits
 * exactly where that community's shell actually settles, never drifting out
 * of alignment with the real physics.
 */
export function orbitalRingRadii(communityCount: number): number[] {
  if (communityCount <= 0) return [];
  return Array.from({ length: communityCount }, (_, community) => orbitalRadiusForNode({ community }, communityCount));
}

/**
 * Round-7 escalation remediation (explicit USER DESIGN DECISION after a live
 * runtime diagnostic proved rounds 1-6's math correct but structurally
 * ceiling-limited): the number of visual "shell bands" Orbital renders.
 * With the real default fixture's 39 communities packed into the
 * camera-frameable radius (outermost pinned at 400 -- round 4), one ring
 * per community leaves only ~8.95 world units between adjacent rings, so
 * round 5's never-fuse invariant caps thickness at ~1.31px at the real
 * settle framing -- imperceptible BY CONSTRUCTION. The user chose to stop
 * rendering one ring per community and instead group nearby communities
 * into fewer, legibly thick bands. Safe because the rings are decorative
 * atmospheric chrome: per-community identity is redundantly carried by node
 * color/pattern, `CommunityCentroidBadges` (one badge per community,
 * untouched), labels, aria, the 2D fallback, and the a11y tree (plan
 * Section 5.8 -- no single channel is load-bearing).
 *
 * 10 (job target ~10-16, this writer's documented judgment): the LARGEST
 * count in that range whose uniform band gap (340 / (N-1)) still fits the
 * stricter of round 6's two screen-space floors -- the wall's 5px, needing
 * gap >= 2 * 5px * ~3.406 wu/px ~= 34.06 at the diagnostic framing -- under
 * the reused gap / 2 anti-fusion ceiling, so the FLOORS bind instead of the
 * ceiling. N = 10 gives gap = 340/9 ~= 37.78 (4.2x the prior 39-community
 * spacing); any N >= 11 would leave the wall ceiling-limited below its 5px
 * target, the exact defect this round removes. This also supersedes round
 * 3's MAX_ORBITAL_SHELL_RINGS = 32 cap and its visible-member-count
 * ranking outright (removed, not stacked): rendered rings are bounded at 10
 * by construction, and 10 bands x 2 objects = 20 sits far inside Section
 * 5.6 item 2's O(tens) chrome budget that the cap existed to enforce. See
 * `orbitalShellBanding.test.ts`.
 */
export const ORBITAL_SHELL_BAND_COUNT = 10;

export interface OrbitalShellBand {
  /** Band index 0..ORBITAL_SHELL_BAND_COUNT-1 (or 0..communityCount-1 in the identity regime) -- the stable render key. */
  band: number;
  radius: number;
  /** Community indices grouped into this band (ascending; a single community in the identity regime). Retained for testability -- every community belongs to exactly one band. */
  communities: number[];
}

/**
 * The banded ring/wall placement list `OrbitalChrome.tsx` renders from
 * (round 7 -- replaces the removed per-community `orbitalShellRings`):
 *
 *  - `communityCount <= ORBITAL_SHELL_BAND_COUNT`: IDENTITY banding -- one
 *    band per community at its exact `orbitalRadiusForNode` physics radius,
 *    byte-identical placement to every prior round's validated small
 *    scales (including zero-member communities, the pre-cap behavior).
 *  - Above the threshold: a uniformly re-spaced ladder of exactly
 *    `ORBITAL_SHELL_BAND_COUNT` band radii spanning the SAME
 *    [innermost, outermost] envelope the real shells occupy, each community
 *    assigned to its NEAREST band. The uniform ladder guarantees a CONSTANT
 *    inter-band gap for the anti-fusion sizing below (a
 *    largest-member-radius-per-bin representative could land two adjacent
 *    representatives near their shared bin boundary, collapsing the minimum
 *    gap back toward the old per-community spacing -- rejected for exactly
 *    that reason), and its end bands coincide with the true innermost/
 *    outermost shell radii so the band family still brackets the full real
 *    extent. Since the community ladder's own spacing is strictly smaller
 *    than the band gap here, every band is guaranteed non-empty. The
 *    identity -> banded transition is positionally seamless: spacing(10) is
 *    already 340/9, so the 10-community identity ladder IS the band ladder.
 */
export function orbitalShellBands(communityCount: number): OrbitalShellBand[] {
  const radii = orbitalRingRadii(communityCount);
  if (radii.length === 0) return [];
  if (radii.length <= ORBITAL_SHELL_BAND_COUNT) {
    return radii.map((radius, community) => ({ band: community, radius, communities: [community] }));
  }
  const innermost = radii[0];
  const gap = orbitalChromeBandGap(communityCount);
  const bands: OrbitalShellBand[] = Array.from({ length: ORBITAL_SHELL_BAND_COUNT }, (_, band) => ({
    band,
    radius: innermost + band * gap,
    communities: [],
  }));
  radii.forEach((radius, community) => {
    const nearest = Math.min(Math.max(Math.round((radius - innermost) / gap), 0), ORBITAL_SHELL_BAND_COUNT - 1);
    bands[nearest].communities.push(community);
  });
  return bands;
}

/**
 * The radial gap between ADJACENT RENDERED chrome elements -- the value the
 * round-5 anti-fusion discipline (an element consumes at most half its gap)
 * is measured against, round 7 onward. In the identity regime this is the
 * worker's own effective per-shell spacing (unchanged prior behavior); in
 * the banded regime it is the uniform band-ladder gap, derived from the
 * same `modeForces.ts` innermost/outermost single sources of truth the
 * physics uses. For any communityCount > ORBITAL_SHELL_BAND_COUNT the
 * outermost shell is pinned at the round-4 frameable cap, so this is a
 * CONSTANT 340/9 ~= 37.78 world units -- ring/wall thickness no longer
 * degrades as community count grows.
 */
export function orbitalChromeBandGap(communityCount: number): number {
  if (communityCount <= ORBITAL_SHELL_BAND_COUNT) return orbitalShellSpacing(communityCount);
  const innermost = orbitalRadiusForNode({ community: 0 }, communityCount);
  const outermost = orbitalOutermostShellRadius(communityCount) ?? innermost;
  return (outermost - innermost) / (ORBITAL_SHELL_BAND_COUNT - 1);
}

/**
 * The FULL physics extent's outermost shell radius, independent of the band
 * grouping: every community's nodes still orbit at their own
 * `orbitalRadiusForNode` radius (round 7's banding changes only the CHROME
 * representation, never the physics), so the ecliptic disc's outer edge and
 * the tube-thickness scaling (`orbitalRingTubeRadius` derives from this
 * same full extent internally, since framing distance grows with the WHOLE
 * system) must keep covering them. `null` when there are no shells.
 */
export function orbitalOutermostShellRadius(communityCount: number): number | null {
  const radii = orbitalRingRadii(communityCount);
  return radii.length > 0 ? radii[radii.length - 1] : null;
}

/** Thin, testable wrapper around `strataLayerY` for a bare `(level, levelCount)` pair -- the floor-plane chrome has no per-node object to pass, just the level index itself. */
export function strataFloorLevelY(level: number, levelCount: number): number {
  return strataLayerY({ level }, levelCount);
}

/**
 * The distinct set of `level` values actually present among `nodes` (missing
 * `level` treated as 0, matching `strataLayerY`'s own `node.level ?? 0`
 * fallback) -- so a floor plane is only rendered for a level that genuinely
 * has visible members (plan Section 5.1 J-STRATA: "An empty level renders no
 * plane"). Callers pass the already visible-filtered node set (Graph3DScene's
 * `renderedNodes`), so no separate `visibleIds` parameter is needed here.
 */
export function strataLevelsPresent(nodes: { level?: number }[]): Set<number> {
  const levels = new Set<number>();
  for (const node of nodes) levels.add(node.level ?? 0);
  return levels;
}

// ---------------------------------------------------------------------------
// T3-advised escalation remediation (plan Section 11's documented escalation
// track; live Browser Validator finding: Orbital/Strata chrome invisible).
// The helpers below are the pure halves of that fix -- see
// `perModeChromePresence.test.ts` for the full root-cause narratives.
// ---------------------------------------------------------------------------

/** Floor below which an orbit ring's tube radius never drops, so a tiny single-community system still renders a visible ring. The gap-fraction cap below still deliberately DOMINATES this floor (distinctness outranks thickness) -- though since round 7's banding pinned the banded-regime gap at ~37.78 world units, the cap can no longer compress anywhere near this floor in practice. */
const MIN_RING_TUBE_RADIUS = 0.45;
/** World-unit tube radius per (ring-width token unit x outermost-shell-radius unit) -- ties thickness to the shell system's own scale, since framing distance grows with that scale. */
const RING_TUBE_RADIUS_PER_SHELL_UNIT = 0.003;
/**
 * Round-5 escalation remediation (CODE_REVIEW finding, Verifier-confirmed):
 * ceiling on the tube radius as a fraction of the EFFECTIVE inter-shell
 * spacing -- tube DIAMETER never exceeds spacing / 2, so adjacent ring
 * surfaces always keep a clear radial gap of at least one full tube diameter
 * and can never fuse into a band (the round-2 `orbitalShellWallHeight`
 * spacing-derived-bound discipline, applied to the tube). Pre-fix, the
 * thickness formula tracked only the outermost radius, which round 4 capped
 * at a CONSTANT 400 for >= 9 communities -- so the 3.6-unit diameter
 * eventually overtook the still-compressing spacing (340/(N-1) < 3.6 from
 * N = 96), inside the plan's own mandated ~100-community stress scale.
 * spacing / 4 (not the wall's /3 mirror) so the cap first binds at N = 49:
 * counts <= 8 stay byte-identical AND the default fixture's 39 communities
 * -- the scale round 4's live re-check confirmed visible -- keep their exact
 * pre-round-5 thickness. See `orbitalRingTubeSpacing.test.ts`.
 *
 * Round 7: the gap this fraction is applied to is now
 * `orbitalChromeBandGap` -- the distance between adjacent RENDERED bands --
 * not the raw per-community `orbitalShellSpacing`, because banding is
 * exactly what changed which elements are adjacent. The invariant itself
 * (diameter <= gap / 2, one full clear diameter between surfaces) is
 * reused unchanged; see `orbitalShellBanding.test.ts`.
 */
const MAX_RING_TUBE_RADIUS_SPACING_FRACTION = 1 / 4;

/**
 * Round-6 escalation remediation (live runtime diagnostic -- actual
 * fiber-tree/THREE-object inspection of the running app, not source review):
 * rounds 1-5's world-space math was correct, but at the REAL default
 * settle-fit framing (camera ~1496 world units from the origin, fov 75,
 * ~674px viewport -> ~3.41 world units per pixel) the 3.6-unit tube diameter
 * projected to ~1.06px and the ~2.98-unit wall to ~0.87px: sub-pixel, hence
 * invisible regardless of correctness. These pixel targets are converted to
 * world-unit FLOORS at the live camera distance by `OrbitalChrome.tsx` via
 * `NodeLabels.tsx`'s `computeScreenSpaceWorldSize` -- the codebase's
 * established Phase 2 solution to exactly this problem class (a desired
 * on-screen pixel size expressed in camera-distance-aware world units) --
 * and passed into the two sizing helpers below. The anti-fusion spacing
 * ceilings always dominate the floors (see each helper), so no prior
 * round's never-fuse invariant regresses.
 *
 * Targets (judgment, documented): the ring is a thin high-alpha LINE -- ~2.5
 * device pixels reads clearly without turning the ring family into bands;
 * the wall is a large low-alpha translucent SURFACE whose edge-on band needs
 * more pixels than a line to register at ~0.28 opacity, hence 5.
 */
export const ORBITAL_RING_MIN_PX = 2.5;
export const ORBITAL_WALL_MIN_PX = 5;

/**
 * Orbit-ring torus tube radius, proportional to the OUTERMOST shell radius
 * (all rings share one thickness -- uniform, instrument-like), bounded above
 * by `MAX_RING_TUBE_RADIUS_SPACING_FRACTION` of the effective inter-shell
 * spacing (round 5 -- see that constant's rationale). Replaces the
 * old fixed `ringWidth * 0.15` (= 0.225 world units), which was far below
 * one physical pixel at the settle-fit framing distance real shell systems
 * produce (the confirmed-invisible value): the isotropic fit distance grows
 * linearly with the shell system's bounding radius, so a legible thickness
 * must grow with it too, not stay a constant multiple of a px-ish token.
 * Still token-responsive below the cap: `--graph-orbital-ring-width` scales
 * it linearly (the cap also bounds an oversized token -- no token value can
 * re-fuse the rings).
 *
 * Takes `communityCount` (round 5), NOT a caller-supplied radius: both the
 * outermost shell radius and the spacing are derived here from the same
 * `modeForces.ts` functions the worker physics consumes, so no call site can
 * ever feed a radius/spacing pair that drifts apart (the Section 5.6
 * single-source-of-truth discipline that caught this very bug).
 *
 * `minTubeDiameterWorld` (round 6) is the camera-distance-aware screen-space
 * legibility floor on the tube DIAMETER (see `ORBITAL_RING_MIN_PX` above):
 * a floor only, never an inflation -- up close it sits below the token-scaled
 * base and changes nothing. Where the floor and the round-5 ceiling conflict
 * (compressed spacing at high community counts), the CEILING WINS -- tube
 * diameter never exceeds spacing / 2, preserving round 5's never-fuse
 * invariant exactly. Rationale for ceiling-wins: dozens of shells compressed
 * into a small radial span can never each be several pixels thick without
 * fusing into the very band round 5 fixed; at those scales each ring still
 * gets the largest never-fusing thickness (~24% thicker than the diagnosed
 * sub-pixel value at the diagnostic framing), and overall legibility is
 * carried by the disc/wall/aggregate contrast instead. Defaults to 0 --
 * omitted, this is byte-identical round-5 behavior.
 */
export function orbitalRingTubeRadius(
  ringWidth: number,
  communityCount: number,
  minTubeDiameterWorld = 0,
): number {
  const outermostShellRadius = orbitalOutermostShellRadius(communityCount) ?? 0;
  const scaled = Math.max(
    MIN_RING_TUBE_RADIUS,
    ringWidth * outermostShellRadius * RING_TUBE_RADIUS_PER_SHELL_UNIT,
    minTubeDiameterWorld / 2,
  );
  return Math.min(scaled, orbitalChromeBandGap(communityCount) * MAX_RING_TUBE_RADIUS_SPACING_FRACTION);
}

/** Pre-remediation fixed Strata floor radius -- retained solely as the fallback before the first settle extent exists. */
const STRATA_FLOOR_FALLBACK_RADIUS = 200;
/** Never shrink a floor disc below this, even for a near-degenerate graph. */
const MIN_STRATA_FLOOR_RADIUS = 60;
/** Margin beyond the XZ half-diagonal so corner-most nodes sit visibly ON a floor, not at its lip. */
const STRATA_FLOOR_MARGIN = 1.05;

/**
 * Strata floor-disc radius derived from the whole-graph settle extent
 * (`computeBoundingSphere`'s `[dx, dy, dz]`, REUSED from the camera-fit
 * path -- never a second, independently-aggregated measurement). The XZ
 * half-diagonal covers the corner-most node of the axis-aligned settle box;
 * `dy` is ignored (floors are horizontal). `null`/`undefined` (no settle
 * yet) falls back to the pre-remediation fixed 200 -- the exact prior
 * behavior -- rather than guessing.
 */
export function strataFloorRadius(extent: [number, number, number] | null | undefined): number {
  if (!extent) return STRATA_FLOOR_FALLBACK_RADIUS;
  const [dx, , dz] = extent;
  const halfDiagonal = Math.hypot(dx, dz) / 2;
  return Math.max(MIN_STRATA_FLOOR_RADIUS, halfDiagonal * STRATA_FLOOR_MARGIN);
}

// ---------------------------------------------------------------------------
// T3-advised escalation remediation, round 2 (geometry-only redirect after
// round 1's camera-fit elevation approach was fully reverted for regressing
// the protected fit pipeline -- plan Section 5.6 item 5): Orbital/Strata
// chrome gains genuine Y-axis presence via short vertical cylinder "walls",
// so it is visible from the DEFAULT unmodified camera framing. A Y-normal
// disc/ring projects to (near-)zero screen area viewed edge-on no matter its
// size or opacity; a wall with real vertical extent cannot. Heights derive
// STRICTLY from the worker's own spacing constants (`modeForces.ts`) --
// never a new design token (which would need the design gate) and never an
// unrelated magic number. See `perModeChromeVerticalPresence.test.ts`.
// ---------------------------------------------------------------------------

/**
 * Round-6 ceiling on the wall height as a fraction of the effective shell
 * spacing: the screen-space legibility floor (below) may raise the wall
 * above round 2's exact spacing / 3 value, but never past spacing / 2 --
 * the same "an element never consumes more than half its spacing" bound
 * round 5 applied to the tube diameter, so from above, wall band and clear
 * gap still alternate at worst 1:1 and nested translucent bands never merge
 * into a solid mass. (Round 2's stricter gap >= 2x-height form pinned the
 * height at EXACTLY its own spacing / 3 ceiling, leaving zero headroom for
 * any legibility floor -- the live runtime diagnostic measured the result at
 * ~0.87px, sub-pixel, at the real default framing.)
 */
const MAX_WALL_HEIGHT_SPACING_FRACTION = 1 / 2;

/**
 * Orbital shell-wall height: 1/3 of the EFFECTIVE shell spacing (round-4
 * escalation remediation: the spacing itself now compresses at high
 * community counts so the whole shell system stays camera-frameable -- see
 * `orbitalShellSpacing`/`MAX_ORBITAL_OUTERMOST_RADIUS` in `modeForces.ts`
 * and `orbitalFrameableExtent.test.ts`). Wherever spacing is uncompressed
 * (<= 8 communities) this is exactly the round-2 value, 45 / 3 = 15 world
 * units.
 *
 * `minWallHeightWorld` (round 6) is the camera-distance-aware screen-space
 * legibility floor (see `ORBITAL_WALL_MIN_PX`), bounded above by
 * `MAX_WALL_HEIGHT_SPACING_FRACTION` -- ceiling-wins on conflict, same
 * documented reasoning as `orbitalRingTubeRadius`. Defaults to 0: omitted,
 * this is byte-identical round-2/4 behavior (exactly spacing / 3).
 */
export function orbitalShellWallHeight(communityCount: number, minWallHeightWorld = 0): number {
  // Round 7: measured against the gap between adjacent RENDERED bands
  // (identical to the per-shell spacing in the identity regime) -- see
  // `orbitalChromeBandGap`.
  const gap = orbitalChromeBandGap(communityCount);
  return Math.min(
    Math.max(gap / 3, minWallHeightWorld),
    gap * MAX_WALL_HEIGHT_SPACING_FRACTION,
  );
}

/**
 * Strata level-wall height: 1/4 of the 70-unit layer spacing = 17.5 world
 * units. The clear vertical gap between adjacent level bands stays 3x the
 * band height, so each level reads as a DISTINCT band at its own
 * `strataFloorLevelY` (reinforcing the vertical-stratification metaphor)
 * rather than the stack blurring into one solid column.
 */
export const STRATA_LEVEL_WALL_HEIGHT = STRATA_LAYER_SPACING / 4;
