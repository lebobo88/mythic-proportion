// T3-advised escalation remediation, round 2 (plan Section 11's documented
// "T3 Opus advisory + Fable engineering pass" track; Section 5.1
// J-ORBITAL/J-STRATA). Round 1 tried to fix the "Orbital/Strata chrome
// invisible from the default framing" Browser Validator finding by lifting
// the CAMERA (a fit-pipeline minimum-elevation floor) -- which regressed the
// plan's single most protected invariant (Section 5.6 item 5: camera-fit/
// axis-avoidance composition in CameraRig.tsx; J-001/J-002/J-003). Round 2
// fully reverts that approach (CameraRig.tsx is byte-identical to its
// pre-round-1 state again) and instead gives the CHROME genuine Y-axis
// presence: a short vertical open-ended cylinder "wall" per orbital shell /
// per present strata level, visible from ANY near-horizontal viewing angle
// -- because a surface with real vertical extent, unlike a Y-normal
// disc/ring, never projects to zero screen area edge-on. Zero camera-fit
// changes.
//
// Wall heights are derived STRICTLY from the existing worker-physics spacing
// constants (`modeForces.ts` -- the same single-source-of-truth discipline
// the shell radii/layer Ys already follow), never a new design token (a
// genuinely new token would need to route through the design gate, out of
// this remediation's scope) and never an unrelated magic number:
//
//  - Orbital: 1/3 of the EFFECTIVE shell spacing (round-4 escalation
//    remediation made the spacing itself compress at high community counts
//    so the shell system stays camera-frameable -- see
//    orbitalFrameableExtent.test.ts). Wherever spacing is uncompressed
//    (<= 8 communities) this is exactly the round-2 value, 45 / 3 = 15
//    world units. At EVERY scale adjacent shell walls keep a clear radial
//    gap of at least 2x the wall height, so nested translucent bands never
//    visually merge into one mass.
//  - Strata: STRATA_LAYER_SPACING / 4 = 17.5 world units. Adjacent level
//    bands keep a 52.5-unit clear vertical gap (3x the band height), so each
//    level reads as a distinct band AT its own strataFloorLevelY -- directly
//    reinforcing the vertical-stratification metaphor rather than blurring
//    into a solid column.
//
// Same pure-math + structural-wiring convention as
// `perModeChromePresence.test.ts` (jsdom has no WebGL context; the walls'
// live rendered visibility remains Browser Validator's to confirm).
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Round-7 postscript: the user-approved shell BANDING
// (orbitalShellBanding.test.ts) means Orbital renders at most
// ORBITAL_SHELL_BAND_COUNT ring/wall pairs, so the "spacing" the orbital
// wall derives from is now `orbitalChromeBandGap` -- the gap between
// adjacent RENDERED bands (identical to `orbitalShellSpacing` at <= 10
// communities, where every assertion below is byte-identical to round 2).
// The 1/3 fraction and the never-merge discipline are reused unchanged.
import { describe, expect, it } from "vitest";
import {
  orbitalChromeBandGap,
  orbitalShellWallHeight,
  STRATA_LEVEL_WALL_HEIGHT,
} from "../three/perModeChromeGeometry";
import { ORBITAL_SHELL_SPACING, STRATA_LAYER_SPACING } from "../three/modeForces";

function readThreeSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("wall heights (perModeChromeGeometry.ts) -- spacing-derived, never a new token or unrelated magic number", () => {
  it("orbital shell-wall height is a bounded fraction (1/3) of the gap between adjacent RENDERED bands -- exactly the round-2 constant (15) wherever spacing is uncompressed", () => {
    expect(orbitalShellWallHeight(8)).toBe(ORBITAL_SHELL_SPACING / 3);
    for (const count of [1, 4, 8, 39, 100]) {
      expect(orbitalShellWallHeight(count)).toBe(orbitalChromeBandGap(count) / 3);
    }
  });

  it("strata level-wall height is a bounded fraction (1/4) of the worker's own layer spacing", () => {
    expect(STRATA_LEVEL_WALL_HEIGHT).toBe(STRATA_LAYER_SPACING / 4);
  });

  it("both walls are genuinely present (positive height) yet well under their spacing: the clear gap between adjacent shells/levels is at least 2x the wall height, so bands never visually merge (the FLOORLESS base form -- round 6's screen-space floor may raise the orbital wall to at most spacing / 2, its own documented ceiling; see orbitalChromeScreenSpaceLegibility.test.ts)", () => {
    for (const count of [1, 4, 8, 39, 100]) {
      expect(orbitalShellWallHeight(count)).toBeGreaterThan(0);
      // 1e-9 epsilon: at the banded scales the gap/3 base makes this an
      // EXACT equality, where one float ulp otherwise flips the comparison.
      expect(orbitalChromeBandGap(count) - orbitalShellWallHeight(count)).toBeGreaterThanOrEqual(
        2 * orbitalShellWallHeight(count) - 1e-9,
      );
    }
    expect(STRATA_LEVEL_WALL_HEIGHT).toBeGreaterThan(0);
    expect(STRATA_LAYER_SPACING - STRATA_LEVEL_WALL_HEIGHT).toBeGreaterThanOrEqual(2 * STRATA_LEVEL_WALL_HEIGHT);
  });
});

describe("OrbitalChrome.tsx shell walls (structural)", () => {
  const source = readThreeSource("OrbitalChrome.tsx");

  it("renders a vertical open-ended cylinder wall per shell radius, height from the shared spacing-derived helper", () => {
    // cylinderGeometry's Y axis is three.js's default -- no rotation prop on
    // the wall mesh means the wall is genuinely vertical.
    expect(source).toMatch(
      /cylinderGeometry args=\{\[radius, radius, wallHeight, \d+, 1, true\]\}/,
    );
    // ... and that height is the shared effective-spacing-derived helper,
    // fed the same communityCount the radii/physics use (round 4). Round 6
    // adds the camera-distance-aware screen-space legibility floor as a
    // second argument (live runtime diagnostic: spacing / 3 alone was
    // ~0.87px at the real default framing) -- the helper's own spacing / 2
    // ceiling keeps the round-2 never-merge discipline; see
    // orbitalChromeScreenSpaceLegibility.test.ts.
    expect(source).toMatch(/const wallHeight = orbitalShellWallHeight\(communityCount, minWallHeight\)/);
    // One wall per entry in the shell list (round 7: the BANDED
    // orbitalShellBands ladder -- same radii the flat rings use; see
    // orbitalShellBanding.test.ts) -- mapped, never a single hardcoded wall.
    expect(source.match(/bands\.map\(/g)?.length).toBe(2);
  });

  it("wall material follows the established chrome discipline: DoubleSide, depthWrite disabled, existing token composed ONLY with the cross-fade alpha (no token-alpha recompounding)", () => {
    const wallBlock = source.slice(source.indexOf("cylinderGeometry"));
    expect(wallBlock).toMatch(/side=\{DoubleSide\}/);
    expect(wallBlock).toMatch(/depthWrite=\{false\}/);
    expect(wallBlock).toMatch(/opacity=\{chrome\.discOpacity \* opacity\}/);
    // Round 1's opacity de-compounding discipline holds: never token alpha
    // times another token alpha.
    expect(source).not.toMatch(/discOpacity \* chrome\.\w+\.alpha/);
    expect(source).not.toMatch(/\.alpha \* chrome\.\w+Opacity/);
  });

  it("the flat ecliptic disc and flat orbit rings are retained as-is for the from-above reading (walls are additive)", () => {
    expect(source).toMatch(/ringGeometry/);
    expect(source).toMatch(/torusGeometry/);
  });
});

describe("StrataChrome.tsx level walls (structural)", () => {
  const source = readThreeSource("StrataChrome.tsx");

  it("replaces the flat (zero-Y-extent, edge-on-invisible) rim annulus with a vertical cylindrical wall at each present level's floorRadius and level Y", () => {
    // The old rim was a ringGeometry sharing the floor disc's flat rotation
    // -- confirmed by T3 to be unable to help edge-on visibility. Gone.
    expect(source).not.toMatch(/ringGeometry/);
    expect(source).toMatch(
      /cylinderGeometry args=\{\[floorRadius, floorRadius, STRATA_LEVEL_WALL_HEIGHT, FLOOR_SEGMENTS, 1, true\]\}/,
    );
    // The wall mesh is positioned at the level's own Y (a visible band AT
    // strataFloorLevelY) and carries no rotation prop (vertical axis).
    expect(source).toMatch(/<mesh position=\{\[0, y, 0\]\}>\s*<cylinderGeometry/);
  });

  it("wall material keeps the rim's own token (bandRimColor) composed ONLY with the cross-fade alpha, DoubleSide, depthWrite disabled", () => {
    const wallBlock = source.slice(source.indexOf("cylinderGeometry"));
    expect(wallBlock).toMatch(/color=\{chrome\.bandRimColor\.color\}/);
    expect(wallBlock).toMatch(/opacity=\{chrome\.bandRimColor\.alpha \* opacity\}/);
    expect(wallBlock).toMatch(/side=\{DoubleSide\}/);
    expect(wallBlock).toMatch(/depthWrite=\{false\}/);
  });

  it("the flat floor disc is retained for the top-down reading", () => {
    expect(source).toMatch(/circleGeometry args=\{\[floorRadius, FLOOR_SEGMENTS\]\}/);
  });
});
