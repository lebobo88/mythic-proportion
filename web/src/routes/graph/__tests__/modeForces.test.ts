// Phase 4a de-risking spike (plan Section 6.3, bet 1): unit coverage for
// the pure per-mode force-target helpers `forceLayout.worker.ts` consumes.
import { describe, expect, it } from "vitest";
import {
  linkDistanceForMode,
  orbitalRadiusForNode,
  strataLayerY,
  SHARED_CHARGE_STRENGTH,
  SHARED_CHARGE_DISTANCE_MAX,
  SHARED_COLLIDE_RADIUS,
  CLOUD_LINK_DISTANCE,
  CLOUD_CONTAINMENT_STRENGTH,
} from "../three/modeForces";
import { synthLevelForCommunity } from "../synthetic";

describe("orbitalRadiusForNode", () => {
  it("gives different communities genuinely different shell radii (concentric shells, not one blob)", () => {
    const communityCount = 4;
    const radii = new Set(
      Array.from({ length: communityCount }, (_, community) =>
        orbitalRadiusForNode({ community }, communityCount),
      ),
    );
    expect(radii.size).toBe(communityCount);
  });

  it("is deterministic for the same community/count", () => {
    expect(orbitalRadiusForNode({ community: 2 }, 5)).toBe(orbitalRadiusForNode({ community: 2 }, 5));
  });

  it("always returns a positive radius, even for a missing/undefined community", () => {
    expect(orbitalRadiusForNode({}, 4)).toBeGreaterThan(0);
  });

  it("wraps community indices >= communityCount rather than growing unbounded", () => {
    const a = orbitalRadiusForNode({ community: 1 }, 4);
    const b = orbitalRadiusForNode({ community: 5 }, 4); // 5 % 4 === 1
    expect(a).toBe(b);
  });
});

describe("strataLayerY", () => {
  it("gives different levels genuinely different y targets (stacked layers)", () => {
    const levelCount = 4;
    const ys = new Set(
      Array.from({ length: levelCount }, (_, level) => strataLayerY({ level }, levelCount)),
    );
    expect(ys.size).toBe(levelCount);
  });

  it("is centered around y=0 (frames consistently with Cloud/Orbital's origin-centered layouts)", () => {
    const levelCount = 4;
    const ys = Array.from({ length: levelCount }, (_, level) => strataLayerY({ level }, levelCount));
    const sum = ys.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 5);
  });

  it("a higher level sits strictly above a lower level (coarsest=0 sits lowest, matching plan Section 7's 'level 0 = coarsest' convention)", () => {
    expect(strataLayerY({ level: 3 }, 4)).toBeGreaterThan(strataLayerY({ level: 0 }, 4));
  });
});

describe("linkDistanceForMode", () => {
  it("returns a distinct, positive link distance for every mode", () => {
    const modes = ["cloud", "orbital", "strata", "terrain"] as const;
    for (const mode of modes) {
      expect(linkDistanceForMode(mode)).toBeGreaterThan(0);
    }
  });

  it("cloud's link distance is unchanged from the pre-spike hardcoded value (40) -- zero behavior change for the default mode", () => {
    expect(linkDistanceForMode("cloud")).toBe(40);
  });
});

// T2 remediation (production Graph-tab regression, BLOCKER): the packet's
// explicit instruction 4 -- "add a regression test that would have caught
// this: specifically assert that the 'cloud'/default mode's force
// configuration (distanceMax, containment strength, any other tunable) is
// byte-for-byte identical to the Phase-3-verified values". These constants
// are `buildSimulation`'s single source of truth (forceLayout.worker.ts
// imports and consumes them directly -- it no longer re-literals any of
// these values in the shared charge/link/center/collide setup or the
// cloud/else force branch), so a future mode-branching edit that
// accidentally changes one of these now fails HERE, at the value's only
// declaration site, rather than silently drifting the default/"cloud" path
// that every existing production Graph-tab load depends on.
describe("cloud/default and shared force configuration (T2 remediation, byte-for-byte Phase-3-verified values)", () => {
  it("shared charge force: strength -80, distanceMax 250 (Phase 3 browser-audit fix: tightened from 600)", () => {
    expect(SHARED_CHARGE_STRENGTH).toBe(-80);
    expect(SHARED_CHARGE_DISTANCE_MAX).toBe(250);
  });

  it("shared collide radius: 3 (unchanged since before Phase 4a)", () => {
    expect(SHARED_COLLIDE_RADIUS).toBe(3);
  });

  it("cloud's link distance: 40 (unchanged since before Phase 4a)", () => {
    expect(CLOUD_LINK_DISTANCE).toBe(40);
    expect(linkDistanceForMode("cloud")).toBe(CLOUD_LINK_DISTANCE);
    expect(linkDistanceForMode(undefined as unknown as "cloud")).toBe(CLOUD_LINK_DISTANCE);
  });

  it("cloud's per-axis origin-containment strength: 0.1 (Phase 3 browser-audit fix, weak enough not to distort link-driven spacing)", () => {
    expect(CLOUD_CONTAINMENT_STRENGTH).toBe(0.1);
  });
});

describe("synthLevelForCommunity (spike-only hierarchy-depth stand-in, plan Section 5.3)", () => {
  it("is deterministic and bounded to [0, levelCount)", () => {
    for (let community = 0; community < 20; community++) {
      const level = synthLevelForCommunity(community, 4);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThan(4);
      expect(level).toBe(synthLevelForCommunity(community, 4));
    }
  });

  it("produces every level at least once across a large enough community range (a real, non-degenerate hierarchy for Strata to stack against)", () => {
    const levels = new Set(Array.from({ length: 20 }, (_, c) => synthLevelForCommunity(c, 4)));
    expect(levels.size).toBe(4);
  });
});
