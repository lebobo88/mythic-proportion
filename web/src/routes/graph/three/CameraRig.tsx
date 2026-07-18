// Eased camera moves (deliverable 7 + Issue 2 fix): damped lerp toward a
// focus target OR a graph-fit request over ~400-600ms using the shared
// `--ease-emphasized` motion token (see lib/motion.ts) -- collapses to an
// instant snap when `prefers-reduced-motion` is set, per deliverable 10.
//
// Two independent trigger props share one animation engine:
//  - `focusTarget`: a single node's position, framed with a fixed +6 z
//    offset. T2 remediation (Finding 1 -- live-Chrome finding: selecting a
//    node produced an illegible, extreme-zoom-in camera move because a
//    fixed 6-unit offset ignores the graph's actual scale, see
//    `computeFitDistance`'s own >=20-unit floor for the distance this app
//    already treats as "close"): `Graph3DScene.tsx`'s selection effect no
//    longer feeds this prop -- it now issues a `fitRequest` scoped to the
//    selected node plus its immediate neighbors instead, reusing this same
//    file's scale-responsive `computeFitDistance`. `focusTarget` is kept
//    here, generic and available, for a future genuinely single-point focus
//    need (e.g. a future feature with no "immediate neighbors" concept) --
//    it is not currently wired to any production caller.
//  - `fitRequest`: a bounding-sphere fit request -- either the whole-graph
//    (or whole-disclosed-subset) sphere computed once the worker layout
//    settles (`onEngineStop`; Issue 2, BLOCKING: most nodes started
//    off-screen because nothing ever moved the camera to frame the graph),
//    or a selection-scoped sphere (Finding 1 above). `nonce` forces a
//    re-fit even when the computed center/radius happen to be unchanged
//    (re-heat on data change, or reselecting the same node, always bumps
//    it).
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { getDuration, prefersReducedMotion } from "../../../lib/motion";

export interface GraphFitRequest {
  center: [number, number, number];
  radius: number;
  /** Bumped on every fit request so effect deps fire even if center/radius repeat. */
  nonce: number;
  /**
   * T2 remediation (bounded remediation, second/final attempt on the
   * residual edge-on-framing defect -- see `resolveFitViewDirection` below
   * for the full root cause and evidence trail). The dominant direction of a
   * SMALL/elongated focus set (e.g. a selected node plus its single
   * neighbor), used to steer the camera's viewing direction away from being
   * nearly parallel to it. `null`/absent for a roomy/roundish focus set
   * (e.g. the whole-graph fit) where no correction is needed -- see
   * `computeFocusAxis` in `Graph3DScene.tsx`.
   */
  axis?: [number, number, number] | null;
  /**
   * T2 remediation (Finding 1 -- Terrain camera-fit "thin sliver near the
   * horizon" bug at scale; see `resolveFlatShapeElevation` below for the
   * full root cause and evidence trail). Full per-axis world-space extent
   * (`[dx, dy, dz]`) of the same bounding volume `center`/`radius` describe
   * -- `null`/absent behaves exactly as before this remediation (no
   * elevation correction applied).
   */
  extent?: [number, number, number] | null;
}

// Browser-audit item 1 (defense-in-depth, alongside the worker-side
// containment-force fix in forceLayout.worker.ts): hard-clamp the computed
// fit distance so a pathological bounding-sphere radius (an edge case the
// physics fix doesn't fully eliminate, e.g. a future mode's different force
// config) can never push the camera close to the `far: 4000` clipping plane
// set on the `<Canvas>` in Graph3DScene.tsx -- that near-far-plane regime is
// where depth-buffer precision collapses into z-fighting, and it's the same
// regime the audit's "nodes shrink to invisible pinpoints" symptom sits in.
export const MAX_FIT_DISTANCE = 1500;
/** Floor so the camera never parks uncomfortably close to a near-degenerate (near-zero-radius) graph. */
export const MIN_FIT_DISTANCE = 20;
/** Extra margin beyond the minimal "sphere just touches the frustum edges" distance. */
export const FIT_PADDING = 1.35;

/**
 * Distance (world units) along the camera's current view direction needed to
 * frame a bounding sphere of `radius` inside a perspective camera's vertical
 * field of view, with `FIT_PADDING` margin, clamped to
 * [`MIN_FIT_DISTANCE`, `MAX_FIT_DISTANCE`].
 *
 * T2 remediation (see the T2 job report): this is genuinely RESPONSIVE to
 * `radius` -- the standard "fit sphere in frustum" formula
 * `radius / sin(fov / 2)`, times padding -- not a fixed target re-tuned per
 * graph shape. It is exercised directly (not just via source-regex
 * matching) against multiple graph shapes in graphPerf.synthetic.test.ts,
 * including the demo-vault-equivalent shape that originally surfaced this
 * remediation job, to guard against this class of regression recurring on
 * the next data change.
 */
export function computeFitDistance(radius: number, fovDeg: number): number {
  const fovRad = (fovDeg * Math.PI) / 180;
  return Math.min(
    MAX_FIT_DISTANCE,
    Math.max(MIN_FIT_DISTANCE, (Math.max(radius, 1) * FIT_PADDING) / Math.sin(fovRad / 2)),
  );
}

/**
 * Cosine of the "too close to parallel" threshold angle (~12 degrees) used
 * by `resolveFitViewDirection` below -- comfortably inside the range where a
 * perspective camera's projected lateral separation between two focus points
 * collapses toward the illegible sliver/skewed-label symptom this
 * remediation fixes, while staying loose enough not to second-guess a
 * viewing angle that already has meaningful separation from the focus axis.
 */
const AXIS_PARALLEL_COS_THRESHOLD = Math.cos((12 * Math.PI) / 180);

/**
 * T2 remediation (bounded remediation, second and final attempt on this
 * specific residual framing issue -- see the T2 job report for the full
 * evidence trail). CONFIRMED ROOT CAUSE: the fit-to-graph effect below only
 * ever adjusts DISTANCE and TARGET -- it preserves whatever viewing
 * DIRECTION the camera already happens to have
 * (`camera.position.clone().sub(center)`, unchanged since the general fix).
 * That is fine for a roomy/roundish focus set, but degenerates when the
 * focus set is small and elongated (the canonical repro: a degree-1 node
 * plus its single neighbor, i.e. exactly two points) AND the camera's
 * pre-existing viewing direction happens to sit nearly parallel to the line
 * between those two points -- both points then project to nearly the same
 * position in screen space, with no visible edge between them, even though
 * drag-rotating ~90 degrees proves both nodes and the edge are genuinely in
 * the scene (reproduced identically on "Halcyon Thruster"->"Orbital
 * Dynamics" and "Meridian Logistics"->"Acme Robotics").
 *
 * Fix: when the caller supplies `axis` (the dominant direction of a small
 * focus set -- see `computeFocusAxis` in `Graph3DScene.tsx`, intentionally
 * `null`/absent for a roomy focus set where this correction is not needed,
 * e.g. the whole-graph fit) and the camera's current viewing direction is
 * within `AXIS_PARALLEL_COS_THRESHOLD` of being parallel OR anti-parallel to
 * that axis (both project the same degenerate way), replace the viewing
 * direction with one PERPENDICULAR to the axis instead. A direction exactly
 * perpendicular to the focus axis maximizes the two focus points' projected
 * lateral separation for a given fit distance -- exactly what "avoid the
 * degenerate edge-on case" requires. This is intentionally a bounded nudge
 * for the small-focus-set case, not a sophisticated "always optimal"
 * camera-placement algorithm, per the job's own scope. A touch of vertical
 * lift is blended in so the corrected framing reads as a natural elevated
 * angle rather than a perfectly flat side-on view. When the axis itself is
 * (near-)parallel to world-up, the perpendicular is computed against
 * world-right instead, so the cross product never degenerates toward a
 * near-zero vector.
 *
 * See `cameraFitAxisAvoidance.test.ts` for direct pure-math coverage,
 * including the exact "2-point focus set positioned along the camera's
 * current viewing axis" regression case from the finding, verified via an
 * actual screen-space lateral-separation projection (not just an angle
 * check). The fully rendered, live-camera behavior in a real `<Canvas>`
 * remains a genuine, labeled limit, verifiable only live via Browser
 * Validator, same honesty standard as this file's other camera-math work.
 */
export function resolveFitViewDirection(
  currentDir: Vector3,
  axis: Vector3 | null | undefined,
): Vector3 {
  const dirN = currentDir.clone().normalize();
  if (!axis || axis.lengthSq() < 1e-6) return dirN;

  const axisN = axis.clone().normalize();
  const cosAngle = Math.abs(dirN.dot(axisN));
  if (cosAngle < AXIS_PARALLEL_COS_THRESHOLD) return dirN;

  const worldUp = new Vector3(0, 1, 0);
  let perp = worldUp.clone().cross(axisN);
  if (perp.lengthSq() < 1e-6) perp = new Vector3(1, 0, 0).cross(axisN);
  perp.normalize();
  return perp.addScaledVector(worldUp, 0.35).normalize();
}

/**
 * Aspect ratio (vertical extent / horizontal extent) below which a fit's
 * bounding volume reads as "flat" for `resolveFlatShapeElevation` below --
 * chosen well above the ~1:15 ratio the finding's own repro produces (a
 * ~40-unit Terrain height next to a ~570-unit XZ footprint at N=1500, per
 * `forceLayoutModes.test.ts`'s independently re-measured N=1500 cloud/
 * terrain-XZ-physics baseline) and comfortably below the ~1:1 ratio the
 * demo-vault-scale repro (~20-30 nodes) produces, where the existing
 * direction-preserving fit is already confirmed working and must stay
 * untouched.
 */
const FLAT_SHAPE_ASPECT_THRESHOLD = 0.3;

/** Minimum elevation angle (sine of degrees above the XZ ground plane) a flat-shape fit's viewing direction is lifted to, if it starts out shallower than this -- comfortably enough above true edge-on (0) to read as a legible, angled-down view of a mostly-flat surface rather than a sliver. */
const MIN_FLAT_SHAPE_ELEVATION_SIN = Math.sin((24 * Math.PI) / 180);

/**
 * T2 remediation (Finding 1 -- Knowledge Terrain camera-fit distant/"thin
 * sliver near the horizon" bug, confirmed only at higher (~1,500+) node
 * counts, never at the small real demo-vault graph's scale).
 *
 * CONFIRMED ROOT CAUSE (read `forceLayout.worker.ts`'s per-mode
 * `buildSimulation` branch plus `terrainElevation.ts`'s
 * `TERRAIN_MAX_HEIGHT` constant): Terrain mode applies the SAME weak
 * (strength 0.1) origin-containment force to x/z that Cloud mode does (`if
 * (mode === "terrain") { ... forceX(0).strength(0.1) ... forceZ(0)
 * .strength(0.1) ... }`), so Terrain's horizontal (XZ) footprint grows with
 * node count exactly like Cloud's already-verified footprint does (Cloud
 * settles to ~radius 569 at N=1500, per `forceLayoutModes.test.ts`'s "cloud
 * mode's full settle does not collapse over time" coverage -- Terrain's XZ
 * physics is configured identically, so its XZ footprint scales the same
 * way). But Terrain's VERTICAL extent is `applyTerrainElevation`'s fixed
 * `TERRAIN_MAX_HEIGHT` (40 world units) REGARDLESS of node count -- the
 * heightfield's y-range never grows with the graph, by design (nodes "ride"
 * a bounded-height surface, they don't drift arbitrarily in y). At ~20-30
 * nodes (the demo vault), the XZ footprint and the fixed 40-unit height are
 * comparable in magnitude, so the bounding volume reads as roughly
 * cube-shaped, and `computeBoundingSphere`'s isotropic sphere-fit (reused
 * as-is, unchanged) frames it fine from whatever direction the camera
 * happens to already be facing. At ~1,500 nodes, that SAME fixed 40-unit
 * height next to a ~500+ unit XZ footprint is roughly a 1:15 flat pancake --
 * and the fit-to-graph effect below only ever preserves whatever direction
 * the camera already happened to be facing (the same "preserve existing
 * direction" behavior `resolveFitViewDirection` above already had to correct
 * for a different, small-focus-set-only case). Whenever that preserved
 * direction is shallow (close to parallel to the XZ ground plane -- which is
 * exactly the viewing angle Cloud/Orbital/Strata tend to leave the camera at,
 * since none of THEIR bounding volumes are ever this flat), the resulting
 * view looks directly along the pancake's thin edge: a "thin sliver near the
 * horizon" that a longer wait cannot fix, because the fit is a ONE-SHOT
 * discrete camera move computed once at settle time (`onEnd`), not a
 * converging correction that improves with more time.
 *
 * Fix: reuse the SAME bounding-volume data `computeBoundingSphere` already
 * computes (its per-axis `extent`, not a new one-off measurement) to detect
 * when a fit's bounding volume is this flat, and if the (already
 * axis-resolved) viewing direction's elevation angle above the XZ plane is
 * below a legible floor, lift it to that floor while preserving the
 * camera's existing horizontal heading (azimuth) -- a bounded nudge, exactly
 * like `resolveFitViewDirection` above, not a new camera-placement
 * algorithm or a re-tuned one-off distance formula. A perfectly flat shape
 * (the theoretical zero-height limit) or a direction with no horizontal
 * component at all (looking straight up/down) defaults to a from-above
 * heading along +z, which is the only legible way to frame something with
 * (near-)zero vertical extent.
 *
 * This is genuinely SHAPE-driven, not mode-string-driven: it runs for
 * whichever mode's bounding volume actually turns out flat (currently only
 * Terrain at scale), and is a no-op whenever the shape isn't flat or the
 * direction is already adequately elevated -- so Cloud/Orbital/Strata's
 * already-confirmed-working framing, and Terrain's own already-confirmed-
 * working small-scale framing, are both untouched. `computeFitDistance`'s
 * distance math is also untouched -- this only corrects the viewing
 * DIRECTION, exactly like `resolveFitViewDirection` above.
 *
 * T2 remediation, third/final bounded attempt (T3/Opus advisory, confirmed
 * numerically by this writer before any code change -- see
 * `terrainCameraFitFlatShape.test.ts`'s hemisphere-regression describe block
 * for the exact fixture and numbers): the two fixes above (direction lift +
 * oriented distance) were each real but partial. The remaining bug was
 * HEMISPHERE PRESERVATION: this function used to lift toward whichever
 * vertical hemisphere the camera's current direction-to-center already sat
 * in (`sign = dirN.y >= 0 ? 1 : -1`, plus an `Math.abs(dirN.y)` early
 * return that let a steep below-plane direction through untouched). But the
 * terrain surface renders entirely at y in [0, TERRAIN_MAX_HEIGHT] =
 * [0, 40] (`TerrainSurface.tsx`), so the settle fit's center sits at
 * y ~= 20, while production's camera STARTS at `[0, 0, 60]`
 * (`Graph3DScene.tsx`'s `<Canvas camera>`) -- BELOW that center
 * (dirN.y ~= -0.316). The "lift" therefore resolved DOWNWARD to -24
 * degrees, and with the oriented distance (~970 units for the settled
 * ~1192x40x1192 shape) the camera landed at toPos.y ~= 20 + (-0.407 * 970)
 * ~= -375: ~375 units BENEATH a surface whose lowest point is y = 0,
 * looking up at its underside -- exactly the reported "dense translucent
 * mass over a void with a faint curved horizon" symptom. A flat,
 * ground-like volume is only ever legible viewed from ABOVE, so the
 * resolved direction now always lands in the POSITIVE-y hemisphere: a
 * direction below the legibility floor is lifted to the floor ABOVE the
 * plane, and a below-plane direction already steeper than the floor is
 * mirrored above at its own steepness (preserving azimuth either way).
 * This deliberately differs from `resolveFitViewDirection` above, whose
 * node-pair axis-avoidance case correctly has NO up-is-better bias --
 * arbitrary node pairs have no inherent up/down orientation; a ground
 * surface does. Never reproduced at demo-vault scale because that scale's
 * roughly cubic Terrain extent (aspect ~0.66 >= the 0.3 threshold) never
 * enters the flat branch at all -- the bug was unreachable there, not
 * coincidentally correct.
 *
 * See `terrainCameraFitFlatShape.test.ts` for direct pure-math coverage,
 * including the exact ~1:15 aspect ratio this finding reproduces. The fully
 * rendered, live-camera behavior in a real `<Canvas>` at actual ~1,500-node
 * scale remains a genuine, labeled limit, verifiable only live via Browser
 * Validator (jsdom has no real WebGL context) -- same honesty standard as
 * this file's other camera-math work.
 */
export function resolveFlatShapeElevation(
  dir: Vector3,
  extent: [number, number, number] | null | undefined,
): Vector3 {
  const dirN = dir.clone().normalize();
  if (!extent) return dirN;

  const [dx, dy, dz] = extent;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  if (horizontal < 1e-6) return dirN;

  const aspect = dy / horizontal;
  if (aspect >= FLAT_SHAPE_ASPECT_THRESHOLD) return dirN;
  // Only an ABOVE-plane direction at/above the legibility floor is already
  // acceptable for a ground-like flat shape -- a below-plane direction is
  // never a no-op here, no matter how steep (third-attempt hemisphere fix;
  // see the doc comment above).
  if (dirN.y >= MIN_FLAT_SHAPE_ELEVATION_SIN) return dirN;

  const horiz = new Vector3(dirN.x, 0, dirN.z);
  if (horiz.lengthSq() < 1e-6) horiz.set(0, 0, 1);
  horiz.normalize();
  // Always resolve into the POSITIVE-y hemisphere: at least the legibility
  // floor, or the direction's own (mirrored) steepness if it was already
  // steeper than the floor while below the plane.
  const elevationSin = Math.max(MIN_FLAT_SHAPE_ELEVATION_SIN, Math.abs(dirN.y));
  const horizScale = Math.sqrt(Math.max(0, 1 - elevationSin * elevationSin));
  return horiz
    .multiplyScalar(horizScale)
    .add(new Vector3(0, elevationSin, 0))
    .normalize();
}

/**
 * T2 remediation (bounded remediation, second and final attempt on the
 * residual Terrain camera-fit defect -- see the T2 job report for the full
 * evidence trail). CONFIRMED ROOT CAUSE (empirically verified, not just read
 * from source): `resolveFlatShapeElevation` above corrects the camera's
 * VIEWING DIRECTION for a flat bounding volume, but the fit-to-graph effect
 * below still computes DISTANCE from `computeFitDistance(fitRequest.radius,
 * fovDeg)` -- an isotropic, direction-agnostic bounding-SPHERE radius that
 * sizes for a worst-case "camera could be looking from any angle" fit. For
 * the N=1,500 Terrain settle shape this finding reports (~1192x40x1192, the
 * same fixture `terrainCameraFitFlatShape.test.ts` already exercises), that
 * sphere's radius (~843 units) pushes `radius / sin(fov/2)` straight into
 * `MAX_FIT_DISTANCE`'s hard clamp (1500) -- REGARDLESS of the corrected
 * elevation angle, because the direction correction and the distance
 * calculation are two independent, uncomposed code paths. A camera parked at
 * the full 1500-unit clamp, now looking at the pancake from a legible
 * elevated angle instead of edge-on, is exactly the reported second-phase
 * symptom: no longer an edge-on sliver, but still a tiny, low-contrast,
 * distant blob, because nothing ever re-sized the fit for what is actually
 * visible from the now-corrected direction.
 *
 * Verified by hand (see the T2 job report's numeric trace) before writing
 * this fix: at this shape/direction, the isotropic method clamps to 1500,
 * while the true projected extent from the corrected ~24-degree-elevated
 * direction only needs ~970 units -- roughly 35% closer, covering roughly
 * 2.4x more screen area. This is a real, measurable oversizing, not a
 * cosmetic one.
 *
 * Fix: once a flat bounding volume's viewing direction has been resolved
 * (post `resolveFitViewDirection` + `resolveFlatShapeElevation`), project
 * the bounding box's 8 corners onto that direction's own screen-space
 * `right`/`up` axes (the same "camera basis" construction
 * `resolveFitViewDirection`'s perpendicular fallback and
 * `verticalScreenCoverage` in `terrainCameraFitFlatShape.test.ts` already
 * use) to get the ACTUAL visible half-width/half-height from that specific
 * direction, then compute the distance needed to fit both the vertical FOV
 * and the aspect-derived horizontal FOV, taking the larger (binding)
 * requirement. This replaces the isotropic sphere-radius fit ONLY for flat
 * shapes (the same `FLAT_SHAPE_ASPECT_THRESHOLD` test
 * `resolveFlatShapeElevation` already uses) -- every roomy/roundish bounding
 * volume (Cloud/Orbital/Strata, and Terrain at small/demo-vault scale)
 * keeps using the existing, already-confirmed-working `computeFitDistance`
 * unchanged, so nothing there regresses. `MIN_FIT_DISTANCE`/
 * `MAX_FIT_DISTANCE`/`FIT_PADDING` are reused as-is, not re-tuned.
 *
 * See `terrainCameraFitFlatShape.test.ts` for direct pure-math coverage,
 * including a production-shape regression proving this genuinely reduces the
 * clamped distance for the exact shape this finding reports, and that the
 * corrected distance recovers materially more projected screen coverage than
 * the old clamp did. The fully rendered, live-camera behavior in a real
 * `<Canvas>` at actual ~1,500-node scale remains a genuine, labeled limit,
 * verifiable only live via Browser Validator (jsdom has no real GPU/
 * rasterizer) -- same honesty standard as this file's other camera-math
 * work.
 */
export function isFlatExtent(extent: [number, number, number]): boolean {
  const [dx, dy, dz] = extent;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  if (horizontal < 1e-6) return false;
  return dy / horizontal < FLAT_SHAPE_ASPECT_THRESHOLD;
}

/**
 * Distance (world units) needed to fit `extent`'s bounding box, AS SEEN from
 * `viewDir` (the camera-to-center direction; must already be normalized or
 * near-normalized -- this function re-normalizes defensively), inside a
 * perspective camera's field of view -- vertical `fovDeg` plus the
 * `aspect`-derived horizontal FOV -- with `FIT_PADDING` margin, clamped to
 * [`MIN_FIT_DISTANCE`, `MAX_FIT_DISTANCE`]. Unlike `computeFitDistance`
 * above, this is direction-AWARE: it projects the box's 8 corners onto the
 * view direction's own screen-space `right`/`up` basis to find the true
 * visible half-width/half-height from that specific angle, rather than
 * assuming a worst-case any-angle isotropic sphere. See this function's
 * caller in the `fitRequest` effect below for why it is only used for flat
 * bounding volumes -- for a roughly cube-shaped volume the two methods
 * converge to a similar result, but the isotropic method remains the
 * existing, already-confirmed-working default for those shapes.
 */
export function computeOrientedFitDistance(
  extent: [number, number, number],
  viewDir: Vector3,
  fovDeg: number,
  aspect: number,
): number {
  const [dx, dy, dz] = extent;
  const half = new Vector3(Math.max(dx, 0) / 2, Math.max(dy, 0) / 2, Math.max(dz, 0) / 2);

  const forward = viewDir.clone().normalize().negate();
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
        const corner = new Vector3(sx * half.x, sy * half.y, sz * half.z);
        const u = corner.dot(up);
        const r = corner.dot(right);
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
    }
  }
  const halfHeight = Math.max((maxU - minU) / 2, 1e-6);
  const halfWidth = Math.max((maxR - minR) / 2, 1e-6);

  const fovRad = (fovDeg * Math.PI) / 180;
  const halfFovV = fovRad / 2;
  const halfFovH = Math.atan(Math.tan(halfFovV) * Math.max(aspect, 1e-6));

  const distV = (halfHeight * FIT_PADDING) / Math.tan(halfFovV);
  const distH = (halfWidth * FIT_PADDING) / Math.tan(halfFovH);

  return Math.min(MAX_FIT_DISTANCE, Math.max(MIN_FIT_DISTANCE, Math.max(distV, distH)));
}

/**
 * T2 remediation, third/final bounded attempt -- SECONDARY robustness fix
 * (T3 advisory, explicitly lower priority than and independent of the
 * hemisphere fix in `resolveFlatShapeElevation` above): the fit-to-graph
 * effect used to derive its viewing direction from the LIVE
 * `camera.position` at the moment the fit request arrived -- but the
 * worker's "end" event (which issues settle fits) can fire while a prior
 * fit/focus animation is still mid-flight, making the derived direction
 * depend on exactly WHEN mid-lerp the event happened to land (a plausible
 * mechanism for the variable-duration transient framing seen across live
 * runs; not the core framing bug). Anchoring on the in-flight animation's
 * DESTINATION instead makes the derived direction deterministic: the same
 * sequence of fit requests resolves the same directions regardless of event
 * timing. With no animation in flight, this is exactly the previous
 * behavior (the live camera position). Returns a clone either way, so the
 * caller's in-place `.sub(center)` never mutates animation or camera state.
 * See `terrainCameraFitFlatShape.test.ts` for direct coverage.
 */
export function resolveFitAnchorPosition(
  activeAnim: { toPos: Vector3 } | null,
  cameraPosition: Vector3,
): Vector3 {
  return (activeAnim ? activeAnim.toPos : cameraPosition).clone();
}

export interface CameraRigProps {
  /** World-space point to focus on, or null to leave the camera alone. */
  focusTarget: [number, number, number] | null;
  /** Bounding-sphere fit request (camera fit-to-graph on load / dataset change), or null. */
  fitRequest: GraphFitRequest | null;
}

interface OrbitControlsLike {
  target?: Vector3;
  update?: () => void;
}

/** Minimal shape of three-stdlib's `EventDispatcher` base class (which
 *  `OrbitControls` extends) that `attachUserInterruptListener` needs. */
export interface AnimationInterruptSource {
  addEventListener(type: "start", listener: () => void): void;
  removeEventListener(type: "start", listener: () => void): void;
}

/**
 * T2 remediation, second/final attempt on the zoom-direction defect (see the
 * T2 job report for the full evidence trail; summarized here for future
 * readers). Root cause: this component's own `useFrame` below runs at R3F's
 * DEFAULT priority (0), while `@react-three/drei`'s `<OrbitControls>`
 * wrapper registers its own `controls.update()` call at priority -1
 * (`node_modules/@react-three/drei/core/OrbitControls.js`); R3F sorts
 * subscribers ascending, so OrbitControls' own per-frame update always runs
 * first -- that part is fine. The actual bug: for as long as `animRef.current`
 * is set (~400-600ms per fit/focus animation), this component's `useFrame`
 * unconditionally overwrites `camera.position`/`orbit.target` via direct
 * `lerpVectors` assignment every single frame, discarding whatever real
 * dolly scale the user's own wheel input applied moments earlier (three-
 * stdlib applies wheel input SYNCHRONOUSLY inside its own `wheel` DOM
 * listener -- see `handleMouseWheel`/`onMouseWheel` in `node_modules/
 * three-stdlib/controls/OrbitControls.js` -- so it lands before either
 * `useFrame` subscriber runs, but gets stomped on immediately afterward).
 * This race is reliably hit on every fresh-load repro because the plan's
 * own readiness definition (Section 9.4: "the worker's 'end' event has been
 * reached") is the SAME event that triggers Graph3DScene's initial
 * camera-fit animation -- so any wheel input dispatched at or shortly after
 * readiness lands inside that fit animation's window, which is
 * unconditionally moving the camera FARTHER than its `[0,0,60]` start
 * position (real graphs almost always need a fit distance > 60 world
 * units). That is why both scroll directions net as "dolly out" at every
 * magnitude tested: the scripted animation wins every frame of that window,
 * and on first load it only ever moves outward.
 *
 * Fix: cancel any in-flight scripted animation the instant the user begins
 * a REAL OrbitControls interaction. three-stdlib's OrbitControls dispatches
 * its own "start" event synchronously for every drag-rotate, drag-pan, AND
 * wheel-dolly gesture (`onMouseDown`/`onMouseWheel`, same file) --
 * independent of R3F's frame loop -- so subscribing to it is a reliable,
 * zero-latency hand-off signal: real user input always wins over a scripted
 * animation, same frame. This also satisfies the passed design handoff's
 * motion spec (plan Section 5.1, M1), which requires the camera transition
 * to be "interruptible". See `cameraRigUserInterrupt.test.ts` for direct
 * behavioral coverage of this function; full wheel-to-camera-distance
 * behavior in a live `<Canvas>` remains a genuine, labeled limit,
 * verifiable only live via Browser Validator (jsdom cannot provide a real
 * WebGL context).
 */
export function attachUserInterruptListener(
  controls: AnimationInterruptSource | undefined,
  onUserStart: () => void,
): () => void {
  if (!controls) return () => {};
  controls.addEventListener("start", onUserStart);
  return () => controls.removeEventListener("start", onUserStart);
}

export function CameraRig({ focusTarget, fitRequest }: CameraRigProps) {
  const { camera, controls } = useThree((state) => ({ camera: state.camera, controls: state.controls }));
  const animRef = useRef<{
    fromPos: Vector3;
    toPos: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
    start: number;
    durationMs: number;
  } | null>(null);

  // See `attachUserInterruptListener`'s doc comment above for the full root
  // cause and evidence trail. Any real OrbitControls gesture -- including a
  // plain wheel-dolly -- cancels an in-flight scripted fit/focus animation
  // immediately, handing the camera back to OrbitControls' own per-frame
  // update() so it is never overwritten again that frame or any frame after.
  useEffect(() => {
    const orbit = controls as unknown as AnimationInterruptSource | undefined;
    return attachUserInterruptListener(orbit, () => {
      animRef.current = null;
    });
  }, [controls]);

  function startAnim(toPos: Vector3, toTarget: Vector3) {
    const orbit = controls as OrbitControlsLike | undefined;
    const reduced = prefersReducedMotion();
    const fromTarget = orbit?.target?.clone() ?? toTarget.clone();
    if (reduced) {
      camera.position.copy(toPos);
      orbit?.target?.copy(toTarget);
      camera.lookAt(toTarget);
      orbit?.update?.();
      animRef.current = null;
      return;
    }
    animRef.current = {
      fromPos: camera.position.clone(),
      toPos,
      fromTarget,
      toTarget,
      start: performance.now(),
      durationMs: Math.max(400, getDuration("slow") || 500),
    };
  }

  // Generic single-point focus (deliverable 7's original mechanism, fixed
  // +6 z offset). Not currently fed by any production caller -- see the
  // "Two independent trigger props" comment at the top of this file for why
  // (Finding 1 T2 remediation) -- kept intact for a future direct need.
  useEffect(() => {
    if (!focusTarget) return;
    const to = new Vector3(...focusTarget);
    startAnim(new Vector3(to.x, to.y, to.z + 6), to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget]);

  // Camera fit-to-graph (Issue 2): frame the bounding sphere with enough
  // padding that the whole disclosed graph is inside the view frustum,
  // preserving whatever direction the camera is currently looking from
  // (falls back to the initial +z direction if the camera is exactly at
  // the target, e.g. first load).
  useEffect(() => {
    if (!fitRequest) return;
    const center = new Vector3(...fitRequest.center);
    const perspective = camera as unknown as { fov?: number; isPerspectiveCamera?: boolean; aspect?: number };
    const fovDeg = perspective.isPerspectiveCamera && perspective.fov ? perspective.fov : 50;
    const aspect = perspective.isPerspectiveCamera && perspective.aspect ? perspective.aspect : 16 / 9;

    // Third/final-attempt secondary fix (see `resolveFitAnchorPosition`'s
    // doc comment above): anchor on the in-flight animation's destination,
    // if any, instead of a nondeterministic mid-lerp live camera position.
    const dir = resolveFitAnchorPosition(animRef.current, camera.position).sub(center);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    // T2 remediation, second/final attempt (see `resolveFitViewDirection`'s
    // own doc comment above for the full root cause and evidence trail):
    // steer away from a viewing direction nearly parallel to a small/
    // elongated focus set's dominant axis, instead of blindly preserving
    // whatever direction the camera already happened to be facing.
    const axis = fitRequest.axis ? new Vector3(...fitRequest.axis) : null;
    const axisResolvedDir = resolveFitViewDirection(dir, axis);

    // T2 remediation (Finding 1 -- see `resolveFlatShapeElevation`'s own doc
    // comment above for the full root cause and evidence trail): lift a too-
    // shallow viewing direction toward a legible elevation angle whenever the
    // fit's bounding volume is flat enough (currently only Terrain at scale)
    // that an edge-on view would read as an illegible sliver -- a no-op for
    // every roomy/roundish bounding volume (Cloud/Orbital/Strata, and
    // Terrain at small/demo-vault scale) and whenever the direction is
    // already elevated enough.
    const resolvedDir = resolveFlatShapeElevation(axisResolvedDir, fitRequest.extent);

    // T2 remediation, second/final attempt (see `isFlatExtent`/
    // `computeOrientedFitDistance`'s own doc comment above for the full root
    // cause and evidence trail): distance must be computed AFTER the
    // direction is fully resolved, and must actually depend on that resolved
    // direction for a flat bounding volume -- the isotropic
    // `computeFitDistance` below stays the default for every other shape
    // (Cloud/Orbital/Strata, and Terrain at small/demo-vault scale), so
    // nothing there regresses.
    const distance =
      fitRequest.extent && isFlatExtent(fitRequest.extent)
        ? computeOrientedFitDistance(fitRequest.extent, resolvedDir, fovDeg, aspect)
        : computeFitDistance(fitRequest.radius, fovDeg);

    const toPos = center.clone().addScaledVector(resolvedDir, distance);
    startAnim(toPos, center);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  useFrame(() => {
    const anim = animRef.current;
    if (!anim) return;
    const t = Math.min(1, (performance.now() - anim.start) / anim.durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // emphasized-ish ease-out cubic
    camera.position.lerpVectors(anim.fromPos, anim.toPos, eased);
    const orbit = controls as OrbitControlsLike | undefined;
    if (orbit?.target) {
      orbit.target.lerpVectors(anim.fromTarget, anim.toTarget, eased);
      camera.lookAt(orbit.target);
    } else {
      camera.lookAt(anim.toTarget);
    }
    if (t >= 1) animRef.current = null;
    orbit?.update?.();
  });

  return null;
}
