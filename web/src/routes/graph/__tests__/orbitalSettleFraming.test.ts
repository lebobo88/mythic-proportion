// T3-advisory/Fable escalation remediation, round 8 (plan Section 11's
// documented escalation track; Section 5.1 J-ORBITAL; Section 5.6 item 5's
// protected camera-fit invariant re-read before this round began). A live
// runtime diagnostic (React DevTools fiber walk of the RUNNING app,
// comparing Orbital vs Strata camera-fit values) proved rounds 4-7's chrome
// geometry IS rendering correctly, but the whole Orbital system projects to
// only ~159x167px on a 1374px-wide canvas at the default settle-fit framing.
// Two compounding, measured causes -- neither of them a fit-formula bug
// (Orbital's fit distance/radius ratio 2.09 vs Strata's 2.20 is
// proportionally consistent):
//
//  (a) FIX A (physics): Orbital's forceRadial strength (0.25 since the
//      Phase 4a spike) is too weak to actually converge nodes onto their
//      compressed shell targets before alpha decays -- the live diagnostic
//      measured a settled max node distance of ~467 world units against the
//      round-4 ladder's ~400-unit outermost target (~17% overshoot; the
//      charge force's repulsion keeps outermost-shell nodes scattered
//      OUTWARD of their target radius, and 0.25 never pulls them back before
//      settle). Fix: `ORBITAL_RADIAL_STRENGTH` (modeForces.ts, consumed by
//      forceLayout.worker.ts -- single source, never a re-literaled inline
//      value) raised so the settled system lands materially closer to the
//      intended target.
//
//  (b) FIX B (camera fit, distance-only): see this file's second describe
//      plus `cameraFitPaddingByteIdentity.test.ts` (the round's most
//      important suite) -- a mode-scoped, WHOLE-GRAPH-SETTLE-FIT-ONLY
//      padding scale, with byte-identity proven for every other mode and for
//      every selection-fit path (round 1 of this escalation regressed
//      axis-avoidance by touching fit DIRECTION; round 2 restored
//      CameraRig.tsx byte-for-byte -- this round deliberately touches
//      DISTANCE only, and only behind an opt-in request field no other path
//      supplies).
//
// Round 9 (Verifier's independent reproduction of round 8's residual
// defect): the round-8 padding scale was applied as a BLANKET constant to
// every Orbital whole-graph settle fit, but its zero-clip guarantee only
// holds when the live AABB-half-diagonal / true-max-node-distance ratio
// clears ~1.06 -- and at small N that ratio provably sits at exactly 1.000
// (N=2: mathematically inevitable for 2 points; a measured N=6
// two-communities/isolated-pairs settle: also exactly 1.000), producing
// REAL clipping from real sampled view directions. The scale is now
// applied ADAPTIVELY per settle (`orbitalSettleFitPaddingScale`,
// modeForces.ts), from the settle's own live measured ratio
// (`computeBoundingSphere`'s round-9 `maxNodeDistance` field). The third
// describe below pins that regime with the exact frustum-containment
// methodology on the real worker settles.
//
// Settle harness: the same real-worker, large-synchronous-`warmupTicks`
// convention `terrainCameraFitFlatShape.test.ts`'s production-shape
// regression established (jsdom has no Worker; the worker module's real
// `onmessage` handler is driven directly).
import { describe, expect, it, vi } from "vitest";
import { computeFitDistance } from "../three/CameraRig";
import {
  MAX_ORBITAL_OUTERMOST_RADIUS,
  ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO,
  ORBITAL_SETTLE_FIT_PADDING_SCALE,
  orbitalSettleFitPaddingScale,
} from "../three/modeForces";
import { computeBoundingSphere } from "../three/Graph3DScene";
import { generateSyntheticGraph } from "../synthetic";

/** The DEFAULT dev fixture the live diagnostic measured against (39 communities -- the compressed-ladder regime). */
const DEFAULT_FIXTURE_NODE_COUNT = 1500;

/**
 * Settled-node overshoot tolerance beyond the outermost shell TARGET. The
 * pre-fix live measurement was ~467 vs the 400-unit target (~17% over);
 * this band requires the tuned radial strength to hold the REAL settled
 * system within 10% of target -- materially closer, while still allowing
 * the genuine residual jitter equilibrium between the radial pull and the
 * shared charge/collide forces (which this round must NOT touch: they are
 * cloud-baseline-pinned by forceLayoutModes.test.ts).
 */
const SETTLE_OVERSHOOT_TOLERANCE = 1.1;

interface SettledOrbital {
  positions: Float32Array;
  ids: string[];
}

/**
 * One REAL worker settle per fixture, cached for every assertion in this
 * file (the N=1500 settle is genuinely expensive; both the Fix A and Fix B
 * describes measure the SAME settled shape, so settling twice would only
 * add parallel-suite load, not evidence). The stub/unstub lifecycle lives
 * entirely inside this helper so cached reuse never leaves a stubbed
 * global behind. Round 9 generalized the harness to accept an explicit
 * node/link fixture (for Verifier's exact small/sparse reproductions)
 * alongside the original synthetic-graph path -- the worker-driving
 * mechanics are unchanged.
 */
const settleCache = new Map<string, SettledOrbital>();

async function settleOrbitalGraph(
  cacheKey: string,
  nodes: { id: string; community?: number }[],
  links: { source: string; target: string }[],
): Promise<SettledOrbital> {
  const cached = settleCache.get(cacheKey);
  if (cached) return cached;

  const postMessageSpy = vi.fn();
  vi.stubGlobal("postMessage", postMessageSpy);
  try {
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    handler!({
      data: {
        type: "init",
        nodes,
        links,
        warmupTicks: 500,
        mode: "orbital",
      },
    } as unknown as MessageEvent);
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);

    const tickMessages = postMessageSpy.mock.calls
      .map(([msg]) => msg)
      .filter(
        (msg): msg is { type: "tick"; positions: Float32Array; ids: string[] } =>
          (msg as { type: string }).type === "tick",
      );
    expect(tickMessages.length).toBeGreaterThanOrEqual(1);
    const { positions, ids } = tickMessages[tickMessages.length - 1];
    const settled = { positions, ids };
    settleCache.set(cacheKey, settled);
    return settled;
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

async function settleOrbital(nodeCount: number): Promise<SettledOrbital> {
  const graph = generateSyntheticGraph({ nodeCount, avgDegree: 4, seed: 1 });
  return settleOrbitalGraph(
    `synthetic:${nodeCount}`,
    graph.nodes.map((n) => ({
      id: n.id,
      community: (n as { community?: number }).community,
    })),
    graph.edges.map((e) => ({ source: e.source, target: e.target })),
  );
}

function maxDistanceFrom(positions: Float32Array, cx: number, cy: number, cz: number): number {
  let max = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > max) max = d;
  }
  return max;
}

describe("Fix A: Orbital's settled node radius converges near the compressed shell ladder's target (round-8 live root cause a)", () => {
  it("N=1500 (the live diagnostic's exact fixture): settled max node distance from the layout's own center lands within 10% of the ~400-unit outermost target -- not the pre-fix ~17% overshoot (~467 measured live)", async () => {
    const { positions, ids } = await settleOrbital(DEFAULT_FIXTURE_NODE_COUNT);
    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const fit = computeBoundingSphere(indexMap, positions, new Set(ids));
    expect(fit).not.toBeNull();

    const settledMax = maxDistanceFrom(positions, fit!.center[0], fit!.center[1], fit!.center[2]);
    expect(settledMax).toBeLessThanOrEqual(MAX_ORBITAL_OUTERMOST_RADIUS * SETTLE_OVERSHOOT_TOLERANCE);
    // And the system genuinely still fills its shell ladder -- the tuned
    // strength compressed the overshoot, it did not collapse the layout.
    expect(settledMax).toBeGreaterThan(MAX_ORBITAL_OUTERMOST_RADIUS * 0.8);
  }, 90000);
}, 120000);

/**
 * True when every settled node stays inside a perspective frustum with
 * vertical fov `fovDeg`, looking at `center` from `center + dir * distance`
 * -- checked at aspect 1.0, which is STRICTER horizontally than any real
 * landscape viewport (horizontal half-fov only widens as aspect grows past
 * 1), so a pass here covers every production aspect ratio.
 */
function everyNodeInsideFrustum(
  positions: Float32Array,
  center: [number, number, number],
  dir: [number, number, number],
  distance: number,
  fovDeg: number,
): boolean {
  const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
  const d = [dir[0] / len, dir[1] / len, dir[2] / len];
  const cam = [center[0] + d[0] * distance, center[1] + d[1] * distance, center[2] + d[2] * distance];
  const forward = [-d[0], -d[1], -d[2]];
  // right = worldUp x forward (fall back to worldRight x forward when
  // forward is parallel to worldUp), up = forward x right -- the same basis
  // convention CameraRig's own direction helpers use.
  let right = [forward[2], 0, -forward[0]]; // (0,1,0) x forward
  if (right[0] * right[0] + right[1] * right[1] + right[2] * right[2] < 1e-6) {
    right = [0, -forward[2], forward[1]]; // (1,0,0) x forward
  }
  const rLen = Math.sqrt(right[0] * right[0] + right[1] * right[1] + right[2] * right[2]);
  right = [right[0] / rLen, right[1] / rLen, right[2] / rLen];
  const up = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];
  const tanHalf = Math.tan(((fovDeg / 2) * Math.PI) / 180);

  for (let i = 0; i < positions.length / 3; i++) {
    const v = [positions[i * 3] - cam[0], positions[i * 3 + 1] - cam[1], positions[i * 3 + 2] - cam[2]];
    const depth = v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2];
    if (depth <= 0) return false;
    const uOff = Math.abs(v[0] * up[0] + v[1] * up[1] + v[2] * up[2]);
    const rOff = Math.abs(v[0] * right[0] + v[1] * right[1] + v[2] * right[2]);
    if (uOff > tanHalf * depth || rOff > tanHalf * depth) return false;
  }
  return true;
}

/** The direction sweep shared by every containment check in this file: axes, diagonals, and a shallow-elevation direction like the live camera's own. */
const SQ = Math.SQRT1_2;
const DIRECTIONS: [number, number, number][] = [
  [0, 0, 1],
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [SQ, SQ, 0],
  [SQ, 0, SQ],
  [0, SQ, SQ],
  [0.577, 0.577, 0.577],
  [-0.577, 0.577, -0.577],
  [0.316, 0.013, 0.949], // the live diagnostic camera's own shallow direction
];

describe("Fix B on the REAL settled production shape: the tightened orbital whole-graph fit is materially closer yet clips nothing (round-8 live root cause b)", () => {
  it("N=1500 settle: Fix A + Fix B COMBINED park the camera >= 28% closer than the round-start live state (the 1500-unit clamp), Fix B contributes its full scale on top of Fix A wherever the unscaled fit is unclamped, the camera stays outside the shell system, and EVERY settled node stays inside the frustum from a spread of view directions at BOTH the live fov (75) and CameraRig's conservative fallback (50)", async () => {
    const { positions, ids } = await settleOrbital(DEFAULT_FIXTURE_NODE_COUNT);
    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const fit = computeBoundingSphere(indexMap, positions, new Set(ids));
    expect(fit).not.toBeNull();
    const settledMax = maxDistanceFrom(positions, fit!.center[0], fit!.center[1], fit!.center[2]);

    // The overestimate ratio Fix B's scale is calibrated against (see
    // ORBITAL_SETTLE_FIT_PADDING_SCALE's doc comment): the AABB
    // half-diagonal fit radius must remain a MATERIAL overestimate of the
    // true node ball for this mode's ball-shaped settles -- comfortably
    // above the ~1.06 zero-clip threshold pinned in
    // cameraFitPaddingByteIdentity.test.ts.
    expect(fit!.radius / settledMax).toBeGreaterThanOrEqual(1.3);
    // Round 9: `computeBoundingSphere`'s live maxNodeDistance field -- the
    // adaptive gate's input -- matches this file's own independent
    // recomputation on the same settled data.
    expect(fit!.maxNodeDistance).toBeCloseTo(settledMax, 6);
    // Round 9: at this (the actual target) scale the PRODUCTION adaptive
    // decision still applies the full round-8 scale -- the small-N
    // clipping fix does not cost the large-graph regime its improvement.
    expect(orbitalSettleFitPaddingScale(fit!.radius, fit!.maxNodeDistance)).toBe(
      ORBITAL_SETTLE_FIT_PADDING_SCALE,
    );

    // COMBINED improvement at the live fov: the round-start live diagnostic
    // measured the settle camera pinned at the MAX_FIT_DISTANCE clamp (1500
    // world units, radius 714.71). After Fix A (tighter settled system ->
    // smaller honest fit radius) plus Fix B (mode-scoped padding scale), the
    // settled whole-graph fit distance must land at least 28% closer
    // (measured ~1038 = ~31% closer; the band leaves a little room for
    // cross-environment float drift in the settle).
    const combined = computeFitDistance(fit!.radius, 75, ORBITAL_SETTLE_FIT_PADDING_SCALE);
    expect(combined).toBeLessThanOrEqual(1500 * 0.72);

    for (const fov of [75, 50]) {
      const unscaled = computeFitDistance(fit!.radius, fov);
      const scaled = computeFitDistance(fit!.radius, fov, ORBITAL_SETTLE_FIT_PADDING_SCALE);
      // Fix B's own increment on top of Fix A -- a genuine reduction, and
      // exactly the padding scale wherever the unscaled fit is unclamped
      // (one float ulp of slack). At the conservative fov-50 fallback the
      // unscaled fit clamps at MAX_FIT_DISTANCE for this shape, so only the
      // non-strict reduction is asserted there.
      expect(scaled).toBeLessThanOrEqual(unscaled);
      if (unscaled < 1500) {
        expect(scaled).toBeLessThanOrEqual(unscaled * ORBITAL_SETTLE_FIT_PADDING_SCALE * (1 + 1e-9));
      }
      // Camera still genuinely OUTSIDE the settled shell system (the round-4
      // failure mode -- a camera parked inside the shells -- stays fixed).
      expect(scaled).toBeGreaterThan(settledMax);

      for (const dir of DIRECTIONS) {
        expect(everyNodeInsideFrustum(positions, fit!.center, dir, scaled, fov)).toBe(true);
      }
    }
  }, 90000);

  it("demo-vault scale (N=24): the ball-shape overestimate the scale relies on holds in the small-graph regime too, and the tightened fit still clips nothing from any sampled direction at either fov", async () => {
    const { positions, ids } = await settleOrbital(24);
    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const fit = computeBoundingSphere(indexMap, positions, new Set(ids));
    expect(fit).not.toBeNull();
    const settledMax = maxDistanceFrom(positions, fit!.center[0], fit!.center[1], fit!.center[2]);
    // The measured demo-vault-regime overestimate ratio (~1.12) -- the
    // BINDING regime for the padding scale's zero-clip guarantee (the
    // 0.65-would-clip-here measurement that fixed the scale at 0.70; see
    // ORBITAL_SETTLE_FIT_PADDING_SCALE's doc comment). Must stay above the
    // ~1.06 threshold pinned in cameraFitPaddingByteIdentity.test.ts.
    expect(fit!.radius / settledMax).toBeGreaterThanOrEqual(1.1);
    // Round 9: the PRODUCTION adaptive decision still applies the scale in
    // this regime too (its measured ratio clears the live gate).
    expect(orbitalSettleFitPaddingScale(fit!.radius, fit!.maxNodeDistance)).toBe(
      ORBITAL_SETTLE_FIT_PADDING_SCALE,
    );

    for (const fov of [75, 50]) {
      const scaled = computeFitDistance(fit!.radius, fov, ORBITAL_SETTLE_FIT_PADDING_SCALE);
      expect(scaled).toBeGreaterThan(settledMax);
      for (const dir of DIRECTIONS) {
        expect(everyNodeInsideFrustum(positions, fit!.center, dir, scaled, fov)).toBe(true);
      }
    }
  }, 90000);
}, 120000);

/**
 * Round 9 (Verifier's exact clipping reproduction, remediated): the
 * small/sparse regime where the AABB half-diagonal is NOT an overestimate
 * of the true node ball (live ratio ~1.000), so the round-8 blanket scale
 * provably clipped real nodes. Orbital mode has no node-count gate, so any
 * small/early-stage vault reaches this regime in production. Every
 * containment assertion here runs the PRODUCTION decision path
 * (`orbitalSettleFitPaddingScale` fed by `computeBoundingSphere`'s live
 * `maxNodeDistance`) through the same frustum methodology as the round-8
 * describes above.
 */
describe("Round 9: small/sparse Orbital settles fall back to the unscaled fit -- zero clipping where the blanket round-8 scale provably clipped", () => {
  const PAIR_NODES = [
    { id: "pair:0", community: 0 },
    { id: "pair:1", community: 0 },
  ];
  const PAIR_LINKS = [{ source: "pair:0", target: "pair:1" }];

  /**
   * Verifier's N=6 arrangement: 2 communities, isolated pairs, each pair
   * spanning both communities -- its real settle measures a live ratio of
   * exactly 1.000 (the farthest node sits exactly on an AABB corner), the
   * same below-threshold regime as N=2.
   */
  const SPARSE_CROSS_NODES = [
    { id: "p0:a", community: 0 },
    { id: "p0:b", community: 1 },
    { id: "p1:a", community: 0 },
    { id: "p1:b", community: 1 },
    { id: "p2:a", community: 0 },
    { id: "p2:b", community: 1 },
  ];
  /** Same-community variant of the same 3 isolated pairs -- measured live ratio ~1.10, ABOVE the gate: the adaptive decision keeps the scale there, and must still clip nothing. */
  const SPARSE_SAME_NODES = [
    { id: "p0:a", community: 0 },
    { id: "p0:b", community: 0 },
    { id: "p1:a", community: 1 },
    { id: "p1:b", community: 1 },
    { id: "p2:a", community: 0 },
    { id: "p2:b", community: 0 },
  ];
  const SPARSE_LINKS = [
    { source: "p0:a", target: "p0:b" },
    { source: "p1:a", target: "p1:b" },
    { source: "p2:a", target: "p2:b" },
  ];

  it("N=2 (single linked pair): the live ratio is exactly ~1.000 (inevitable for 2 points), the round-8 blanket scale REALLY clips from a sampled direction (the pinned defect), and the production adaptive decision falls back to the bit-identical unscaled fit with EVERY node inside the frustum from every sampled direction at fov 75 and 50", async () => {
    const { positions, ids } = await settleOrbitalGraph("fixture:pair", PAIR_NODES, PAIR_LINKS);
    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const fit = computeBoundingSphere(indexMap, positions, new Set(ids));
    expect(fit).not.toBeNull();
    const settledMax = maxDistanceFrom(positions, fit!.center[0], fit!.center[1], fit!.center[2]);

    // The adaptive gate's live input matches this file's independent
    // recomputation, and the ratio sits in the below-threshold regime
    // (measured exactly 1.000000: for two points the AABB half-diagonal IS
    // the true max distance from the AABB center).
    expect(fit!.maxNodeDistance).toBeCloseTo(settledMax, 6);
    expect(fit!.radius / fit!.maxNodeDistance!).toBeCloseTo(1, 6);
    expect(fit!.radius / fit!.maxNodeDistance!).toBeLessThan(ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO);

    // The pinned round-8 defect (Verifier's reproduction): the BLANKET
    // scale's fit distance loses a real node out of the frustum from at
    // least one sampled direction at CameraRig's conservative fov fallback.
    const blanketDist = computeFitDistance(fit!.radius, 50, ORBITAL_SETTLE_FIT_PADDING_SCALE);
    expect(
      DIRECTIONS.some((dir) => !everyNodeInsideFrustum(positions, fit!.center, dir, blanketDist, 50)),
    ).toBe(true);

    // The production decision falls back to unscaled...
    const decision = orbitalSettleFitPaddingScale(fit!.radius, fit!.maxNodeDistance);
    expect(decision).toBeUndefined();
    for (const fov of [75, 50]) {
      // ...whose distance is BIT-identical to the pre-round-8 fit...
      const dist = computeFitDistance(fit!.radius, fov, decision ?? 1);
      expect(dist).toBe(computeFitDistance(fit!.radius, fov));
      // ...and zero-clip from every sampled direction.
      for (const dir of DIRECTIONS) {
        expect(everyNodeInsideFrustum(positions, fit!.center, dir, dist, fov)).toBe(true);
      }
    }
  }, 60000);

  it("N=6 (2 communities, isolated pairs -- Verifier's exact arrangement): live ratio exactly ~1.000, the production adaptive decision falls back to unscaled, and every settled node stays inside the frustum from every sampled direction at fov 75 and 50", async () => {
    const { positions, ids } = await settleOrbitalGraph(
      "fixture:sparse-cross",
      SPARSE_CROSS_NODES,
      SPARSE_LINKS,
    );
    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const fit = computeBoundingSphere(indexMap, positions, new Set(ids));
    expect(fit).not.toBeNull();
    const settledMax = maxDistanceFrom(positions, fit!.center[0], fit!.center[1], fit!.center[2]);

    expect(fit!.maxNodeDistance).toBeCloseTo(settledMax, 6);
    expect(fit!.radius / fit!.maxNodeDistance!).toBeLessThan(ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO);

    const decision = orbitalSettleFitPaddingScale(fit!.radius, fit!.maxNodeDistance);
    expect(decision).toBeUndefined();
    for (const fov of [75, 50]) {
      const dist = computeFitDistance(fit!.radius, fov, decision ?? 1);
      expect(dist).toBe(computeFitDistance(fit!.radius, fov));
      for (const dir of DIRECTIONS) {
        expect(everyNodeInsideFrustum(positions, fit!.center, dir, dist, fov)).toBe(true);
      }
    }
  }, 60000);

  it("N=6 same-community pairs (measured live ratio ~1.10, ABOVE the gate): the adaptive decision still applies the round-8 scale for a small graph whose shape genuinely supports it, and that scaled fit clips nothing from any sampled direction at either fov", async () => {
    const { positions, ids } = await settleOrbitalGraph(
      "fixture:sparse-same",
      SPARSE_SAME_NODES,
      SPARSE_LINKS,
    );
    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const fit = computeBoundingSphere(indexMap, positions, new Set(ids));
    expect(fit).not.toBeNull();
    const settledMax = maxDistanceFrom(positions, fit!.center[0], fit!.center[1], fit!.center[2]);

    expect(fit!.maxNodeDistance).toBeCloseTo(settledMax, 6);
    expect(fit!.radius / fit!.maxNodeDistance!).toBeGreaterThanOrEqual(
      ORBITAL_SETTLE_FIT_MIN_SAFE_RATIO,
    );

    const decision = orbitalSettleFitPaddingScale(fit!.radius, fit!.maxNodeDistance);
    expect(decision).toBe(ORBITAL_SETTLE_FIT_PADDING_SCALE);
    for (const fov of [75, 50]) {
      const dist = computeFitDistance(fit!.radius, fov, decision ?? 1);
      expect(dist).toBeGreaterThan(fit!.maxNodeDistance!);
      for (const dir of DIRECTIONS) {
        expect(everyNodeInsideFrustum(positions, fit!.center, dir, dist, fov)).toBe(true);
      }
    }
  }, 60000);
}, 120000);
