// T3-advisory/Fable escalation remediation, round 7 (plan Section 11's
// documented escalation track; Section 5.1 J-ORBITAL, Section 5.8). Rounds
// 1-6 fixed every logic/positioning bug, but a live runtime diagnostic
// exposed the FUNDAMENTAL constraint no sizing formula can beat: the real
// default fixture has 39 communities, and packing 39 one-ring-per-community
// shells into the camera-frameable radius (outermost pinned at 400 by round
// 4's protected-fit envelope) leaves only 340/38 ~= 8.95 world units between
// adjacent rings -- so round 5's never-fuse invariant (element consumes at
// most HALF its gap) caps thickness near ~4.47 world units ~= 1.31px at the
// real settle framing. Imperceptibly thin, by construction, forever.
//
// USER DESIGN DECISION under test (explicit, round-7 job): STOP rendering one
// ring per community. GROUP nearby communities into a small number of visual
// "shell bands", each drawn as ONE clearly visible, legibly thick ring/wall.
// This is safe because per-community identity was never carried by the
// orbital rings: plan Section 5.8 states community identity is "redundantly
// carried by pattern, glyph, title, outline, aria, the 2D fallback, and the
// a11y tree, so no single channel failing is fatal" -- and Phase 2's
// CommunityCentroidBadges layer (untouched here) still gives every individual
// community its own badge. The rings are decorative atmospheric chrome.
//
// Banding strategy (this writer's documented judgment, per the job's
// latitude):
//  - ORBITAL_SHELL_BAND_COUNT = 10. The job targets ~10-16 bands; 10 is the
//    LARGEST count in that range whose uniform band gap still fits the
//    STRICTER of round 6's two screen-space floors (the wall's 5px) under
//    the reused gap / 2 anti-fusion ceiling at the diagnostic framing:
//    floor-binds needs gap >= 2 * 5px * ~3.406 wu/px ~= 34.06, and
//    gap(N) = 340/(N-1) >= 34.06 forces N <= 10.98. N = 10 gives
//    gap = 340/9 ~= 37.78 world units -- 4.2x the prior ~8.95-unit
//    per-community spacing at 39 communities -- so BOTH round-6 floors bind
//    (tube 2.5px with ~2.2x ceiling headroom, wall 5px with ~11% headroom)
//    instead of the ceiling. Any N >= 11 would leave the wall
//    ceiling-limited below its 5px target: the exact defect this round
//    exists to remove.
//  - Bands are a uniformly re-spaced ladder spanning the SAME
//    [innermost, outermost] envelope the real shells occupy
//    (b_i = 60 + i * (outermost - 60) / 9), each community assigned to its
//    NEAREST band. Rejected alternative -- "largest member community's actual
//    radius per bin" -- lets two adjacent bins' representatives land near
//    their shared boundary, collapsing the minimum gap back toward the old
//    per-community spacing and defeating the whole round; the uniform ladder
//    yields a provably CONSTANT gap the reused anti-fusion formula consumes
//    directly. The innermost/outermost bands coincide exactly with the true
//    innermost/outermost shell radii, so the band family still visually
//    brackets the full real system extent.
//  - communityCount <= 10 keeps IDENTITY banding: one band per community at
//    its exact physics radius -- rounds 2-5's validated small scales stay
//    byte-identical. The 10 -> 11 transition is positionally seamless:
//    spacing(10) = 340/9 is already the band gap, so the 10-community
//    identity ladder IS the band ladder.
//  - The round-3 MAX_ORBITAL_SHELL_RINGS = 32 cap is REMOVED, not stacked:
//    banding caps rendered rings at 10 (< 32) by construction, so the cap
//    and its visible-member-count ranking became dead code (the round-7
//    job's own don't-leave-redundant-mechanisms instruction). Its O(tens)
//    chrome-budget guarantee is re-asserted here against the bands.
//
// Same pure-math + structural-wiring convention as the prior rounds' files
// (jsdom has no WebGL; the live rendered result remains the orchestrator's
// runtime-diagnostic re-check to confirm).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orbitalRadiusForNode, orbitalShellSpacing } from "../three/modeForces";
import { computeScreenSpaceWorldSize } from "../three/NodeLabels";
import {
  ORBITAL_RING_MIN_PX,
  ORBITAL_SHELL_BAND_COUNT,
  ORBITAL_WALL_MIN_PX,
  orbitalChromeBandGap,
  orbitalOutermostShellRadius,
  orbitalRingRadii,
  orbitalRingTubeRadius,
  orbitalShellBands,
  orbitalShellWallHeight,
} from "../three/perModeChromeGeometry";
import { generateSyntheticGraph } from "../synthetic";

/** Default ?syntheticGraph=1500 fixture's real community count -- the scale every live diagnostic session actually observed. */
const REAL_FIXTURE_COMMUNITY_COUNT = 39;
/** The plan's mandated ?syntheticGraph=10000 stress scale. */
const STRESS_COMMUNITY_COUNT = 100;
/** `--graph-orbital-ring-width`'s default token value (graph.css). */
const DEFAULT_RING_WIDTH = 1.5;

// The live diagnostic's real settle framing (round 6's measured values).
const DIAGNOSTIC_DISTANCE = 1496;
const DIAGNOSTIC_FOV_DEG = 75;
const DIAGNOSTIC_VIEWPORT_H = 674;

function worldPerPixel(): number {
  return computeScreenSpaceWorldSize(DIAGNOSTIC_DISTANCE, DIAGNOSTIC_FOV_DEG, DIAGNOSTIC_VIEWPORT_H, 1);
}

function minTubeDiameterWorld(): number {
  return computeScreenSpaceWorldSize(DIAGNOSTIC_DISTANCE, DIAGNOSTIC_FOV_DEG, DIAGNOSTIC_VIEWPORT_H, ORBITAL_RING_MIN_PX);
}

function minWallHeightWorld(): number {
  return computeScreenSpaceWorldSize(DIAGNOSTIC_DISTANCE, DIAGNOSTIC_FOV_DEG, DIAGNOSTIC_VIEWPORT_H, ORBITAL_WALL_MIN_PX);
}

function readSource(...segments: string[]): string {
  return readFileSync(join(__dirname, "..", ...segments), "utf-8");
}

describe("orbitalShellBands -- grouping (perModeChromeGeometry.ts)", () => {
  it("the band count target is the job's ~10-16 range", () => {
    expect(ORBITAL_SHELL_BAND_COUNT).toBeGreaterThanOrEqual(10);
    expect(ORBITAL_SHELL_BAND_COUNT).toBeLessThanOrEqual(16);
  });

  it("THE FIX'S PREMISE: at the real 39-community fixture, materially fewer rendered rings (exactly the band count) with a materially larger inter-band gap (> 4x the prior ~8.95-unit per-community spacing)", () => {
    const bands = orbitalShellBands(REAL_FIXTURE_COMMUNITY_COUNT);
    expect(bands.length).toBe(ORBITAL_SHELL_BAND_COUNT);
    expect(bands.length).toBeLessThan(REAL_FIXTURE_COMMUNITY_COUNT / 3);
    const gap = orbitalChromeBandGap(REAL_FIXTURE_COMMUNITY_COUNT);
    expect(gap).toBeCloseTo(340 / 9, 4); // 37.78 world units
    expect(orbitalShellSpacing(REAL_FIXTURE_COMMUNITY_COUNT)).toBeCloseTo(340 / 38, 4); // the prior 8.95
    expect(gap / orbitalShellSpacing(REAL_FIXTURE_COMMUNITY_COUNT)).toBeGreaterThan(4);
    // The band ladder's uniform gap really is what adjacent rendered bands
    // are separated by.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].radius - bands[i - 1].radius).toBeCloseTo(gap, 6);
    }
  });

  it("bands partition ALL communities, in order, each assigned to its NEAREST band -- no community is dropped, only its ring representation is grouped", () => {
    const bands = orbitalShellBands(REAL_FIXTURE_COMMUNITY_COUNT);
    const gap = orbitalChromeBandGap(REAL_FIXTURE_COMMUNITY_COUNT);
    const all = bands.flatMap((band) => band.communities);
    expect(all).toEqual(Array.from({ length: REAL_FIXTURE_COMMUNITY_COUNT }, (_, c) => c));
    for (const band of bands) {
      expect(band.communities.length).toBeGreaterThanOrEqual(1); // no empty/ghost bands
      for (const community of band.communities) {
        const shellRadius = orbitalRadiusForNode({ community }, REAL_FIXTURE_COMMUNITY_COUNT);
        expect(Math.abs(shellRadius - band.radius)).toBeLessThanOrEqual(gap / 2 + 1e-9);
      }
    }
  });

  it("the band family still brackets the full real system extent: innermost/outermost bands sit exactly at the true innermost/outermost shell radii", () => {
    for (const communityCount of [REAL_FIXTURE_COMMUNITY_COUNT, STRESS_COMMUNITY_COUNT]) {
      const bands = orbitalShellBands(communityCount);
      expect(bands[0].radius).toBe(orbitalRadiusForNode({ community: 0 }, communityCount));
      expect(bands[bands.length - 1].radius).toBe(orbitalOutermostShellRadius(communityCount)!);
    }
  });

  it("communityCount <= the band count keeps IDENTITY banding -- one band per community at its exact physics radius (rounds 2-5's validated small scales stay byte-identical)", () => {
    for (const communityCount of [1, 4, 8, ORBITAL_SHELL_BAND_COUNT]) {
      const bands = orbitalShellBands(communityCount);
      expect(bands.length).toBe(communityCount);
      bands.forEach((band, community) => {
        expect(band.radius).toBe(orbitalRadiusForNode({ community }, communityCount));
        expect(band.communities).toEqual([community]);
      });
    }
  });

  it("the identity -> banded transition is positionally seamless: the 11-community band ladder occupies exactly the 10-community identity ladder's radii", () => {
    const identity = orbitalRingRadii(ORBITAL_SHELL_BAND_COUNT);
    const banded = orbitalShellBands(ORBITAL_SHELL_BAND_COUNT + 1).map((band) => band.radius);
    expect(banded.length).toBe(identity.length);
    banded.forEach((radius, i) => expect(radius).toBeCloseTo(identity[i], 9));
  });

  it("returns an empty array for zero/negative community counts rather than throwing (matches orbitalRingRadii)", () => {
    expect(orbitalShellBands(0)).toEqual([]);
    expect(orbitalShellBands(-3)).toEqual([]);
  });

  it("at the plan's mandated 100-community stress scale: still exactly the band count, every band non-empty, and the SAME gap as at 39 -- band geometry is count-independent once the outermost shell pins at the frameable cap", () => {
    const bands = orbitalShellBands(STRESS_COMMUNITY_COUNT);
    expect(bands.length).toBe(ORBITAL_SHELL_BAND_COUNT);
    for (const band of bands) expect(band.communities.length).toBeGreaterThanOrEqual(1);
    expect(orbitalChromeBandGap(STRESS_COMMUNITY_COUNT)).toBeCloseTo(
      orbitalChromeBandGap(REAL_FIXTURE_COMMUNITY_COUNT),
      9,
    );
  });

  it("subsumes the removed round-3 cap's O(tens) chrome-budget guarantee at the plan's own 10k stress fixture: 10 bands x 2 objects = 20, far under the old 64 ceiling", () => {
    const graph = generateSyntheticGraph({ nodeCount: 10_000, avgDegree: 4, seed: 42 });
    const communityCount =
      1 + (graph.nodes as { community?: number }[]).reduce((max, n) => Math.max(max, n.community ?? 0), 0);
    expect(communityCount).toBe(STRESS_COMMUNITY_COUNT); // the exact scale round 3 flagged
    const bands = orbitalShellBands(communityCount);
    expect(bands.length * 2).toBe(20);
    expect(bands.length * 2).toBeLessThanOrEqual(64);
  });
});

describe("sizing against the BAND gap -- the actual fix confirmation (round 6's floors now bind, not the ceilings)", () => {
  it("at the real 39-community fixture and the diagnostic framing, the tube's 2.5px screen-space floor BINDS, comfortably under the reused diameter <= gap/2 ceiling (was ceiling-limited at ~1.31px)", () => {
    const gap = orbitalChromeBandGap(REAL_FIXTURE_COMMUNITY_COUNT);
    const diameter =
      2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, REAL_FIXTURE_COMMUNITY_COUNT, minTubeDiameterWorld());
    expect(diameter).toBeCloseTo(minTubeDiameterWorld(), 6); // the floor, exactly -- not the ceiling
    expect(diameter).toBeLessThan(gap / 2); // strictly inside the anti-fusion ceiling
    expect(gap / 2 / diameter).toBeGreaterThan(2); // ~2.2x headroom
    expect(diameter / worldPerPixel()).toBeCloseTo(ORBITAL_RING_MIN_PX, 3); // full 2.5px on screen
  });

  it("the wall's 5px floor BINDS too, inside its gap/2 ceiling (the binding design constraint that set the band count at 10)", () => {
    const gap = orbitalChromeBandGap(REAL_FIXTURE_COMMUNITY_COUNT);
    const wall = orbitalShellWallHeight(REAL_FIXTURE_COMMUNITY_COUNT, minWallHeightWorld());
    expect(wall).toBeCloseTo(minWallHeightWorld(), 6); // the floor, exactly
    expect(wall).toBeLessThan(gap / 2); // ~11% headroom -- the tightest bound in this design
    expect(wall / worldPerPixel()).toBeCloseTo(ORBITAL_WALL_MIN_PX, 3); // full 5px on screen
  });

  it("the mandated 100-community stress scale gets the SAME legible sizes -- banding decoupled thickness from community count", () => {
    const d39 = 2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, REAL_FIXTURE_COMMUNITY_COUNT, minTubeDiameterWorld());
    const d100 = 2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, STRESS_COMMUNITY_COUNT, minTubeDiameterWorld());
    expect(d100).toBeCloseTo(d39, 9);
    expect(orbitalShellWallHeight(STRESS_COMMUNITY_COUNT, minWallHeightWorld())).toBeCloseTo(
      orbitalShellWallHeight(REAL_FIXTURE_COMMUNITY_COUNT, minWallHeightWorld()),
      9,
    );
  });

  it("round 5's anti-fusion invariant, re-verified against the band gap across a 2..500 sweep with the floors active: diameter <= gap/2, clear gap >= one full diameter, wall <= gap/2", () => {
    const tubeFloor = minTubeDiameterWorld();
    const wallFloor = minWallHeightWorld();
    for (let communityCount = 2; communityCount <= 500; communityCount++) {
      const gap = orbitalChromeBandGap(communityCount);
      const diameter = 2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, communityCount, tubeFloor);
      expect(diameter).toBeLessThanOrEqual(gap / 2 + 1e-9);
      expect(gap - diameter).toBeGreaterThanOrEqual(diameter - 1e-9);
      expect(orbitalShellWallHeight(communityCount, wallFloor)).toBeLessThanOrEqual(gap / 2 + 1e-9);
    }
  });

  it("a pathological oversized floor still cannot fuse the bands -- the ceiling-wins fallback survives the redesign", () => {
    const gap = orbitalChromeBandGap(STRESS_COMMUNITY_COUNT);
    expect(2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, STRESS_COMMUNITY_COUNT, 10_000)).toBeLessThanOrEqual(
      gap / 2 + 1e-9,
    );
    expect(orbitalShellWallHeight(STRESS_COMMUNITY_COUNT, 10_000)).toBeLessThanOrEqual(gap / 2 + 1e-9);
  });

  it("the floorless BASE thickness at 39 communities is untouched (1.8 tube radius) -- banding widened the ceiling headroom, it did not inflate the base", () => {
    expect(orbitalRingTubeRadius(DEFAULT_RING_WIDTH, REAL_FIXTURE_COMMUNITY_COUNT)).toBe(1.8);
  });
});

describe("OrbitalChrome.tsx round-7 wiring (structural)", () => {
  const source = readSource("three", "OrbitalChrome.tsx");

  it("renders rings/walls from the banded orbitalShellBands list -- never the per-community orbitalShellRings/orbitalRingRadii", () => {
    expect(source).toMatch(/orbitalShellBands\(/);
    expect(source).not.toMatch(/orbitalShellRings/);
    expect(source).not.toMatch(/orbitalRingRadii\(communityCount\)/);
  });

  it("keys ring and wall meshes by band identity", () => {
    expect(source).toMatch(/key=\{band\}/);
    expect(source).toMatch(/key=\{`wall-\$\{band\}`\}/);
  });

  it("the ecliptic disc still derives its outer radius from the FULL physics extent (orbitalOutermostShellRadius), so it visually contains every node including grouped communities' -- unaffected by banding", () => {
    expect(source).toMatch(/orbitalOutermostShellRadius\(communityCount\)/);
  });

  it("the round-3 cap and its visible-member ranking are genuinely removed, not left as dead code stacked under the banding", () => {
    const geometrySource = readSource("three", "perModeChromeGeometry.ts");
    // Declarations gone (historical doc-comment mentions are fine).
    expect(geometrySource).not.toMatch(/export const MAX_ORBITAL_SHELL_RINGS/);
    expect(geometrySource).not.toMatch(/export function orbitalShellRings/);
    expect(geometrySource).not.toMatch(/export interface OrbitalShellRing\b/);
    // With ring selection gone, OrbitalChrome no longer consumes the node
    // list at all -- ModeChrome only routes it to Strata's level presence.
    expect(source).not.toMatch(/nodes[,:}]/);
    expect(source).not.toMatch(/VizNode/);
    const modeChromeSource = readSource("three", "ModeChrome.tsx");
    expect(modeChromeSource).toMatch(/<OrbitalChrome colors=\{colors\} communityCount=\{communityCount\} opacity=\{opacity\} \/>/);
    expect(modeChromeSource).toMatch(/<StrataChrome[\s\S]{0,300}nodes=\{nodes\}/);
  });
});

describe("orbitalOutermostShellRadius (full-extent coverage retained from the removed round-3 cap file)", () => {
  it("reports the FULL physics extent's outermost shell -- grouped communities' nodes still orbit out there, so disc sizing must keep covering them", () => {
    expect(orbitalOutermostShellRadius(STRESS_COMMUNITY_COUNT)).toBe(
      orbitalRadiusForNode({ community: STRESS_COMMUNITY_COUNT - 1 }, STRESS_COMMUNITY_COUNT),
    );
    const radii = orbitalRingRadii(8);
    expect(orbitalOutermostShellRadius(8)).toBe(radii[radii.length - 1]);
  });

  it("returns null when there are no shells at all", () => {
    expect(orbitalOutermostShellRadius(0)).toBeNull();
  });
});

describe("Phase 2 per-community identity channels remain intact (Section 5.8 redundancy -- the grounding for this simplification)", () => {
  it("CommunityCentroidBadges still renders one badge per community from its own uncapped-until-60 selection, independent of the ring banding", () => {
    const source = readSource("three", "CommunityCentroidBadges.tsx");
    expect(source).toMatch(/MAX_CENTROID_BADGES/);
    expect(source).not.toMatch(/orbitalShellBands|ORBITAL_SHELL_BAND_COUNT/);
  });
});
