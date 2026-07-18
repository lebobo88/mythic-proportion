// T2 remediation, Finding 1 (bounded fix job, mythic-proportion-audit-fix-
// design plan, Section 9.4/6.5): live testing at ~1,500 synthetic nodes found
// that switching to Knowledge Terrain mode left the camera extremely
// distant -- the terrain rendered as a thin sliver near the horizon and did
// NOT settle into a properly framed view even after 10+ seconds of
// additional wait. This is unlike Terrain's correct framing against the
// small real demo-vault graph (~20-30 nodes).
//
// CONFIRMED ROOT CAUSE (see `resolveFlatShapeElevation`'s own doc comment in
// `CameraRig.tsx` for the full trail, summarized here): Terrain applies the
// SAME weak (strength 0.1) x/z origin-containment force Cloud does, so its
// horizontal (XZ) footprint grows with node count exactly like Cloud's
// already-verified footprint does (Cloud settles to ~radius 569 at N=1500,
// per `forceLayoutModes.test.ts`). But Terrain's vertical extent is
// `applyTerrainElevation`'s FIXED `TERRAIN_MAX_HEIGHT` (40 world units)
// regardless of node count. At demo-vault scale (~20-30 nodes) the XZ
// footprint and the fixed 40-unit height are comparable, so the bounding
// volume is roughly cube-shaped and the existing isotropic bounding-sphere
// fit frames it fine. At ~1,500 nodes the same 40-unit height next to a
// ~500+ unit XZ footprint is a ~1:15 flat pancake -- and the fit-to-graph
// effect only ever preserves whatever direction the camera already happened
// to be facing, which (after Cloud/Orbital/Strata, none of whose bounding
// volumes are ever this flat) is typically a fairly level, shallow-elevation
// direction. Viewing a 1:15 flat pancake from a shallow, near-parallel-to-
// its-plane direction looks directly along its thin edge: a "thin sliver
// near the horizon" that a longer wait cannot fix, because the fit is a
// ONE-SHOT discrete camera move computed at settle time, not a converging
// correction.
//
// Fix: `resolveFlatShapeElevation` (CameraRig.tsx) reuses the SAME
// bounding-volume data `computeBoundingSphere` (Graph3DScene.tsx) already
// computes -- its per-axis `extent`, now also returned and threaded through
// `GraphFitRequest.extent` -- to detect a flat bounding volume and lift a
// too-shallow viewing direction to a legible elevation floor, while
// preserving the existing horizontal heading. This is exercised here
// directly against the pure math (this directory's established convention
// -- jsdom cannot provide a real WebGL/Canvas context), including an actual
// screen-space projection check (not just an angle check), per this
// directory's `cameraFitAxisAvoidance.test.ts` precedent. The fully
// rendered, live-camera behavior in a real `<Canvas>` at actual ~1,500-node
// scale remains a genuine, labeled limit, verifiable only live via Browser
// Validator (jsdom has no real GPU/rasterizer) -- same honesty standard as
// this app's other camera-math work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vector3 } from "three";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeFitDistance,
  computeOrientedFitDistance,
  FIT_PADDING,
  isFlatExtent,
  MAX_FIT_DISTANCE,
  MIN_FIT_DISTANCE,
  resolveFitAnchorPosition,
  resolveFitViewDirection,
  resolveFlatShapeElevation,
} from "../three/CameraRig";
import { computeBoundingSphere } from "../three/Graph3DScene";
import { generateSyntheticGraph } from "../synthetic";

/**
 * Projects the 8 corners of an axis-aligned box (`center` +/- `halfExtent`
 * per axis) into the screen-space "up" axis of a camera positioned at
 * `cameraPos` and looking toward `center`, and returns the range (max-min)
 * of that projection -- i.e. how much VERTICAL screen-space room the box's
 * true extent actually occupies from this viewing direction. An edge-on view
 * of a flat, wide box collapses this to a small value (the "thin sliver"
 * symptom); an elevated view recovers a much larger value. Mirrors
 * `cameraFitAxisAvoidance.test.ts`'s `lateralScreenSeparation` helper's own
 * "check actual projected geometry, not just an angle" standard.
 */
function verticalScreenCoverage(center: Vector3, halfExtent: Vector3, cameraPos: Vector3): number {
  const forward = center.clone().sub(cameraPos).normalize();
  let right = new Vector3(0, 1, 0).cross(forward);
  if (right.lengthSq() < 1e-6) right = new Vector3(1, 0, 0).cross(forward);
  right.normalize();
  const up = forward.clone().cross(right).normalize();

  let min = Infinity;
  let max = -Infinity;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const corner = center
          .clone()
          .add(new Vector3(sx * halfExtent.x, sy * halfExtent.y, sz * halfExtent.z));
        const proj = corner.clone().sub(cameraPos).dot(up);
        if (proj < min) min = proj;
        if (proj > max) max = proj;
      }
    }
  }
  return max - min;
}

describe("resolveFlatShapeElevation (CameraRig.tsx) -- lift a too-shallow viewing direction for a flat bounding volume", () => {
  it("is a no-op when no extent is supplied -- every pre-existing caller/test is unaffected", () => {
    const dir = new Vector3(0, 0.02, 1).normalize();
    const resolved = resolveFlatShapeElevation(dir.clone(), null);
    expect(resolved.x).toBeCloseTo(dir.x, 5);
    expect(resolved.y).toBeCloseTo(dir.y, 5);
    expect(resolved.z).toBeCloseTo(dir.z, 5);
  });

  it("is a no-op for a roughly cube-shaped (non-flat) bounding volume -- Cloud/Orbital/Strata's, and Terrain's own small/demo-vault-scale, already-confirmed-working framing stays untouched", () => {
    const dir = new Vector3(0, 0.02, 1).normalize(); // a shallow, near-horizontal direction
    const cubeExtent: [number, number, number] = [150, 140, 150]; // demo-vault-scale aspect ratio
    const resolved = resolveFlatShapeElevation(dir.clone(), cubeExtent);
    expect(resolved.x).toBeCloseTo(dir.x, 5);
    expect(resolved.y).toBeCloseTo(dir.y, 5);
    expect(resolved.z).toBeCloseTo(dir.z, 5);
  });

  it("is a no-op when the direction is already elevated enough despite a flat shape", () => {
    const dir = new Vector3(0, 0.6, 0.8).normalize(); // ~37 degrees above horizontal
    const flatExtent: [number, number, number] = [1200, 40, 1200]; // ~1:30 flat pancake
    const resolved = resolveFlatShapeElevation(dir.clone(), flatExtent);
    expect(resolved.x).toBeCloseTo(dir.x, 5);
    expect(resolved.y).toBeCloseTo(dir.y, 5);
    expect(resolved.z).toBeCloseTo(dir.z, 5);
  });

  it("THE REGRESSION CASE: a near-horizontal (edge-on) direction against a flat, Terrain-shaped bounding volume (~1200x40x1200, the ~1,500-node scale this finding reproduces) is lifted to a legible elevation angle", () => {
    const dir = new Vector3(0, 0.01, 1).normalize(); // ~0.6 degrees above horizontal -- effectively edge-on
    const flatExtent: [number, number, number] = [1192, 40, 1192];
    const resolved = resolveFlatShapeElevation(dir.clone(), flatExtent);
    // No longer near-edge-on: the resolved direction's vertical component
    // must sit at or above the documented legibility floor (~24 degrees).
    expect(Math.abs(resolved.y)).toBeGreaterThan(Math.sin((20 * Math.PI) / 180));
    // Still a unit vector -- a direction, not a scaled/degenerate result.
    expect(resolved.length()).toBeCloseTo(1, 5);
  });

  it("preserves the existing horizontal heading (azimuth) while lifting elevation -- a bounded nudge, not an arbitrary reset", () => {
    const dir = new Vector3(0.6, 0.01, 0.8).normalize();
    const flatExtent: [number, number, number] = [1200, 40, 1200];
    const resolved = resolveFlatShapeElevation(dir.clone(), flatExtent);
    const originalHeading = Math.atan2(dir.x, dir.z);
    const resolvedHeading = Math.atan2(resolved.x, resolved.z);
    expect(resolvedHeading).toBeCloseTo(originalHeading, 2);
  });

  it("defaults to a from-above +z heading when the direction has no horizontal component at all (looking straight down/up) -- never collapses to a near-zero-length or NaN result", () => {
    const dir = new Vector3(0, 1, 0);
    const flatExtent: [number, number, number] = [1200, 40, 1200];
    const resolved = resolveFlatShapeElevation(dir.clone(), flatExtent);
    expect(resolved.length()).toBeCloseTo(1, 5);
    expect(Number.isFinite(resolved.x)).toBe(true);
    expect(Number.isFinite(resolved.y)).toBe(true);
    expect(Number.isFinite(resolved.z)).toBe(true);
  });

  it("is a no-op for a near-zero-extent (degenerate) bounding volume -- no horizontal footprint to be flat relative to", () => {
    const dir = new Vector3(0, 0.02, 1).normalize();
    const resolved = resolveFlatShapeElevation(dir.clone(), [0, 0, 0]);
    expect(resolved.x).toBeCloseTo(dir.x, 5);
    expect(resolved.y).toBeCloseTo(dir.y, 5);
    expect(resolved.z).toBeCloseTo(dir.z, 5);
  });

  it("THE SLIVER SYMPTOM, screen-space confirmation: an edge-on view of the flat Terrain-shaped box collapses its true extent to a near-zero vertical screen band; the corrected direction recovers a meaningfully larger one", () => {
    const center = new Vector3(0, 20, 0);
    const halfExtent = new Vector3(596, 20, 596); // matches the ~1192-unit XZ / 40-unit Y extent above
    const distance = 1500; // MAX_FIT_DISTANCE, the clamp this scale actually hits

    const staleDir = new Vector3(0, 0.01, 1).normalize();
    const staleCameraPos = center.clone().addScaledVector(staleDir, distance);
    const staleCoverage = verticalScreenCoverage(center, halfExtent, staleCameraPos);

    const resolvedDir = resolveFlatShapeElevation(staleDir, [1192, 40, 1192]);
    const resolvedCameraPos = center.clone().addScaledVector(resolvedDir, distance);
    const resolvedCoverage = verticalScreenCoverage(center, halfExtent, resolvedCameraPos);

    expect(resolvedCoverage).toBeGreaterThan(staleCoverage * 3);
  });

  it("composes with resolveFitViewDirection's axis-avoidance correction without breaking it -- flat-shape elevation is applied on top of the already axis-resolved direction, never instead of it", () => {
    const rawDir = new Vector3(0, 0, -1); // anti-parallel to axis, and shallow
    const axis = new Vector3(0, 0, 1);
    const axisResolved = resolveFitViewDirection(rawDir, axis);
    // Confirm the axis correction alone already moved the direction away from
    // (anti-)parallel, exactly as `cameraFitAxisAvoidance.test.ts` covers.
    expect(Math.abs(axisResolved.dot(axis.clone().normalize()))).toBeLessThan(0.98);

    const flatExtent: [number, number, number] = [1200, 40, 1200];
    const fullyResolved = resolveFlatShapeElevation(axisResolved, flatExtent);
    expect(fullyResolved.length()).toBeCloseTo(1, 5);
    expect(Number.isFinite(fullyResolved.x)).toBe(true);
    expect(Number.isFinite(fullyResolved.y)).toBe(true);
    expect(Number.isFinite(fullyResolved.z)).toBe(true);
  });
});

// T2 remediation, third/final bounded attempt (T3/Opus advisory, confirmed
// numerically by this writer before any code change): the residual defect
// that SURVIVED both prior fixes above. Live re-testing still showed an
// illegible Terrain view at ~1,500 nodes -- an upper dense translucent mass
// over a lower void with a faint curved horizon, i.e. the terrain's
// UNDERSIDE viewed from beneath. CONFIRMED ROOT CAUSE: the terrain surface
// renders entirely at y in [0, 40] (`TerrainSurface.tsx`'s
// `elevation01 * TERRAIN_MAX_HEIGHT`), so the settle fit's center sits at
// y ~= 20 -- but production's camera starts at `[0, 0, 60]`
// (`Graph3DScene.tsx`'s `<Canvas camera>`), BELOW that center, so
// `dir = camera.position - center` has dirN.y ~= -0.316. The old
// `resolveFlatShapeElevation` preserved whatever hemisphere that direction
// happened to be in (`sign = dirN.y >= 0 ? 1 : -1`), so the "lift" resolved
// DOWNWARD to -24 degrees, and with the oriented distance (~970 units for
// this shape) the camera landed at toPos.y ~= 20 + (-0.407 * 970) ~= -375:
// ~375 units BENEATH a surface whose lowest point is y = 0, looking up at
// its underside. A ground-like flat shape is only legible from ABOVE --
// unlike `resolveFitViewDirection`'s node-pair axis-avoidance case, which
// correctly has no up-is-better bias -- so the lift must always resolve
// toward positive y, regardless of the camera's current hemisphere.
describe("resolveFlatShapeElevation always lifts a flat (ground-like) shape's viewing direction ABOVE the XZ plane -- never below it (third/final attempt: the hemisphere-preservation regression)", () => {
  const FOV_DEG = 50;
  const ASPECT = 16 / 9;

  it("THE HEMISPHERE REGRESSION CASE: production's exact pre-fit state -- camera at [0,0,60] (the <Canvas> default), Terrain settle center [0,20,0], extent [1192,40,1192] -- resolves to a direction ABOVE the plane and a camera position ABOVE the terrain's top surface, never ~375 units beneath its underside", () => {
    const center = new Vector3(0, 20, 0);
    const cameraPos = new Vector3(0, 0, 60); // Graph3DScene.tsx's <Canvas camera position>
    const extent: [number, number, number] = [1192, 40, 1192];
    const dy = extent[1];

    // dirN.y ~= -0.316 -- the camera starts BELOW the fit center, which is
    // exactly the state that used to flip the lift into the lower hemisphere.
    const rawDir = cameraPos.clone().sub(center).normalize();
    expect(rawDir.y).toBeLessThan(0);

    // The same pipeline CameraRig's fit effect runs (whole-graph fit: no axis).
    const resolvedDir = resolveFlatShapeElevation(resolveFitViewDirection(rawDir, null), extent);
    expect(resolvedDir.y).toBeGreaterThan(0);

    const distance = computeOrientedFitDistance(extent, resolvedDir, FOV_DEG, ASPECT);
    const toPos = center.clone().addScaledVector(resolvedDir, distance);
    // Above the terrain's TOP surface (center.y + dy/2 = 40) -- the fixed
    // pipeline lands at toPos.y ~= +415 for this exact fixture (independently
    // hand-verified), where the old one landed at ~= -375.
    expect(toPos.y).toBeGreaterThan(center.y + dy / 2);
  });

  it("a below-plane direction ALREADY steeper than the legibility floor is mirrored above the plane too -- a ground surface has no legible from-underneath view, so no below-plane direction may survive for a flat shape", () => {
    const dir = new Vector3(0, -0.6, 0.8); // ~37 degrees BELOW horizontal -- passed the old abs() check untouched
    const resolved = resolveFlatShapeElevation(dir.clone(), [1192, 40, 1192]);
    expect(resolved.y).toBeGreaterThan(0);
    // Mirrored, not reset: elevation steepness and horizontal heading survive.
    expect(resolved.y).toBeCloseTo(0.6, 5);
    expect(Math.atan2(resolved.x, resolved.z)).toBeCloseTo(Math.atan2(dir.x, dir.z), 5);
  });

  it("an above-plane direction at/above the legibility floor remains untouched -- prior no-op behavior for already-legible views is preserved exactly", () => {
    const dir = new Vector3(0, 0.6, 0.8).normalize();
    const resolved = resolveFlatShapeElevation(dir.clone(), [1192, 40, 1192]);
    expect(resolved.x).toBeCloseTo(dir.x, 5);
    expect(resolved.y).toBeCloseTo(dir.y, 5);
    expect(resolved.z).toBeCloseTo(dir.z, 5);
  });

  it("a straight-up-from-below direction (camera directly beneath the terrain, looking up through it) still resolves to a finite, unit-length, from-above direction", () => {
    const resolved = resolveFlatShapeElevation(new Vector3(0, -1, 0), [1192, 40, 1192]);
    expect(resolved.length()).toBeCloseTo(1, 5);
    expect(resolved.y).toBeGreaterThan(0);
    expect(Number.isFinite(resolved.x)).toBe(true);
    expect(Number.isFinite(resolved.z)).toBe(true);
  });

  it("non-flat shapes are still completely untouched, below-plane directions included -- Cloud/Orbital/Strata and demo-vault-scale Terrain (whose roughly cubic extent never enters the flat branch at all, which is why this bug never reproduced there) keep their confirmed-working framing", () => {
    const dir = new Vector3(0, -20, 60).normalize(); // the exact below-center production direction (camera [0,0,60] minus center [0,20,0])
    const cubeExtent: [number, number, number] = [150, 140, 150];
    const resolved = resolveFlatShapeElevation(dir.clone(), cubeExtent);
    expect(resolved.x).toBeCloseTo(dir.x, 5);
    expect(resolved.y).toBeCloseTo(dir.y, 5);
    expect(resolved.z).toBeCloseTo(dir.z, 5);
  });
});

// Secondary robustness fix, same third/final attempt (T3 advisory, flagged
// as lower priority than -- and independent of -- the hemisphere fix above):
// the fit effect used to derive its viewing direction from the LIVE
// `camera.position` at the moment the worker's "end" event fired, which can
// land while a prior fit/focus animation is still mid-flight -- so the
// derived direction depended on exactly WHEN mid-lerp the event arrived
// (a plausible mechanism for the variable-duration "sliver" transient seen
// across live runs). Anchoring on the in-flight animation's DESTINATION
// instead makes the derived direction deterministic: the same sequence of
// fit requests now resolves the same directions regardless of event timing.
describe("resolveFitAnchorPosition (CameraRig.tsx) -- deterministic fit anchor while a prior animation is mid-flight", () => {
  it("returns the in-flight animation's DESTINATION rather than the live mid-lerp camera position, so a fit that fires during a prior animation resolves the same direction on every run", () => {
    const anim = { toPos: new Vector3(10, 20, 30) };
    const midLerpCameraPos = new Vector3(3, 4, 5);
    const anchor = resolveFitAnchorPosition(anim, midLerpCameraPos);
    expect(anchor.x).toBe(10);
    expect(anchor.y).toBe(20);
    expect(anchor.z).toBe(30);
  });

  it("returns the live camera position when no animation is in flight -- the existing settled-camera behavior is unchanged", () => {
    const cameraPos = new Vector3(3, 4, 5);
    const anchor = resolveFitAnchorPosition(null, cameraPos);
    expect(anchor.x).toBe(3);
    expect(anchor.y).toBe(4);
    expect(anchor.z).toBe(5);
  });

  it("returns a defensive clone -- the caller's subsequent in-place math (`.sub(center)`) never corrupts the animation's own destination vector or the camera's position", () => {
    const anim = { toPos: new Vector3(1, 2, 3) };
    resolveFitAnchorPosition(anim, new Vector3(9, 9, 9)).set(0, 0, 0);
    expect(anim.toPos.x).toBe(1);
    expect(anim.toPos.y).toBe(2);
    expect(anim.toPos.z).toBe(3);

    const cameraPos = new Vector3(7, 8, 9);
    resolveFitAnchorPosition(null, cameraPos).set(0, 0, 0);
    expect(cameraPos.x).toBe(7);
  });

  it("structural: the fit-to-graph effect derives its direction from resolveFitAnchorPosition(animRef.current, camera.position), never from the raw live camera position alone", () => {
    const source = readFileSync(join(__dirname, "..", "three", "CameraRig.tsx"), "utf-8");
    expect(source).toMatch(/resolveFitAnchorPosition\(\s*animRef\.current,\s*camera\.position\s*\)\s*\.sub\(center\)/);
  });
});

describe("computeBoundingSphere (Graph3DScene.tsx) now also returns the per-axis extent flat-shape detection needs", () => {
  it("returns extent = [dx, dy, dz] alongside center/radius, matching the actual min/max spread per axis", () => {
    const indexMap = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    // x spans -100..100 (200), y spans 0..40 (40), z spans -50..50 (100).
    const positions = new Float32Array([-100, 0, -50, 0, 40, 0, 100, 10, 50]);
    const fit = computeBoundingSphere(indexMap, positions, new Set(["a", "b", "c"]));
    expect(fit).not.toBeNull();
    expect(fit!.extent[0]).toBeCloseTo(200, 5);
    expect(fit!.extent[1]).toBeCloseTo(40, 5);
    expect(fit!.extent[2]).toBeCloseTo(100, 5);
  });
});

describe("Graph3DScene wires the bounding-volume extent into every fit request (structural -- confirms the exported pure functions above are actually connected, not merely defined)", () => {
  it("the whole-graph settle fit (onEnd, nothing selected) passes extent: fit.extent into setFitRequest", async () => {
    const source = readFileSync(join(__dirname, "..", "three", "Graph3DScene.tsx"), "utf-8");
    expect(source).toMatch(/setFitRequest\(\{\s*center: fit\.center,\s*radius: fit\.radius,\s*nonce: fitNonceRef\.current,\s*extent: fit\.extent\s*\}\);/);
  });

  it("CameraRig.tsx's fit-application effect resolves the extent via resolveFlatShapeElevation, applied on top of the axis-resolved direction", async () => {
    const source = readFileSync(join(__dirname, "..", "three", "CameraRig.tsx"), "utf-8");
    expect(source).toMatch(/resolveFlatShapeElevation\(\s*axisResolvedDir,\s*fitRequest\.extent\s*\)/);
  });
});

// Production-shape regression: reuses this directory's established
// `settledFit`-style convention (see `graphPerf.synthetic.test.ts`'s "camera
// fit distance is responsive..." describe block) of driving the REAL worker
// module through a large synchronous `warmupTicks` settle, without depending
// on d3-timer's async scheduler -- but with `mode: "terrain"`, which that
// file's own coverage never exercises. Confirms the anisotropy this finding
// depends on is REAL production behavior, not a hypothetical fixture.
describe("Terrain mode's settled bounding volume is genuinely flat at ~1,500-node scale (production-shape regression)", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    vi.stubGlobal("postMessage", postMessageSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("N=1500 terrain-mode settle: the resulting bounding volume's aspect ratio (vertical/horizontal) is well below resolveFlatShapeElevation's flatness threshold -- confirming this is the shape actually produced at the scale the finding reports, not merely a hand-picked test fixture", async () => {
    const graph = generateSyntheticGraph({ nodeCount: 1500, avgDegree: 4, seed: 1 });
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    postMessageSpy.mockClear();
    handler!({
      data: {
        type: "init",
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          centrality: (n as { centrality?: number }).centrality,
        })),
        links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
        warmupTicks: 500,
        mode: "terrain",
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

    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const visibleIds = new Set(ids);

    const fit = computeBoundingSphere(indexMap, positions, visibleIds);
    expect(fit).not.toBeNull();
    const [dx, , dz] = fit!.extent;
    const dy = fit!.extent[1];
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    const aspect = dy / horizontal;

    // The heightfield's own fixed ceiling -- vertical extent can never
    // exceed this regardless of node count.
    expect(dy).toBeLessThanOrEqual(40 + 1e-6);
    // The actual, independently-measured regression: at this scale the
    // horizontal footprint dwarfs the fixed height, producing a genuinely
    // flat bounding volume -- well under the 0.3 aspect-ratio threshold
    // `resolveFlatShapeElevation` uses to decide whether a correction is
    // needed at all.
    expect(aspect).toBeLessThan(0.3);
  }, 20000);
});

// T2 remediation, second/final bounded attempt: the residual defect that
// SURVIVED the flat-shape-elevation fix above. Live re-testing at ~1,500
// synthetic Terrain nodes found the failure signature CHANGED after that fix
// (no longer an edge-on sliver) but the core defect persisted: a settled
// camera stuck extremely distant, rendering the terrain as a tiny,
// low-contrast, illegible blob. CONFIRMED ROOT CAUSE (see
// `isFlatExtent`/`computeOrientedFitDistance`'s own doc comment in
// CameraRig.tsx for the full trail, summarized here): the flat-shape fix
// only ever corrected the viewing DIRECTION -- `computeFitDistance` still
// computes DISTANCE from an isotropic, direction-agnostic bounding-sphere
// radius, which for this exact shape clamps straight to `MAX_FIT_DISTANCE`
// regardless of how good the corrected direction is. These tests exercise
// the pure math directly (this directory's established convention -- jsdom
// cannot provide a real WebGL/Canvas context) and are the tests that would
// have caught THIS specific residual failure: they assert not just that a
// number changed, but that the fit distance for the exact reported shape
// stops clamping at the ceiling and that the resulting framing genuinely
// covers materially more of the viewport than the old, direction-agnostic
// distance did.
describe("isFlatExtent (CameraRig.tsx) -- shared flatness gate for the direction-aware fit-distance correction", () => {
  it("is true for the exact ~1:15 Terrain-at-scale shape this finding reports", () => {
    expect(isFlatExtent([1192, 40, 1192])).toBe(true);
  });

  it("is false for a roughly cube-shaped (demo-vault-scale) volume -- Cloud/Orbital/Strata's, and small-scale Terrain's, framing must keep using the isotropic default", () => {
    expect(isFlatExtent([150, 140, 150])).toBe(false);
  });

  it("is false for a near-zero-horizontal-footprint (degenerate) volume -- no horizontal extent to be flat relative to", () => {
    expect(isFlatExtent([0, 0, 0])).toBe(false);
  });
});

describe("computeOrientedFitDistance (CameraRig.tsx) -- direction-aware replacement for the isotropic sphere fit, flat shapes only", () => {
  const FOV_DEG = 50;
  const ASPECT = 16 / 9;

  it("THE RESIDUAL-DEFECT REGRESSION CASE: for the exact N=1500 Terrain shape and its ALREADY-CORRECTED elevated viewing direction, the oriented distance no longer clamps at MAX_FIT_DISTANCE, unlike the old isotropic-radius method applied to the same shape", () => {
    const extent: [number, number, number] = [1192, 40, 1192];
    // The same bounding-sphere radius `computeBoundingSphere` would derive
    // from this extent, and the same corrected direction
    // `resolveFlatShapeElevation` produces for a shallow starting direction
    // -- i.e. exactly the state the fit-to-graph effect reaches right before
    // computing distance, post this finding's first (direction-only) fix.
    const radius = Math.sqrt(1192 * 1192 + 40 * 40 + 1192 * 1192) / 2;
    const staleDir = new Vector3(0, 0.01, 1).normalize();
    const resolvedDir = resolveFlatShapeElevation(staleDir, extent);

    const oldDistance = computeFitDistance(radius, FOV_DEG);
    const newDistance = computeOrientedFitDistance(extent, resolvedDir, FOV_DEG, ASPECT);

    // The pre-fix behavior this finding reports: the isotropic method
    // clamps straight to the ceiling for this shape.
    expect(oldDistance).toBe(MAX_FIT_DISTANCE);
    // The fix: genuinely direction-aware, and materially closer -- not just
    // a marginal adjustment. Comfortably clear of the old clamped value.
    expect(newDistance).toBeLessThan(oldDistance * 0.8);
    expect(newDistance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
    expect(newDistance).toBeLessThanOrEqual(MAX_FIT_DISTANCE);
  });

  it("the corrected, closer distance genuinely recovers more projected screen coverage than the old clamped distance did -- not merely a smaller number", () => {
    const extent: [number, number, number] = [1192, 40, 1192];
    const halfExtent = new Vector3(596, 20, 596);
    const center = new Vector3(0, 20, 0);
    const radius = Math.sqrt(1192 * 1192 + 40 * 40 + 1192 * 1192) / 2;
    const staleDir = new Vector3(0, 0.01, 1).normalize();
    const resolvedDir = resolveFlatShapeElevation(staleDir, extent);

    const oldDistance = computeFitDistance(radius, FOV_DEG);
    const newDistance = computeOrientedFitDistance(extent, resolvedDir, FOV_DEG, ASPECT);

    function projectedCoverage(distance: number): { vertical: number; horizontal: number } {
      const cameraPos = center.clone().addScaledVector(resolvedDir, distance);
      const forward = center.clone().sub(cameraPos).normalize();
      let right = new Vector3(0, 1, 0).cross(forward);
      if (right.lengthSq() < 1e-6) right = new Vector3(1, 0, 0).cross(forward);
      right.normalize();
      const up = forward.clone().cross(right).normalize();
      let minU = Infinity;
      let maxU = -Infinity;
      let minR = Infinity;
      let maxR = -Infinity;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const corner = center
              .clone()
              .add(new Vector3(sx * halfExtent.x, sy * halfExtent.y, sz * halfExtent.z));
            const rel = corner.clone().sub(cameraPos);
            const u = rel.dot(up);
            const r = rel.dot(right);
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (r < minR) minR = r;
            if (r > maxR) maxR = r;
          }
        }
      }
      // Angular coverage (world-space extent divided by distance) is the
      // right proxy for "fraction of the viewport filled" -- a raw
      // world-space extent alone doesn't account for the camera being
      // farther away, which is exactly the effect under test.
      return { vertical: (maxU - minU) / distance, horizontal: (maxR - minR) / distance };
    }

    const oldCoverage = projectedCoverage(oldDistance);
    const newCoverage = projectedCoverage(newDistance);
    expect(newCoverage.vertical).toBeGreaterThan(oldCoverage.vertical * 1.5);
    expect(newCoverage.horizontal).toBeGreaterThan(oldCoverage.horizontal * 1.5);
  });

  it("is a no-op-equivalent order of magnitude for a roomy/roundish shape viewed head-on (sanity check against a hand-computed value, not a regression gate)", () => {
    // A cube-ish extent viewed dead-on along +z: the projected half-height
    // equals half the y-extent, half-width equals half the x-extent.
    const extent: [number, number, number] = [200, 180, 200];
    const dir = new Vector3(0, 0, 1);
    const distance = computeOrientedFitDistance(extent, dir, FOV_DEG, 1);
    const fovRad = (FOV_DEG * Math.PI) / 180;
    const expectedV = (90 * FIT_PADDING) / Math.tan(fovRad / 2);
    expect(distance).toBeGreaterThan(expectedV * 0.9);
    expect(distance).toBeLessThan(expectedV * 1.3);
  });

  it("never returns a non-finite or degenerate result for a near-zero extent", () => {
    const distance = computeOrientedFitDistance([0, 0, 0], new Vector3(0, 0.3, 1), FOV_DEG, ASPECT);
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
  });

  it("never returns a non-finite or degenerate result for a straight-down viewing direction (right-vector fallback path)", () => {
    const distance = computeOrientedFitDistance([1200, 40, 1200], new Vector3(0, 1, 0), FOV_DEG, ASPECT);
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
    expect(distance).toBeLessThanOrEqual(MAX_FIT_DISTANCE);
  });
});

describe("CameraRig.tsx wires the direction-aware fit distance into the fit-to-graph effect, gated to flat shapes only (structural -- confirms the exported pure functions above are actually connected, not merely defined)", () => {
  it("computes distance from computeOrientedFitDistance for a flat extent, and from the existing isotropic computeFitDistance otherwise -- so Cloud/Orbital/Strata and small-scale Terrain keep their already-confirmed-working framing untouched", () => {
    const source = readFileSync(join(__dirname, "..", "three", "CameraRig.tsx"), "utf-8");
    expect(source).toMatch(
      /fitRequest\.extent\s*&&\s*isFlatExtent\(fitRequest\.extent\)\s*\?\s*computeOrientedFitDistance\(\s*fitRequest\.extent,\s*resolvedDir,\s*fovDeg,\s*aspect,?\s*\)\s*:\s*computeFitDistance\(fitRequest\.radius,\s*fovDeg\)/,
    );
  });

  it("distance is computed AFTER resolvedDir (post axis-resolution and post flat-shape-elevation) so the oriented calculation actually depends on the corrected direction, not the stale pre-correction one", () => {
    const source = readFileSync(join(__dirname, "..", "three", "CameraRig.tsx"), "utf-8");
    const resolvedDirIdx = source.indexOf("const resolvedDir = resolveFlatShapeElevation(");
    const distanceIdx = source.indexOf("const distance =");
    expect(resolvedDirIdx).toBeGreaterThan(-1);
    expect(distanceIdx).toBeGreaterThan(-1);
    expect(distanceIdx).toBeGreaterThan(resolvedDirIdx);
  });
});

// Production-shape end-to-end regression: extends the existing worker-driven
// N=1500 terrain settle above with the SAME direction-resolution pipeline
// `CameraRig.tsx`'s effect runs (`resolveFitViewDirection` with no axis, then
// `resolveFlatShapeElevation`) plus the new distance calculation, against a
// stale pre-fit camera direction like the one production starts from
// (`[0, 0, 60]` relative to a settled center far from the origin) -- proving
// end-to-end, from REAL worker output, that the fit no longer clamps to
// MAX_FIT_DISTANCE for this shape.
describe("N=1500 terrain-mode settle, full fit pipeline (production-shape end-to-end regression)", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    vi.stubGlobal("postMessage", postMessageSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("the fully resolved direction plus oriented distance no longer clamps to MAX_FIT_DISTANCE for the REAL settled shape, unlike the isotropic method applied to the same real radius/extent", async () => {
    const graph = generateSyntheticGraph({ nodeCount: 1500, avgDegree: 4, seed: 1 });
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    postMessageSpy.mockClear();
    handler!({
      data: {
        type: "init",
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          centrality: (n as { centrality?: number }).centrality,
        })),
        links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
        warmupTicks: 500,
        mode: "terrain",
      },
    } as unknown as MessageEvent);
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);

    const tickMessages = postMessageSpy.mock.calls
      .map(([msg]) => msg)
      .filter(
        (msg): msg is { type: "tick"; positions: Float32Array; ids: string[] } =>
          (msg as { type: string }).type === "tick",
      );
    const { positions, ids } = tickMessages[tickMessages.length - 1];
    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const visibleIds = new Set(ids);

    const fit = computeBoundingSphere(indexMap, positions, visibleIds);
    expect(fit).not.toBeNull();

    // Production's actual default camera start position, per `Graph3DScene.tsx`.
    const cameraPos = new Vector3(0, 0, 60);
    const center = new Vector3(...fit!.center);
    const rawDir = cameraPos.clone().sub(center).normalize();
    const resolvedDir = resolveFlatShapeElevation(resolveFitViewDirection(rawDir, null), fit!.extent);

    const oldDistance = computeFitDistance(fit!.radius, 50);
    const newDistance = isFlatExtent(fit!.extent)
      ? computeOrientedFitDistance(fit!.extent, resolvedDir, 50, 16 / 9)
      : computeFitDistance(fit!.radius, 50);

    expect(isFlatExtent(fit!.extent)).toBe(true);
    expect(oldDistance).toBe(MAX_FIT_DISTANCE);
    expect(newDistance).toBeLessThan(MAX_FIT_DISTANCE);
    expect(newDistance).toBeLessThan(oldDistance * 0.85);

    // Third/final attempt (the hemisphere-preservation regression -- see the
    // dedicated describe block above): from the REAL settled shape and the
    // REAL below-center starting camera, the final fit position must land
    // ABOVE the terrain's top surface, never beneath its underside.
    expect(resolvedDir.y).toBeGreaterThan(0);
    const toPos = center.clone().addScaledVector(resolvedDir, newDistance);
    expect(toPos.y).toBeGreaterThan(center.y + fit!.extent[1] / 2);
  }, 20000);
});
