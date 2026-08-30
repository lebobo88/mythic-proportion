// T3-advisory/Fable escalation remediation, round 5 (plan Section 11's
// documented escalation track; Section 5.1 J-ORBITAL: "orbit rings" PLURAL --
// distinct concentric shells). CODE_REVIEW finding, independently confirmed
// with exact math by Verifier:
//
// Round 4 bounded the shell ladder (`MAX_ORBITAL_OUTERMOST_RADIUS = 400`,
// `orbitalShellSpacing` compressing as 340/(N-1) for N > 8) so the whole
// system stays camera-frameable -- confirmed correct and NOT re-opened here.
// But `orbitalRingTubeRadius` still derived tube thickness from the now
// CAPPED-CONSTANT outermost radius: once communityCount >= 9 the outermost
// shell pins at 400, so `max(0.45, ringWidth(1.5) * 400 * 0.003)` = a
// CONSTANT 1.8 tube radius (3.6 diameter) -- while the inter-shell spacing
// keeps shrinking. Verifier's exact numbers: spacing(96) = 340/95 = 3.5789
// < 3.6, so from communityCount = 96 the tube DIAMETER exceeds the spacing
// and adjacent rings visually fuse into a band -- INSIDE the plan's own
// mandated ~100-community stress scale (?syntheticGraph=10000).
//
// FIX under test: `orbitalRingTubeRadius` now takes `communityCount` (not a
// caller-supplied radius that can drift from the spacing) and derives BOTH
// the outermost shell radius and the effective spacing from the same
// `modeForces.ts` single source of truth the worker physics uses. The
// shell-scale-proportional thickness is CAPPED at spacing / 4 -- i.e. tube
// diameter never exceeds HALF the effective inter-shell spacing, so adjacent
// ring surfaces always keep a clear radial gap of at least one full tube
// diameter and can never fuse (the round-2 `orbitalShellWallHeight`
// spacing-derived-bound discipline, applied to the tube). The cap dominates
// the 0.45 legibility floor via `Math.min` ordering, so the invariant holds
// at ANY community count, not just the mandated 100.
//
// Why spacing / 4 (diameter <= spacing / 2), not the wall's own /3 mirror:
// the cap must not alter any scale a Browser Validator pass already
// confirmed. spacing / 4 first binds at communityCount = 49 (spacing < 7.2),
// so counts <= 8 stay byte-identical (rounds 2-3's validated scales) AND the
// default ?syntheticGraph=1500 fixture's 39 communities -- the exact scale
// round 4's live re-check confirmed visible -- keeps its exact 1.8 radius.
// A /3-style diameter cap would bind from count 33 and re-thin the very
// rendering just validated. The wall's stricter gap >= 2x rule guards large
// 0.18-opacity translucent SURFACES from massing; the ring is a thin
// 0.6-alpha LINE whose failure mode is disappearing, so it keeps the largest
// thickness consistent with a never-fuse gap.
//
// Round-7 postscript: the user-approved shell BANDING
// (orbitalShellBanding.test.ts) changed WHICH elements are adjacent --
// rendered rings are now at most ORBITAL_SHELL_BAND_COUNT bands, so the
// never-fuse invariant under test here is measured against
// `orbitalChromeBandGap` (the gap between adjacent RENDERED bands;
// identical to `orbitalShellSpacing` at <= 10 communities). The formula
// itself -- diameter <= gap / 2 via the gap/4 tube-radius fraction -- is
// reused unchanged, per the round-7 job's own constraint.
import { describe, expect, it } from "vitest";
import {
  MAX_ORBITAL_OUTERMOST_RADIUS,
  orbitalShellSpacing,
} from "../three/modeForces";
import {
  orbitalChromeBandGap,
  orbitalOutermostShellRadius,
  orbitalRingTubeRadius,
} from "../three/perModeChromeGeometry";

/** `--graph-orbital-ring-width`'s default token value (graph.css), the value every prior round's framing math uses. */
const DEFAULT_RING_WIDTH = 1.5;

/**
 * The BASE (floorless) form of what OrbitalChrome.tsx feeds the torus
 * geometry for a given community count -- kept as a single wiring mirror so
 * every case below exercises the real call-site path, not a hand-fed radius.
 * (The RED run used the pre-fix wiring, `orbitalRingTubeRadius(width,
 * orbitalOutermostShellRadius(count) ?? 12)`, and failed with Verifier's
 * exact numbers: 3.6 !< 3.5789 at N = 96.) Round 6 added an optional
 * camera-distance-aware screen-space floor as a third call-site argument;
 * the spacing / 4 ceiling under test here still dominates that floor, and
 * the floored path has its own sweep in
 * orbitalChromeScreenSpaceLegibility.test.ts.
 */
function renderedTubeRadius(communityCount: number): number {
  return orbitalRingTubeRadius(DEFAULT_RING_WIDTH, communityCount);
}

describe("orbital ring tube diameter vs shell spacing (round-5 regression)", () => {
  it("sanity: reproduces Verifier's exact setup -- outermost shell pinned at the 400 cap while spacing keeps compressing through the overlap threshold", () => {
    expect(orbitalOutermostShellRadius(96)).toBe(MAX_ORBITAL_OUTERMOST_RADIUS);
    expect(orbitalOutermostShellRadius(100)).toBe(MAX_ORBITAL_OUTERMOST_RADIUS);
    expect(orbitalShellSpacing(96)).toBeCloseTo(340 / 95, 4); // 3.5789 -- first count under the pre-fix 3.6 diameter
    expect(orbitalShellSpacing(100)).toBeCloseTo(340 / 99, 4);
  });

  it("THE REGRESSION CASE: at N=96 (Verifier's overlap onset) and N=100 (the plan's mandated ?syntheticGraph=10000 stress scale), tube DIAMETER stays strictly under the gap between adjacent RENDERED elements (round 7: the band gap)", () => {
    for (const communityCount of [96, 100]) {
      const diameter = 2 * renderedTubeRadius(communityCount);
      expect(diameter).toBeLessThan(orbitalChromeBandGap(communityCount));
    }
  });

  it("holds at EVERY community count (2..500 sweep), with a clear radial gap of at least one full tube diameter between adjacent rendered ring surfaces -- rings never fuse into a band", () => {
    for (let communityCount = 2; communityCount <= 500; communityCount++) {
      const gap = orbitalChromeBandGap(communityCount);
      const diameter = 2 * renderedTubeRadius(communityCount);
      expect(diameter).toBeLessThan(gap);
      expect(gap - diameter).toBeGreaterThanOrEqual(diameter);
    }
  });

  it("the cap dominates the ring-width token too: an oversized --graph-orbital-ring-width cannot re-fuse the rings", () => {
    const gap = orbitalChromeBandGap(100);
    expect(2 * orbitalRingTubeRadius(10, 100)).toBeLessThan(gap);
  });
});

describe("visibility balance -- the fix must not reintroduce the round-4 'Orbital invisible' defect", () => {
  it("at the mandated 100-community stress scale the capped tube radius still meets the round-1 legibility floor (0.45)", () => {
    expect(renderedTubeRadius(100)).toBeGreaterThanOrEqual(0.45);
  });

  it("counts <= 8 (rounds 2-3's validated scales) keep their exact pre-round-5 values -- the byte-identical claim", () => {
    for (let communityCount = 1; communityCount <= 8; communityCount++) {
      const outermost = 60 + (communityCount - 1) * 45;
      expect(renderedTubeRadius(communityCount)).toBe(
        Math.max(0.45, DEFAULT_RING_WIDTH * outermost * 0.003),
      );
    }
  });

  it("the default ?syntheticGraph=1500 fixture's 39 communities -- the exact scale round 4's live Browser Validator re-check confirmed visible -- keeps its exact 1.8-unit floorless tube radius; since round 7's banding pinned the gap at 340/9, the ceiling never compresses the floorless base at ANY count anymore (pre-banding it re-thinned rings from N=49)", () => {
    for (const communityCount of [39, 48, 49, 100, 500]) {
      expect(renderedTubeRadius(communityCount)).toBe(1.8);
    }
  });
});
