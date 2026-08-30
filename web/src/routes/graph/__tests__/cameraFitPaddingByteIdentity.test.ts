// T3-advisory/Fable escalation remediation, round 8, Fix B -- THE round's
// single most important suite, mirroring round 2's byte-identity discipline.
//
// HISTORY THIS SUITE EXISTS TO ENFORCE: round 1 of this escalation changed
// camera-fit DIRECTION/elevation composition and caused two real, confirmed
// regressions (axis-avoidance and fit-distance/direction composition);
// round 2 restored CameraRig.tsx byte-for-byte and proved it. Round 8
// deliberately returns to camera-fit with the narrowest possible surface: a
// DISTANCE-ONLY, mode-scoped, WHOLE-GRAPH-SETTLE-FIT-ONLY padding scale
// (`GraphFitRequest.paddingScale`, supplied exclusively by Graph3DScene's
// settle handler when the active mode is "orbital"). Everything else --
// every other mode's settle fit, EVERY selection-fit path in EVERY mode
// (including Orbital's own selection fits), axis-avoidance
// (`resolveFitViewDirection`), and the protected Terrain flat-shape fit
// machinery (`resolveFlatShapeElevation`/`isFlatExtent`/
// `computeOrientedFitDistance`) -- must remain BYTE-IDENTICAL in behavior.
//
// This suite proves that in three layers:
//  1. PURE-MATH BIT-IDENTITY: `computeFitDistance` without the new optional
//     `paddingScale` argument (and with an explicit 1) returns bit-identical
//     (`Object.is`) results to the frozen pre-round-8 formula across a sweep
//     that includes every live-measured production radius from this
//     escalation's diagnostics -- so every caller that does not opt in
//     (selection fits, Cloud/Strata/Terrain settle fits, InstancedNodes' LOD
//     rescale) computes exactly the pre-round-8 number.
//  2. STRUCTURAL OPT-IN SCOPE: only the whole-graph settle-fit request ever
//     carries `paddingScale`, and only via the orbital-conditional; both
//     selection-fit request sites carry no such field; CameraRig's flat-
//     extent (Terrain) distance branch takes no scale at all.
//  3. SHARED-CONSTANT PINS: FIT_PADDING/MIN_FIT_DISTANCE/MAX_FIT_DISTANCE
//     are not re-tuned -- the orbital scale composes with them, it does not
//     replace them.
// The axis-avoidance and Terrain flat-fit suites themselves
// (cameraFitAxisAvoidance.test.ts, terrainCameraFitFlatShape.test.ts,
// selectionSettleFitPriority.test.ts) are re-run unchanged alongside this
// file as the behavioral half of the proof.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeFitDistance,
  FIT_PADDING,
  MAX_FIT_DISTANCE,
  MIN_FIT_DISTANCE,
} from "../three/CameraRig";
import {
  ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO,
  ORBITAL_SETTLE_FIT_PADDING_SCALE,
  orbitalSettleFitPaddingScale,
} from "../three/modeForces";

/**
 * The EXACT pre-round-8 `computeFitDistance` body, frozen here as a
 * characterization baseline (constants intentionally inlined as literals so
 * a re-tune of the shared constants cannot silently satisfy this suite).
 */
function preRound8FitDistance(radius: number, fovDeg: number): number {
  const fovRad = (fovDeg * Math.PI) / 180;
  return Math.min(1500, Math.max(20, (Math.max(radius, 1) * 1.35) / Math.sin(fovRad / 2)));
}

/**
 * Sweep includes every live-measured radius from this escalation's own
 * diagnostics (Cloud demo ~146 / N=300 ~380 / N=1500 ~569-596 baselines,
 * Strata's live 543.8-556.0 settle fits, Orbital's live 714.71 settle fit
 * and ~467 true node ball, Terrain-at-scale's ~843 sphere), the clamp
 * boundaries, and degenerate extremes.
 */
const RADIUS_SWEEP = [
  0, 0.5, 1, 8, 15, 20, 100, 146, 380, 383, 467, 543.8, 556.0, 569, 596, 660, 714.71, 843, 1000,
  1192, 1500, 1e6,
];
const FOV_SWEEP = [50, 60, 75, 90];

describe("Fix B byte-identity layer 1: computeFitDistance without paddingScale is bit-identical to the pre-round-8 formula", () => {
  it("omitted third argument: Object.is-identical across the full radius/fov sweep (every non-opted-in caller -- all selection fits, Cloud/Strata/Terrain settle fits, LOD rescale -- computes the exact pre-round-8 number)", () => {
    for (const radius of RADIUS_SWEEP) {
      for (const fov of FOV_SWEEP) {
        expect(Object.is(computeFitDistance(radius, fov), preRound8FitDistance(radius, fov))).toBe(
          true,
        );
      }
    }
  });

  it("explicit paddingScale of exactly 1: bit-identical to omitting it (the `?? 1` default path is not a second, subtly different formula)", () => {
    for (const radius of RADIUS_SWEEP) {
      for (const fov of FOV_SWEEP) {
        expect(Object.is(computeFitDistance(radius, fov, 1), computeFitDistance(radius, fov))).toBe(
          true,
        );
      }
    }
  });

  it("shared clamp/padding constants are not re-tuned: the orbital scale composes with FIT_PADDING/MIN/MAX, it does not replace them", () => {
    expect(FIT_PADDING).toBe(1.35);
    expect(MIN_FIT_DISTANCE).toBe(20);
    expect(MAX_FIT_DISTANCE).toBe(1500);
  });
});

describe("Fix B byte-identity layer 2 (structural): paddingScale is supplied ONLY by the whole-graph settle fit, only for orbital", () => {
  const graphScene = readFileSync(join(__dirname, "..", "three", "Graph3DScene.tsx"), "utf-8");
  const cameraRig = readFileSync(join(__dirname, "..", "three", "CameraRig.tsx"), "utf-8");

  it("the whole-graph settle fit passes the orbital-conditional, round-9 ADAPTIVE paddingScale decision -- fed by the settle's own live radius/maxNodeDistance -- and keeps center/radius/nonce/extent exactly as before (the radius/extent inputs stay truthful, never pre-scaled upstream)", () => {
    expect(graphScene).toMatch(
      /setFitRequest\(\{\s*center: fit\.center,\s*radius: fit\.radius,\s*nonce: fitNonceRef\.current,\s*extent: fit\.extent,\s*paddingScale:\s*mode === "orbital"\s*\?\s*orbitalSettleFitPaddingScale\(fit\.radius, fit\.maxNodeDistance\)\s*:\s*undefined,?\s*\}\);/,
    );
  });

  it("the selection EFFECT's fit request carries NO paddingScale -- selection fit is untouched, even in Orbital", () => {
    const effectMatch =
      /useEffect\(\(\) => \{\s*if \(!selectedId\) return;([\s\S]*?)\n {2}\}, \[selectedId\]\);/.exec(
        graphScene,
      );
    expect(effectMatch).not.toBeNull();
    expect(effectMatch![1]).toMatch(/setFitRequest\(/);
    expect(effectMatch![1]).not.toMatch(/paddingScale/);
  });

  it("the settle handler's SELECTION re-issue branch carries NO paddingScale either -- the H2/H3 selection retry stays byte-identical, even in Orbital", () => {
    const endMatch = /onEnd: \(\) => \{([\s\S]*?)\n {4}\},/.exec(graphScene);
    expect(endMatch).not.toBeNull();
    const body = endMatch![1];
    // The selection branch is everything before the whole-graph
    // computeBoundingSphere call.
    const selectionBranch = body.slice(0, body.indexOf("computeBoundingSphere("));
    expect(selectionBranch).toMatch(/setFitRequest\(/);
    expect(selectionBranch).not.toMatch(/paddingScale/);
  });

  it("CameraRig applies paddingScale ONLY in the isotropic distance branch; the flat-extent (protected Terrain) branch takes no scale at all", () => {
    expect(cameraRig).toMatch(
      /computeFitDistance\(fitRequest\.radius, fovDeg, fitRequest\.paddingScale \?\? 1\)/,
    );
    expect(cameraRig).toMatch(
      /computeOrientedFitDistance\(fitRequest\.extent, resolvedDir, fovDeg, aspect\)/,
    );
    // The oriented (flat/Terrain) call never receives any scale argument.
    expect(cameraRig).not.toMatch(/computeOrientedFitDistance\([^)]*paddingScale/);
  });

  it("CameraRig's DIRECTION pipeline is untouched: axis-avoidance and flat-shape elevation still compose exactly as the protected suites pinned them (round 1's regression class stays impossible)", () => {
    expect(cameraRig).toMatch(/resolveFitViewDirection\(\s*dir,\s*axis\s*\)/);
    expect(cameraRig).toMatch(/resolveFlatShapeElevation\(\s*axisResolvedDir,\s*fitRequest\.extent\s*\)/);
    expect(cameraRig).toMatch(
      /resolveFitAnchorPosition\(\s*animRef\.current,\s*camera\.position\s*\)\s*\.sub\(center\)/,
    );
  });
});

describe("Fix B effect (round-9 adaptive): the orbital whole-graph scale is a genuine, bounded reduction, applied only when the live-measured shape provably supports it", () => {
  it("ORBITAL_SETTLE_FIT_PADDING_SCALE is a real reduction (< 1) but conservative (>= 0.5)", () => {
    expect(ORBITAL_SETTLE_FIT_PADDING_SCALE).toBeLessThan(1);
    expect(ORBITAL_SETTLE_FIT_PADDING_SCALE).toBeGreaterThanOrEqual(0.5);
  });

  it("NO-CLIP THRESHOLD SOUNDNESS: the enforced live-ratio gate covers the exact sphere-in-frustum bound -- ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO >= 1 / (scale x FIT_PADDING), and stays a tight gate (<= 1.06) rather than drifting into blanket-disabling the improvement", () => {
    expect(ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO).toBeGreaterThanOrEqual(
      1 / (ORBITAL_SETTLE_FIT_PADDING_SCALE * FIT_PADDING),
    );
    expect(ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO).toBeLessThanOrEqual(1.06);
  });

  it("ADAPTIVE DECISION (round 9, Verifier's exact specified remediation): the scale applies only on affirmative live evidence -- ratio >= threshold -> the 0.7 scale; ratio at/below threshold (the small-N ratio-1.000 regime Verifier reproduced) -> undefined (the unscaled, zero-clip-for-every-shape fallback); degenerate/missing live measurement -> undefined", () => {
    // The regimes that keep round 8's improvement (measured live ratios
    // ~1.53-1.57 at N=1500, ~1.12 at demo-vault N=24).
    expect(orbitalSettleFitPaddingScale(1.53, 1)).toBe(ORBITAL_SETTLE_FIT_PADDING_SCALE);
    expect(orbitalSettleFitPaddingScale(1.12, 1)).toBe(ORBITAL_SETTLE_FIT_PADDING_SCALE);
    // Exactly at the gate: still safe (the gate itself carries the margin
    // over the exact 1/(scale x FIT_PADDING) bound, proven above).
    expect(orbitalSettleFitPaddingScale(ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO, 1)).toBe(
      ORBITAL_SETTLE_FIT_PADDING_SCALE,
    );
    // Verifier's reproduced clipping regime: ratio exactly 1.000 at N=2 and
    // N=6 -- MUST fall back to unscaled.
    expect(orbitalSettleFitPaddingScale(1, 1)).toBeUndefined();
    // Just under the gate: falls back.
    expect(orbitalSettleFitPaddingScale(1.0599, 1)).toBeUndefined();
    // No live measurement / degenerate single-point cloud: the reduction is
    // never taken on missing evidence.
    expect(orbitalSettleFitPaddingScale(8, undefined)).toBeUndefined();
    expect(orbitalSettleFitPaddingScale(8, 0)).toBeUndefined();
    expect(orbitalSettleFitPaddingScale(8, Number.NaN)).toBeUndefined();
    expect(orbitalSettleFitPaddingScale(Number.NaN, 1)).toBeUndefined();
  });

  it("at the round-start live diagnostic's exact Orbital settle fit (radius 714.71, fov 75): the scaled distance escapes the MAX_FIT_DISTANCE clamp the unscaled fit was pinned at, lands materially (>= 25%) closer, and still parks the camera outside the live-measured ~467-unit node ball with the sphere-in-frustum condition holding", () => {
    const unscaled = computeFitDistance(714.71, 75);
    const scaled = computeFitDistance(714.71, 75, ORBITAL_SETTLE_FIT_PADDING_SCALE);
    expect(unscaled).toBe(MAX_FIT_DISTANCE); // the live-confirmed clamp
    expect(scaled).toBeLessThanOrEqual(unscaled * 0.75);
    expect(scaled).toBeGreaterThan(467);
    // The live-measured true node ball (radius ~467) still fits the fov-75
    // vertical frustum: d >= r / sin(fov/2) is the exact sphere-in-frustum
    // condition. (The COMBINED A+B improvement against this round-start
    // state is asserted on the real settled shape in
    // orbitalSettleFraming.test.ts.)
    expect(scaled).toBeGreaterThan(467 / Math.sin((75 * Math.PI) / 360));
  });

  it("the scale composes with the existing clamps: a degenerate near-zero radius still lands on MIN_FIT_DISTANCE, never closer", () => {
    expect(computeFitDistance(0.001, 75, ORBITAL_SETTLE_FIT_PADDING_SCALE)).toBe(MIN_FIT_DISTANCE);
  });
});
