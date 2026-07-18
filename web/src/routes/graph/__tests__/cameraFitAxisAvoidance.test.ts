// T2 remediation, second and final bounded attempt on this specific residual
// framing issue (see `resolveFitViewDirection`'s doc comment in
// `CameraRig.tsx` and `computeFocusAxis`'s doc comment in `Graph3DScene.tsx`
// for the full root-cause and evidence trail; summarized here for future
// readers).
//
// The prior fix for "extreme illegible zoom on selection" is confirmed
// working for the general case. A residual edge case survived: selecting a
// degree-1 node whose single neighbor happens to sit nearly along the
// camera's CURRENT viewing direction produces a degenerate, edge-on framing
// -- both points collapse to nearly the same screen position, with no
// visible edge -- even though the node, neighbor, and edge are genuinely in
// the scene (confirmed live on "Halcyon Thruster"->"Orbital Dynamics" and
// "Meridian Logistics"->"Acme Robotics"). ROOT CAUSE, confirmed by reading
// `CameraRig.tsx`'s fit-application effect: the fit-to-graph path only ever
// adjusted DISTANCE and TARGET; it preserved whatever viewing DIRECTION the
// camera already happened to have
// (`dir = camera.position.clone().sub(center)`), so a coincidentally
// axis-aligned prior camera angle produced the degenerate framing whenever
// the focus set was a small, elongated (2-point) line.
//
// Fix: `computeFocusAxis` (Graph3DScene.tsx) computes the dominant direction
// of a small (<=3 point) focus set; `resolveFitViewDirection` (CameraRig.tsx)
// steers the camera's viewing direction away from that axis, toward a
// perpendicular direction, whenever the two are nearly parallel -- this
// maximizes the two focus points' projected lateral (screen-space)
// separation, which is exactly what avoids the degenerate edge-on case. This
// is exercised here directly against the pure math (this directory's
// established convention -- jsdom cannot provide a real WebGL/Canvas
// context), including an explicit screen-space projection check (not just an
// angle check) per the job's own "actually check the degenerate case is
// avoided" requirement. The fully rendered, live-camera behavior in a real
// browser remains a genuine, labeled limit, verifiable only live via Browser
// Validator, same honesty standard as this app's other camera-math work.
import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { resolveFitViewDirection } from "../three/CameraRig";
import { computeBoundingSphere, computeFocusAxis } from "../three/Graph3DScene";

/**
 * Projects `pointA`/`pointB` onto the screen-space "right" axis of a camera
 * positioned at `cameraPos` and looking toward the two points' midpoint --
 * the same question a real perspective camera answers when deciding whether
 * two points are visually distinguishable, not merely an angle heuristic.
 * Uses the standard `right = worldUp x forward` basis (falling back to
 * world-right when `forward` is itself parallel to world-up), matching the
 * basis `resolveFitViewDirection` reasons about internally.
 */
function lateralScreenSeparation(pointA: Vector3, pointB: Vector3, cameraPos: Vector3): number {
  const midpoint = pointA.clone().add(pointB).multiplyScalar(0.5);
  const forward = midpoint.clone().sub(cameraPos).normalize();
  let right = new Vector3(0, 1, 0).cross(forward);
  if (right.lengthSq() < 1e-6) right = new Vector3(1, 0, 0).cross(forward);
  right.normalize();
  const aOnRight = pointA.clone().sub(cameraPos).dot(right);
  const bOnRight = pointB.clone().sub(cameraPos).dot(right);
  return Math.abs(aOnRight - bOnRight);
}

describe("computeFocusAxis (Graph3DScene.tsx) -- dominant direction of a small focus set", () => {
  it("returns the raw direction vector between exactly two focus points", () => {
    const indexMap = new Map([
      ["selected", 0],
      ["neighbor", 1],
    ]);
    const positions = new Float32Array([0, 0, 0, 0, 0, 40]);
    const axis = computeFocusAxis(indexMap, positions, new Set(["selected", "neighbor"]));
    expect(axis).toEqual([0, 0, 40]);
  });

  it("returns the farthest pair's direction for a 3-point focus set", () => {
    const indexMap = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    // a-c is the farthest pair (distance 50), a-b and b-c are both shorter.
    const positions = new Float32Array([0, 0, 0, 3, 4, 0, 30, 40, 0]);
    const axis = computeFocusAxis(indexMap, positions, new Set(["a", "b", "c"]));
    expect(axis).toEqual([30, 40, 0]);
  });

  it("returns null for a focus set of more than 3 points -- bounded to the small-set case, never an O(n^2) scan against a large/roomy fit", () => {
    const indexMap = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ]);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(computeFocusAxis(indexMap, positions, new Set(["a", "b", "c", "d"]))).toBeNull();
  });

  it("returns null for a single-node (no-neighbor) focus set", () => {
    const indexMap = new Map([["selected", 0]]);
    const positions = new Float32Array([5, 5, 5]);
    expect(computeFocusAxis(indexMap, positions, new Set(["selected"]))).toBeNull();
  });

  it("returns null for coincident points -- no meaningful direction to avoid", () => {
    const indexMap = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    const positions = new Float32Array([1, 1, 1, 1, 1, 1]);
    expect(computeFocusAxis(indexMap, positions, new Set(["a", "b"]))).toBeNull();
  });
});

describe("resolveFitViewDirection (CameraRig.tsx) -- steer the fit viewing direction away from a near-parallel focus axis", () => {
  it("is a no-op when no axis is supplied -- the general, already-confirmed-working fit fix for a roomy/roundish focus set is untouched", () => {
    const dir = new Vector3(0.3, 0.1, 0.9).normalize();
    const resolved = resolveFitViewDirection(dir.clone(), null);
    expect(resolved.x).toBeCloseTo(dir.x, 5);
    expect(resolved.y).toBeCloseTo(dir.y, 5);
    expect(resolved.z).toBeCloseTo(dir.z, 5);
  });

  it("leaves the direction untouched when it already has meaningful separation from the focus axis", () => {
    const dir = new Vector3(1, 0, 0);
    const axis = new Vector3(0, 0, 1); // perpendicular to dir -- already fine
    const resolved = resolveFitViewDirection(dir, axis);
    expect(resolved.dot(dir.clone().normalize())).toBeGreaterThan(0.99);
  });

  it("corrects a direction that is anti-parallel (not just parallel) to the axis -- both project the same degenerate way", () => {
    const dir = new Vector3(0, 0, -1);
    const axis = new Vector3(0, 0, 1);
    const resolved = resolveFitViewDirection(dir, axis);
    // Must no longer be (anti-)parallel to the axis.
    expect(Math.abs(resolved.dot(axis.clone().normalize()))).toBeLessThan(0.98);
  });

  it("THE REGRESSION CASE: a 2-point focus set positioned exactly along the camera's current viewing axis produces a degenerate near-zero lateral screen-space separation with the OLD (axis-blind) direction, and a meaningful separation once resolveFitViewDirection is applied", () => {
    // Selected node + its single neighbor, 40 world units apart along +z --
    // the exact "degree-1 node whose neighbor sits nearly along the
    // camera's current viewing axis" repro from the finding.
    const indexMap = new Map([
      ["selected", 0],
      ["neighbor", 1],
    ]);
    const positions = new Float32Array([0, 0, -20, 0, 0, 20]);
    const focusIds = new Set(["selected", "neighbor"]);

    const fit = computeBoundingSphere(indexMap, positions, focusIds);
    expect(fit).not.toBeNull();
    const center = new Vector3(...fit!.center);

    const axisArr = computeFocusAxis(indexMap, positions, focusIds);
    expect(axisArr).not.toBeNull();
    const axis = new Vector3(...axisArr!);

    const pointA = new Vector3(0, 0, -20);
    const pointB = new Vector3(0, 0, 20);
    const distance = 100;

    // The camera's pre-existing viewing direction happens to sit ALONG the
    // same axis as the two focus points -- the exact coincidence the
    // finding describes.
    const staleDir = new Vector3(0, 0, 1);
    const staleCameraPos = center.clone().addScaledVector(staleDir, distance);
    const staleSeparation = lateralScreenSeparation(pointA, pointB, staleCameraPos);
    // Confirms the OLD (axis-blind) behavior really is degenerate here --
    // this is the failure being fixed, not a strawman.
    expect(staleSeparation).toBeLessThan(0.5);

    const resolvedDir = resolveFitViewDirection(staleDir, axis);
    const resolvedCameraPos = center.clone().addScaledVector(resolvedDir, distance);
    const resolvedSeparation = lateralScreenSeparation(pointA, pointB, resolvedCameraPos);

    // Meaningful, not just "some": recovers a sizeable fraction of the two
    // points' true 40-unit separation, not merely a nonzero epsilon.
    expect(resolvedSeparation).toBeGreaterThan(15);
  });

  it("THE REGRESSION CASE, off-axis-but-still-too-close variant: a stale direction only a few degrees off the focus axis is still corrected (not just the exact-parallel case)", () => {
    const pointA = new Vector3(0, 0, -20);
    const pointB = new Vector3(0, 0, 20);
    const axis = new Vector3(0, 0, 40);
    const center = new Vector3(0, 0, 0);
    const distance = 100;

    // ~6 degrees off pure +z -- still well inside the "nearly parallel"
    // danger zone (AXIS_PARALLEL_COS_THRESHOLD is ~12 degrees), not the
    // exact axis-aligned case already covered above.
    const staleDir = new Vector3(Math.sin((6 * Math.PI) / 180), 0, Math.cos((6 * Math.PI) / 180)).normalize();
    const staleCameraPos = center.clone().addScaledVector(staleDir, distance);
    const staleSeparation = lateralScreenSeparation(pointA, pointB, staleCameraPos);
    expect(staleSeparation).toBeLessThan(10); // still meaningfully degraded

    const resolvedDir = resolveFitViewDirection(staleDir, axis);
    const resolvedCameraPos = center.clone().addScaledVector(resolvedDir, distance);
    const resolvedSeparation = lateralScreenSeparation(pointA, pointB, resolvedCameraPos);
    expect(resolvedSeparation).toBeGreaterThan(staleSeparation);
    expect(resolvedSeparation).toBeGreaterThan(15);
  });

  it("never collapses to a near-zero-length result even when the focus axis is exactly world-up (the perpendicular fallback path)", () => {
    const dir = new Vector3(0, 1, 0);
    const axis = new Vector3(0, 1, 0);
    const resolved = resolveFitViewDirection(dir, axis);
    expect(resolved.length()).toBeCloseTo(1, 5);
    expect(Number.isFinite(resolved.x)).toBe(true);
    expect(Number.isFinite(resolved.y)).toBe(true);
    expect(Number.isFinite(resolved.z)).toBe(true);
  });
});

describe("Graph3DScene wires the focus axis into its selection fit request (structural -- confirms the exported pure functions above are actually connected, not merely defined)", () => {
  it("computes computeFocusAxis alongside computeBoundingSphere inside computeSelectionFit, which the selection effect routes through into setFitRequest", async () => {
    // T3-advisory H2/H3 refactor note: the selection effect's inline
    // neighborsOf/computeBoundingSphere/computeFocusAxis body moved into the
    // shared pure helper `computeSelectionFit` (so the settle handler can
    // issue the identical fit) -- this test's original intent (the axis is
    // genuinely computed and passed through to the fit request, never merely
    // defined) is asserted against that helper plus the effect that calls it.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "three", "Graph3DScene.tsx"), "utf-8");
    const helperMatch = /export function computeSelectionFit\(([\s\S]*?)\n\}/.exec(source);
    expect(helperMatch).not.toBeNull();
    expect(helperMatch![1]).toMatch(/computeBoundingSphere\(/);
    expect(helperMatch![1]).toMatch(/computeFocusAxis\(/);
    const effectMatch = /useEffect\(\(\) => \{\s*if \(!selectedId\) return;([\s\S]*?)\n {2}\}, \[selectedId\]\);/.exec(
      source,
    );
    expect(effectMatch).not.toBeNull();
    const body = effectMatch![1];
    expect(body).toMatch(/computeSelectionFit\(/);
    expect(body).toMatch(/setFitRequest\(\{[\s\S]*?axis[\s\S]*?\}\);/);
  });

  it("CameraRig.tsx's fit-application effect resolves the axis via resolveFitViewDirection before computing the fit position", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "three", "CameraRig.tsx"), "utf-8");
    expect(source).toMatch(/resolveFitViewDirection\(\s*dir,\s*axis\s*\)/);
  });
});
