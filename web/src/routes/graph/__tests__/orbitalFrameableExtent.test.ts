// T3-advisory/Fable escalation remediation, round 4 (plan Section 11's
// documented escalation track; Section 5.1 J-ORBITAL). Live Browser Validator
// finding: at the DEFAULT ?syntheticGraph=1500 fixture, Orbital mode showed
// "nothing but the raw node/edge cluster" -- no disc, no rings, no walls --
// while the equivalently-implemented Strata chrome was clearly visible.
//
// ROOT CAUSE (round-4 live reproduction, Playwright screenshots): the chrome
// WAS mounting and rendering (ring arcs visible at the frame's periphery) --
// the failure is the DEFAULT FRAMING. The 1500-node fixture deterministically
// produces 39 communities (clusterCount = max(4, round(sqrt(1500))) = 39,
// seed 1, every cluster non-empty), so `orbitalRadiusForNode`'s
// `60 + community * 45` ladder places the outermost shell at 1770 world
// units. Framing a 1770-radius system needs `computeFitDistance` ~3925 (live
// fov 75) / ~5654 (fov 50) -- but the settle fit hard-clamps at
// `MAX_FIT_DISTANCE = 1500` (CameraRig.tsx, a protected non-goal since
// round 1's revert), which parks the camera INSIDE the shell system. The
// default view is therefore a full-frame wall of nearby nodes/edges, with the
// ecliptic disc/rings/walls only at the periphery: exactly the validator's
// "raw node/edge cluster" screenshot. Rounds 2-3 were validated at 8
// communities (outermost 375, comfortably frameable), which is why this only
// surfaced at the real fixture's 39.
//
// FIX under test: the shell-radius ladder is bounded. `orbitalShellSpacing`
// compresses the per-shell spacing (never the 60-unit base) exactly enough
// that the outermost shell stays at or under `MAX_ORBITAL_OUTERMOST_RADIUS`
// (400), which keeps the whole system inside the frameable ceiling
// `MAX_FIT_DISTANCE * sin(fov/2) / FIT_PADDING` (~469 world units at the
// conservative fov 50; ~676 at the live fov 75) with node-jitter headroom.
// Both the worker physics (forceLayout.worker.ts) and the chrome
// (perModeChromeGeometry.ts) consume `orbitalRadiusForNode`, so layout and
// chrome compress together -- the single-source-of-truth discipline holds.
// At <= 8 communities (outermost <= 375) the ladder is byte-identical to the
// pre-fix behavior, preserving every scale rounds 2-3 already validated.
import { describe, expect, it } from "vitest";
import { computeFitDistance, FIT_PADDING, MAX_FIT_DISTANCE } from "../three/CameraRig";
import {
  MAX_ORBITAL_OUTERMOST_RADIUS,
  ORBITAL_SHELL_SPACING,
  orbitalRadiusForNode,
  orbitalShellSpacing,
} from "../three/modeForces";
import { orbitalChromeBandGap, orbitalOutermostShellRadius, orbitalShellWallHeight } from "../three/perModeChromeGeometry";
import { generateSyntheticGraph } from "../synthetic";

/** The DEFAULT dev fixture the live finding reproduced against. */
const DEFAULT_FIXTURE_NODE_COUNT = 1500;

/** Graph3DScene.tsx / forceLayout.worker.ts's shared communityCount derivation. */
function communityCountOf(nodes: { community?: number }[]): number {
  return 1 + nodes.reduce((max, n) => Math.max(max, n.community ?? 0), 0);
}

/** One legacy shell spacing of node-jitter headroom beyond the outermost shell TARGET -- settled nodes deviate from their radial-force target (same convention perModeChromePresence.test.ts already uses for its framing math). */
const NODE_JITTER_HEADROOM = 45;

describe("Orbital shell system stays frameable at the DEFAULT ?syntheticGraph=1500 fixture (round-4 live root cause)", () => {
  const { nodes } = generateSyntheticGraph({ nodeCount: DEFAULT_FIXTURE_NODE_COUNT });
  const communityCount = communityCountOf(nodes);

  it("sanity: the default fixture really produces the high community count the bug reproduced at (not the low count rounds 2-3 were tuned against)", () => {
    // clusterCount = max(4, round(sqrt(1500))) = 39, seed 1, all clusters hit.
    expect(communityCount).toBe(39);
  });

  it("THE REGRESSION CASE: the outermost shell's settle fit is NOT clamped at MAX_FIT_DISTANCE -- the camera can genuinely back out of the shell system (fov 50, CameraRig's own conservative fallback)", () => {
    const outermost = orbitalOutermostShellRadius(communityCount);
    expect(outermost).not.toBeNull();
    // Pre-fix: outermost = 60 + 38 * 45 = 1770 -> fit distance clamps to
    // exactly MAX_FIT_DISTANCE (1500), i.e. the camera stops INSIDE a
    // system whose radius (1770) exceeds its own distance from the center.
    const distance = computeFitDistance(outermost! + NODE_JITTER_HEADROOM, 50);
    expect(distance).toBeLessThan(MAX_FIT_DISTANCE);
    // And the camera actually ends up OUTSIDE the shell system.
    expect(distance).toBeGreaterThan(outermost!);
  });

  it("the same holds at the live Canvas fov (75 -- R3F's default; Graph3DScene sets only position/far)", () => {
    const outermost = orbitalOutermostShellRadius(communityCount);
    const distance = computeFitDistance(outermost! + NODE_JITTER_HEADROOM, 75);
    expect(distance).toBeLessThan(MAX_FIT_DISTANCE);
    expect(distance).toBeGreaterThan(outermost!);
  });

  it("also holds at the ~100-community scale of the ?syntheticGraph=10000 stress fixture", () => {
    const outermost = orbitalOutermostShellRadius(100);
    const distance = computeFitDistance(outermost! + NODE_JITTER_HEADROOM, 50);
    expect(distance).toBeLessThan(MAX_FIT_DISTANCE);
    expect(distance).toBeGreaterThan(outermost!);
  });
});

describe("orbitalShellSpacing (modeForces.ts) -- bounded shell ladder", () => {
  it("keeps the pre-fix 45-unit spacing EXACTLY for every count rounds 2-3 already validated (outermost <= MAX_ORBITAL_OUTERMOST_RADIUS)", () => {
    for (let count = 1; count <= 8; count++) {
      expect(orbitalShellSpacing(count)).toBe(ORBITAL_SHELL_SPACING);
      for (let community = 0; community < count; community++) {
        expect(orbitalRadiusForNode({ community }, count)).toBe(60 + community * 45);
      }
    }
  });

  it("compresses spacing above that threshold so the outermost shell never exceeds MAX_ORBITAL_OUTERMOST_RADIUS", () => {
    for (const count of [9, 39, 100, 500]) {
      const outermost = orbitalRadiusForNode({ community: count - 1 }, count);
      expect(outermost).toBeLessThanOrEqual(MAX_ORBITAL_OUTERMOST_RADIUS);
      // Shells remain genuinely concentric (distinct, increasing radii).
      expect(outermost).toBeGreaterThan(orbitalRadiusForNode({ community: 0 }, count));
      expect(orbitalShellSpacing(count)).toBeGreaterThan(0);
    }
  });

  it("MAX_ORBITAL_OUTERMOST_RADIUS sits under the camera's frameable ceiling (MAX_FIT_DISTANCE * sin(fov/2) / FIT_PADDING at the conservative fov 50) with node-jitter headroom", () => {
    const frameableCeiling = (MAX_FIT_DISTANCE * Math.sin((50 * Math.PI) / 360)) / FIT_PADDING;
    expect(MAX_ORBITAL_OUTERMOST_RADIUS + NODE_JITTER_HEADROOM).toBeLessThanOrEqual(frameableCeiling);
  });
});

describe("orbitalShellWallHeight (perModeChromeGeometry.ts) -- follows the EFFECTIVE gap between adjacent RENDERED elements", () => {
  it("is the round-2 constant (spacing / 3 = 15) wherever spacing is uncompressed", () => {
    expect(orbitalShellWallHeight(8)).toBe(ORBITAL_SHELL_SPACING / 3);
  });

  it("adjacent shell walls never visually merge: clear radial gap stays >= 2x the wall height at every scale (round 7: measured against orbitalChromeBandGap, the gap between adjacent rendered BANDS -- identical to the per-shell spacing at <= 10 communities; see orbitalShellBanding.test.ts)", () => {
    for (const count of [1, 4, 8, 39, 100]) {
      const gap = orbitalChromeBandGap(count);
      const wall = orbitalShellWallHeight(count);
      expect(wall).toBeGreaterThan(0);
      // 1e-9 epsilon: the gap/3 base makes this an EXACT equality in the
      // banded regime, where one float ulp otherwise flips the comparison.
      expect(gap - wall).toBeGreaterThanOrEqual(2 * wall - 1e-9);
    }
  });
});
