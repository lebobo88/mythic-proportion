// T3-advised escalation remediation (plan Section 11's documented "T3 Opus
// advisory + Fable engineering pass" track; live Browser Validator findings
// on Phase 5's Orbital/Strata chrome). Root causes, T3-diagnosed and
// source-verified by this writer:
//
//  - Orbital ring tubes were far below one on-screen pixel at real framing
//    distance: `tubeRadius = max(0.1, ringWidth(1.5) * 0.15) = 0.225` world
//    units against shell radii of 60..375 and settle-fit distances in the
//    hundreds-to-~1300 range. Thickness must scale with the shell system's
//    own size, not a fixed small multiplier of a px-ish token.
//  - Orbital disc / Strata floor opacity COMPOUNDED the opacity token with
//    the color token's own embedded alpha (0.18 * 0.4 ~= 7%; 0.14 * 0.35
//    ~= 5%) -- double-applied transparency; the dedicated `--graph-*-opacity`
//    token is the single opacity source.
//  - `OrbitalCoreGlow` lacked `depthTest={false}` (unlike `CloudNebula`), so
//    the origin-centered node cluster occluded the glow sprite entirely.
//  - Strata's `FLOOR_RADIUS = 200` was a fixed constant, under-covering the
//    real node XZ spread at scale; it must derive from the SAME
//    `computeBoundingSphere` extent the settle fit already computes (reused,
//    never a duplicated second aggregation).
//
// Same pure-math + structural-wiring convention as
// `perModeChromeGeometry.test.ts` (jsdom has no WebGL context).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  orbitalRingRadii,
  orbitalRingTubeRadius,
  strataFloorRadius,
} from "../three/perModeChromeGeometry";
import { computeFitDistance } from "../three/CameraRig";

function readThreeSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("orbitalRingTubeRadius (perModeChromeGeometry.ts)", () => {
  // Round 5: the helper takes communityCount (outermost radius + spacing
  // derived internally -- see orbitalRingTubeSpacing.test.ts). Counts 1 and
  // 8 yield exactly the pre-round-5 outermost radii these cases always used
  // (60 and 375), so each case's numeric semantics are unchanged.
  it("scales with the shell system's extent -- larger shell systems get proportionally thicker rings", () => {
    const small = orbitalRingTubeRadius(1.5, 1);
    const large = orbitalRingTubeRadius(1.5, 8);
    expect(large).toBeGreaterThan(small);
  });

  it("stays token-responsive: doubling --graph-orbital-ring-width doubles the tube radius above the floor", () => {
    const base = orbitalRingTubeRadius(1.5, 8);
    expect(orbitalRingTubeRadius(3, 8)).toBeCloseTo(base * 2, 6);
  });

  it("never collapses below the legibility floor for a tiny single-community system", () => {
    expect(orbitalRingTubeRadius(1.5, 1)).toBeGreaterThanOrEqual(0.45);
    expect(orbitalRingTubeRadius(0, 0)).toBeGreaterThanOrEqual(0.45);
  });

  it("renders at >= ~1.5 physical pixels at the REAL isotropic settle-fit framing distance for an 8-community shell system (the defect's own scale)", () => {
    // 8 communities -> outermost shell radius 60 + 7*45 = 375 (modeForces).
    const radii = orbitalRingRadii(8);
    const outermost = radii[radii.length - 1];
    expect(outermost).toBe(375);
    // Bounding radius of a shell system is at least the outermost shell;
    // frame it with the same isotropic fit the settle path uses.
    const distance = computeFitDistance(outermost + 45, 50);
    // World units per screen pixel at that distance for a ~900px-tall
    // viewport under the default 50-degree vertical FOV.
    const worldPerPixel = (2 * Math.tan((50 * Math.PI) / 360) * distance) / 900;
    const tubeDiameter = 2 * orbitalRingTubeRadius(1.5, 8);
    expect(tubeDiameter).toBeGreaterThanOrEqual(1.5 * worldPerPixel);
  });
});

describe("strataFloorRadius (perModeChromeGeometry.ts)", () => {
  it("falls back to the prior fixed 200-unit radius when no settle extent has been computed yet", () => {
    expect(strataFloorRadius(null)).toBe(200);
    expect(strataFloorRadius(undefined)).toBe(200);
  });

  it("derives the radius from the XZ half-diagonal of the settle extent (plus margin), so floors cover the corner-most nodes", () => {
    const extent: [number, number, number] = [800, 300, 600];
    const radius = strataFloorRadius(extent);
    const halfDiagonal = Math.hypot(800, 600) / 2;
    expect(radius).toBeGreaterThanOrEqual(halfDiagonal);
    expect(radius).toBeLessThanOrEqual(halfDiagonal * 1.25);
  });

  it("ignores the vertical (dy) extent entirely -- floors are horizontal discs", () => {
    expect(strataFloorRadius([800, 0, 600])).toBe(strataFloorRadius([800, 700, 600]));
  });

  it("shrinks for a small (demo-vault-scale) graph instead of always painting a 200-unit disc, but never below a legible minimum", () => {
    const small = strataFloorRadius([100, 140, 80]);
    expect(small).toBeLessThan(200);
    expect(small).toBeGreaterThanOrEqual(60);
    expect(strataFloorRadius([0, 0, 0])).toBeGreaterThanOrEqual(60);
  });
});

describe("OrbitalChrome.tsx presence fixes (structural)", () => {
  const source = readThreeSource("OrbitalChrome.tsx");

  it("derives ring tube thickness from the shared orbitalRingTubeRadius helper (shell-scale-proportional), not a fixed small multiplier of the width token", () => {
    expect(source).toMatch(/orbitalRingTubeRadius\(/);
    expect(source).not.toMatch(/RING_TUBE_SCALE/);
  });

  it("no longer compounds the disc opacity token with the disc color's own embedded alpha (the ~7%-effective double attenuation)", () => {
    expect(source).not.toMatch(/discOpacity \* chrome\.discColor\.alpha/);
    expect(source).toMatch(/chrome\.discOpacity \* opacity/);
  });
});

describe("OrbitalCoreGlow.tsx occlusion fix (structural)", () => {
  const source = readThreeSource("OrbitalCoreGlow.tsx");

  it("disables depth testing on the glow sprite exactly like CloudNebula, so the origin-centered node cluster can never occlude it", () => {
    expect(source).toMatch(/depthTest=\{false\}/);
  });
});

describe("StrataChrome.tsx presence fixes (structural)", () => {
  const source = readThreeSource("StrataChrome.tsx");

  it("derives the floor-disc radius from the settle extent via strataFloorRadius, never a fixed FLOOR_RADIUS constant", () => {
    expect(source).toMatch(/strataFloorRadius\(/);
    expect(source).not.toMatch(/const FLOOR_RADIUS = 200/);
  });

  it("no longer compounds the floor opacity token with the floor color's own embedded alpha (the ~5%-effective double attenuation)", () => {
    expect(source).not.toMatch(/floorOpacity \* chrome\.floorColor\.alpha/);
    expect(source).toMatch(/chrome\.floorOpacity \* opacity/);
  });

  it("keeps the etched level axis just outside the derived floor edge instead of a fixed -180 offset that a larger floor would swallow", () => {
    expect(source).toMatch(/<StrataAxis[\s\S]{0,200}xOffset=\{/);
  });
});

describe("extent plumbing (structural -- the settle extent is REUSED from computeBoundingSphere, never a second aggregation)", () => {
  it("Graph3DScene records the whole-graph settle fit's extent for the chrome layer inside the existing onEnd handler", () => {
    const source = readThreeSource("Graph3DScene.tsx");
    expect(source).toMatch(/setGraphExtent\(fit\.extent\)/);
  });

  it("Graph3DScene passes graphExtent through renderModeChrome, and ModeChrome hands it to StrataChrome", () => {
    const sceneSource = readThreeSource("Graph3DScene.tsx");
    expect(sceneSource).toMatch(/renderModeChrome\(\{[\s\S]{0,400}graphExtent/);
    const modeChromeSource = readThreeSource("ModeChrome.tsx");
    expect(modeChromeSource).toMatch(/<StrataChrome[\s\S]{0,300}graphExtent=\{graphExtent\}/);
  });
});
