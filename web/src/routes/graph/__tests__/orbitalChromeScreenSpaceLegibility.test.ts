// T3-advisory/Fable escalation remediation, round 6 (plan Section 11's
// documented escalation track; Section 5.1 J-ORBITAL). Rounds 1-5 fixed real
// world-space logic bugs and were all source-verified correct -- but a LIVE
// runtime diagnostic (React DevTools fiber walk + THREE object inspection of
// the actually-running app, not source reading) proved the remaining defect
// is SCALE/LEGIBILITY, not logic: at the real default settle framing
// (camera ~1496 world units from the origin, fov 75, ~674px viewport height
// -> ~3.41 world units per pixel) the ring tube (1.8-unit radius -> 3.6-unit
// diameter ~= 1.06px) and shell walls (~2.98 units ~= 0.87px) are sub-pixel,
// and the ecliptic disc (#263c54 at 0.18 opacity) is too low-contrast
// against the dark background to read at that range.
//
// FIX under test -- the SAME technique this codebase already shipped for
// exactly this problem class, `NodeLabels.tsx`'s `computeScreenSpaceWorldSize`
// (Phase 2's label screen-space minimum, hardened by the label-smear
// remediation): convert a desired on-screen PIXEL size into world units at
// the actual camera distance/fov/viewport, and use that as a legibility
// FLOOR on the tube diameter and wall height. The floor is bounded above by
// the existing anti-fusion ceilings so no prior round regresses:
//
//  - Tube: round 5's invariant is UNTOUCHED and still dominates -- tube
//    radius <= spacing / 4 (diameter <= spacing / 2, clear gap >= one full
//    diameter). Where the screen-space floor and the ceiling conflict
//    (compressed spacing at high community counts), the ceiling WINS:
//    distinctness outranks thickness, because 32+ shells compressed into a
//    ~100px radial span can never each be "several pixels" without fusing
//    into a band -- the exact round-5 defect. At those scales legibility is
//    carried by the aggregate (disc contrast + 32 near-cap rings/walls),
//    and each ring still gets measurably thicker than the diagnosed
//    sub-pixel value (1.31px vs 1.06px at the diagnostic framing).
//  - Wall: round 2 fixed the height at EXACTLY spacing / 3 (its
//    gap >= 2x-height rule's own ceiling), leaving zero headroom for any
//    floor. Round 6 keeps spacing / 3 as the no-floor base and lets the
//    screen-space floor raise it up to spacing / 2 -- the same "element
//    never consumes more than half its spacing" bound round 5 applied to
//    the tube, so from above, wall band and clear gap still alternate at
//    worst 1:1 and nested bands never merge into a solid mass. Where even
//    spacing / 2 is below the pixel floor (compressed spacing), the ceiling
//    wins, same reasoning as the tube.
//
// Reactivity choice (documented per the round-6 job): the floor is applied
// via a PER-FRAME, hysteresis-gated camera-distance track in
// OrbitalChrome.tsx (reusing `shouldRefreshLabelFontSize`'s >=10% gate), NOT
// a once-at-mount sample -- because the chrome mounts BEFORE the settle-fit
// camera animation finishes, so a one-shot sample would freeze the PRE-fit
// distance: the exact staleness failure mode the label-smear remediation
// already diagnosed and fixed for the font floor (see
// `shouldRefreshLabelFontSize`'s doc comment). Steady state performs zero
// setState; during a camera move the gate admits only material (>=10%)
// changes, and at compressed spacing the geometry args saturate at the
// spacing ceilings almost immediately, so R3F's arg diffing skips most
// geometry rebuilds anyway.
//
// Same pure-math + structural-wiring convention as
// `perModeChromePresence.test.ts` / `orbitalRingTubeSpacing.test.ts` (jsdom
// has no WebGL; the live rendered result remains the orchestrator's runtime
// diagnostic re-check to confirm).
//
// Round-7 postscript: at the real 39-community fixture these floors were
// still CEILING-limited (~1.31px) because one-ring-per-community left only
// ~8.95 world units of gap. The user-approved banding
// (orbitalShellBanding.test.ts) widened the gap between adjacent RENDERED
// elements to `orbitalChromeBandGap` (~37.78 at that scale), so every
// gap-derived expectation below is measured against the band gap; the
// floors themselves and the ceiling-wins fallback are unchanged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeScreenSpaceWorldSize } from "../three/NodeLabels";
import { orbitalShellSpacing } from "../three/modeForces";
import {
  ORBITAL_RING_MIN_PX,
  ORBITAL_WALL_MIN_PX,
  orbitalChromeBandGap,
  orbitalRingTubeRadius,
  orbitalShellWallHeight,
} from "../three/perModeChromeGeometry";

// The live diagnostic's exact runtime measurements (from the running app,
// not source-derived): camera ~1496 units from the origin at settle, the
// Canvas's fov 75, a 674px-high viewport. One specific real framing -- the
// fix must be robust across framings (see the near-camera and degenerate
// cases below), but this one must demonstrably stop being sub-pixel.
const DIAGNOSTIC_DISTANCE = 1496;
const DIAGNOSTIC_FOV_DEG = 75;
const DIAGNOSTIC_VIEWPORT_H = 674;
/** Default ?syntheticGraph=1500 fixture's real community count -- the scale the diagnostic session actually observed. */
const DIAGNOSTIC_COMMUNITY_COUNT = 39;
/** `--graph-orbital-ring-width`'s default token value. */
const DEFAULT_RING_WIDTH = 1.5;

/** World units that project to exactly one pixel at the given framing. */
function worldPerPixel(distance: number): number {
  return computeScreenSpaceWorldSize(distance, DIAGNOSTIC_FOV_DEG, DIAGNOSTIC_VIEWPORT_H, 1);
}

/** Mirrors OrbitalChrome.tsx's round-6 floor wiring for the tube: px target -> world diameter floor. */
function minTubeDiameterWorld(distance: number): number {
  return computeScreenSpaceWorldSize(distance, DIAGNOSTIC_FOV_DEG, DIAGNOSTIC_VIEWPORT_H, ORBITAL_RING_MIN_PX);
}

/** Mirrors OrbitalChrome.tsx's round-6 floor wiring for the wall: px target -> world height floor. */
function minWallHeightWorld(distance: number): number {
  return computeScreenSpaceWorldSize(distance, DIAGNOSTIC_FOV_DEG, DIAGNOSTIC_VIEWPORT_H, ORBITAL_WALL_MIN_PX);
}

describe("diagnostic reproduction -- the pre-round-6 (floorless) sizes really are sub-pixel at the REAL settle framing", () => {
  it("sanity: the diagnostic framing projects ~3.41 world units per pixel (2 * tan(fov/2) * distance / viewportHeight)", () => {
    expect(worldPerPixel(DIAGNOSTIC_DISTANCE)).toBeCloseTo(3.406, 2);
  });

  it("floorless tube diameter (round 5's confirmed-correct world-space math) projects to ~1.06px -- correct in world space, illegible on screen", () => {
    const floorlessDiameter = 2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, DIAGNOSTIC_COMMUNITY_COUNT);
    expect(floorlessDiameter).toBeCloseTo(3.6, 5);
    expect(floorlessDiameter / worldPerPixel(DIAGNOSTIC_DISTANCE)).toBeLessThan(1.1);
  });

  it("the PRE-banding floorless wall height (per-community spacing / 3, the round-6 diagnosis) projected to under one pixel; round 7's band gap alone already lifts the floorless wall to ~3.7px", () => {
    const preBandingWall = orbitalShellSpacing(DIAGNOSTIC_COMMUNITY_COUNT) / 3;
    expect(preBandingWall / worldPerPixel(DIAGNOSTIC_DISTANCE)).toBeLessThan(1);
    const floorlessWall = orbitalShellWallHeight(DIAGNOSTIC_COMMUNITY_COUNT);
    expect(floorlessWall).toBeCloseTo(orbitalChromeBandGap(DIAGNOSTIC_COMMUNITY_COUNT) / 3, 5);
    expect(floorlessWall / worldPerPixel(DIAGNOSTIC_DISTANCE)).toBeGreaterThan(3);
  });
});

describe("screen-space legibility floor at the diagnostic framing", () => {
  it("at uncompressed shell spacing (counts <= 8) the tube reaches the full pixel target -- several pixels, not sub-1", () => {
    for (const communityCount of [1, 5, 8]) {
      const diameter =
        2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, communityCount, minTubeDiameterWorld(DIAGNOSTIC_DISTANCE));
      const px = diameter / worldPerPixel(DIAGNOSTIC_DISTANCE);
      expect(px).toBeGreaterThanOrEqual(ORBITAL_RING_MIN_PX - 0.01);
    }
  });

  it("at uncompressed spacing the wall reaches its full pixel target too", () => {
    for (const communityCount of [1, 5, 8]) {
      const height = orbitalShellWallHeight(communityCount, minWallHeightWorld(DIAGNOSTIC_DISTANCE));
      const px = height / worldPerPixel(DIAGNOSTIC_DISTANCE);
      expect(px).toBeGreaterThanOrEqual(ORBITAL_WALL_MIN_PX - 0.01);
    }
  });

  it("at the diagnostic's own 39-community scale, round 7's band gap flips round 6's outcome: the FLOORS now bind (full 2.5px tube / 5px wall on screen), strictly inside the reused anti-fusion ceilings -- pre-banding, the ceilings won at ~1.31px", () => {
    const gap = orbitalChromeBandGap(DIAGNOSTIC_COMMUNITY_COUNT);
    const diameter =
      2 *
      orbitalRingTubeRadius(
        DEFAULT_RING_WIDTH,
        DIAGNOSTIC_COMMUNITY_COUNT,
        minTubeDiameterWorld(DIAGNOSTIC_DISTANCE),
      );
    expect(diameter).toBeCloseTo(minTubeDiameterWorld(DIAGNOSTIC_DISTANCE), 5); // the floor, exactly
    expect(diameter).toBeLessThan(gap / 2); // strictly under the ceiling
    expect(diameter / worldPerPixel(DIAGNOSTIC_DISTANCE)).toBeCloseTo(ORBITAL_RING_MIN_PX, 3);
    const wall = orbitalShellWallHeight(
      DIAGNOSTIC_COMMUNITY_COUNT,
      minWallHeightWorld(DIAGNOSTIC_DISTANCE),
    );
    expect(wall).toBeCloseTo(minWallHeightWorld(DIAGNOSTIC_DISTANCE), 5); // the floor, exactly
    expect(wall).toBeLessThan(gap / 2);
    expect(wall / worldPerPixel(DIAGNOSTIC_DISTANCE)).toBeCloseTo(ORBITAL_WALL_MIN_PX, 3);
  });

  it("the plan's own realistic Leiden ceiling (32 communities) gets the same full-floor legibility while respecting the ceilings", () => {
    const gap = orbitalChromeBandGap(32);
    const diameter = 2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, 32, minTubeDiameterWorld(DIAGNOSTIC_DISTANCE));
    expect(diameter).toBeLessThanOrEqual(gap / 2 + 1e-9);
    expect(diameter / worldPerPixel(DIAGNOSTIC_DISTANCE)).toBeGreaterThan(1.25);
  });
});

describe("anti-fusion invariants still hold WITH the screen-space floor active (round-5 sweep, extended)", () => {
  it("2..500 community sweep at the diagnostic framing: tube diameter never exceeds the rendered-band gap / 2, clear gap stays >= one full diameter, wall never exceeds gap / 2", () => {
    const tubeFloor = minTubeDiameterWorld(DIAGNOSTIC_DISTANCE);
    const wallFloor = minWallHeightWorld(DIAGNOSTIC_DISTANCE);
    for (let communityCount = 2; communityCount <= 500; communityCount++) {
      const gap = orbitalChromeBandGap(communityCount);
      const diameter = 2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, communityCount, tubeFloor);
      expect(diameter).toBeLessThanOrEqual(gap / 2 + 1e-9);
      expect(gap - diameter).toBeGreaterThanOrEqual(diameter - 1e-9);
      expect(orbitalShellWallHeight(communityCount, wallFloor)).toBeLessThanOrEqual(gap / 2 + 1e-9);
    }
  });

  it("the mandated ~100-community stress scale (?syntheticGraph=10000) holds with the floor active", () => {
    const gap = orbitalChromeBandGap(100);
    const diameter = 2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, 100, minTubeDiameterWorld(DIAGNOSTIC_DISTANCE));
    expect(diameter).toBeLessThanOrEqual(gap / 2 + 1e-9);
    expect(gap - diameter).toBeGreaterThanOrEqual(diameter - 1e-9);
  });

  it("an oversized floor (pathological camera distance) still cannot re-fuse the rings", () => {
    expect(2 * orbitalRingTubeRadius(DEFAULT_RING_WIDTH, 100, 10_000)).toBeLessThanOrEqual(
      orbitalChromeBandGap(100) / 2 + 1e-9,
    );
    expect(orbitalShellWallHeight(100, 10_000)).toBeLessThanOrEqual(orbitalChromeBandGap(100) / 2 + 1e-9);
  });
});

describe("the floor is a FLOOR, never an inflation -- near-camera and degenerate framings keep prior behavior", () => {
  it("dollied in (the diagnostic session's ~807-unit check, and closer): the token-scaled base thickness wins -- the floor never inflates a close-up view", () => {
    for (const distance of [807, 200]) {
      const tube = orbitalRingTubeRadius(
        DEFAULT_RING_WIDTH,
        DIAGNOSTIC_COMMUNITY_COUNT,
        minTubeDiameterWorld(distance),
      );
      // At 200 units the 2.5px floor (~1.14 world units) sits below the
      // base 1.8 -- exact pre-round-6 value. At 807 the floor (~4.6 world
      // units diameter) binds, comfortably inside the band-gap ceiling.
      if (distance === 200) expect(tube).toBe(1.8);
      expect(2 * tube).toBeLessThanOrEqual(orbitalChromeBandGap(DIAGNOSTIC_COMMUNITY_COUNT) / 2 + 1e-9);
    }
    // Wall at 200 units: the 5px floor (~2.28 world units) sits below the
    // gap/3 base, so the floorless band base wins.
    expect(
      orbitalShellWallHeight(DIAGNOSTIC_COMMUNITY_COUNT, minWallHeightWorld(200)),
    ).toBeCloseTo(orbitalChromeBandGap(DIAGNOSTIC_COMMUNITY_COUNT) / 3, 5);
  });

  it("omitting the floor argument is exactly the floorless base behavior (back-compat for every prior round's coverage; the base derives from the rendered-band gap since round 7)", () => {
    for (const count of [1, 8, 39, 96, 100]) {
      expect(orbitalRingTubeRadius(DEFAULT_RING_WIDTH, count)).toBe(orbitalRingTubeRadius(DEFAULT_RING_WIDTH, count, 0));
      expect(orbitalShellWallHeight(count)).toBe(orbitalChromeBandGap(count) / 3);
    }
  });

  it("a degenerate viewport/distance falls back through computeScreenSpaceWorldSize's own guard without breaking the geometry", () => {
    const degenerate = computeScreenSpaceWorldSize(DIAGNOSTIC_DISTANCE, DIAGNOSTIC_FOV_DEG, 0, ORBITAL_RING_MIN_PX);
    const tube = orbitalRingTubeRadius(DEFAULT_RING_WIDTH, DIAGNOSTIC_COMMUNITY_COUNT, degenerate);
    expect(Number.isFinite(tube)).toBe(true);
    expect(tube).toBeGreaterThan(0);
  });
});

function readSource(...segments: string[]): string {
  return readFileSync(join(__dirname, "..", ...segments), "utf-8");
}

describe("OrbitalChrome.tsx round-6 wiring (structural)", () => {
  const source = readSource("three", "OrbitalChrome.tsx");

  it("converts the pixel targets to world floors via NodeLabels' computeScreenSpaceWorldSize -- the established Phase 2 technique, never a second px->world formula", () => {
    expect(source).toMatch(/import \{ computeScreenSpaceWorldSize, shouldRefreshLabelFontSize \} from "\.\/NodeLabels"/);
    expect(source).toMatch(/computeScreenSpaceWorldSize\([\s\S]{0,120}ORBITAL_RING_MIN_PX/);
    expect(source).toMatch(/computeScreenSpaceWorldSize\([\s\S]{0,120}ORBITAL_WALL_MIN_PX/);
  });

  it("feeds the floors into the shared pure helpers (single source of truth -- no inline clamping at the call site)", () => {
    expect(source).toMatch(/orbitalRingTubeRadius\(chrome\.ringWidth, communityCount, minTubeDiameter\)/);
    expect(source).toMatch(/orbitalShellWallHeight\(communityCount, minWallHeight\)/);
  });

  it("tracks the camera's distance per frame with the label-floor hysteresis gate (never a once-at-mount sample, which would freeze the PRE-settle-fit distance -- the label-smear staleness class)", () => {
    expect(source).toMatch(/useFrame\(/);
    expect(source).toMatch(/shouldRefreshLabelFontSize\(/);
    expect(source).toMatch(/camera\.position\.length\(\)/);
  });
});

describe("disc/ring contrast against the dark theme (graph.css dark block + reader fallbacks stay mirrored)", () => {
  // The dark block (`:root, [data-theme="dark"]`) is the FIRST occurrence of
  // each orbital token in the file -- the diagnosed live values (#263c54 at
  // 0.18) came from exactly this block.
  const css = readFileSync(join(__dirname, "..", "..", "..", "styles", "tokens", "graph.css"), "utf-8");

  it("dark-theme disc opacity is raised to a legible level (>= 0.25; diagnosed invisible at 0.18)", () => {
    const match = css.match(/--graph-orbital-disc-opacity:\s*([\d.]+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(0.25);
  });

  it("dark-theme disc color is lifted out of the near-background lightness range (oklch L >= 0.45; diagnosed #263c54 ~= L 0.35)", () => {
    const match = css.match(/--graph-orbital-disc-color:\s*oklch\(([\d.]+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(0.45);
  });

  it("dark-theme ring color carries more alpha for the thin-line reading (>= 0.7; was 0.6 on a ~1px line)", () => {
    const match = css.match(/--graph-orbital-ring-color:\s*oklch\([\d. ]+\/\s*([\d.]+)\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(0.7);
  });

  it("graph-colors.ts fallback defaults mirror the raised dark-theme values (no token/fallback drift)", () => {
    const readerSource = readFileSync(join(__dirname, "..", "..", "..", "lib", "graph-colors.ts"), "utf-8");
    const opacityMatch = readerSource.match(/discOpacity:\s*([\d.]+)/);
    expect(opacityMatch).not.toBeNull();
    const cssOpacity = Number(css.match(/--graph-orbital-disc-opacity:\s*([\d.]+)/)![1]);
    expect(Number(opacityMatch![1])).toBeCloseTo(cssOpacity, 5);
  });
});
