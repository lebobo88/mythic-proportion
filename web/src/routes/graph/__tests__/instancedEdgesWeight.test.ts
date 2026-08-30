// Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.6 item
// 3 / Section 6 Phase 3): InstancedEdges' fat-line weight wiring -- weight
// drives width AND opacity independently, still through exactly one batched
// draw call. jsdom cannot exercise a real LineSegments2/WebGL draw call, so
// -- following this directory's established convention (see
// instancedNodesMaterial.test.ts, nodeMaterialShader.test.ts) -- the pure
// weight->width/opacity mapping itself is unit-tested directly in
// edgeWeight.test.ts; this file confirms the WIRING via a structural source
// check (the same technique graphPerf.synthetic.test.ts already uses for
// this exact file's single-batched-pass invariant).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InterleavedBufferAttribute } from "three";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

const THREE_DIR = join(__dirname, "..", "three");
function readSource(fileName: string): string {
  return readFileSync(join(THREE_DIR, fileName), "utf-8");
}

describe("InstancedEdges: fat-line pass wiring (Section 5.6 item 3)", () => {
  const source = readSource("InstancedEdges.tsx");

  it("constructs exactly one LineSegmentsGeometry/LineMaterial/LineSegments2 -- one batched pass, not one line object per edge", () => {
    expect(source.match(/new LineSegmentsGeometry\(/g)).toHaveLength(1);
    expect(source.match(/new LineMaterial\(/g)).toHaveLength(1);
    expect(source.match(/new LineSegments2\(/g)).toHaveLength(1);
    expect(source).toMatch(/<primitive object=\{line2\}/);
  });

  it("patches the material via the shared edgeLineShader per-instance-width wiring, not a hand-rolled duplicate", () => {
    expect(source).toMatch(/from "\.\/edgeLineShader"/);
    expect(source).toMatch(/patchEdgeLineMaterial\(/);
  });

  it("weight drives width AND opacity independently via the shared edgeWeight helpers, never a fabricated/hand-rolled second mapping", () => {
    expect(source).toMatch(/from "\.\.\/edgeWeight"/);
    expect(source).toMatch(/edgeWeightFraction\(/);
    expect(source).toMatch(/edgeWeightToWidth\(/);
    expect(source).toMatch(/edgeWeightToOpacity\(/);
  });

  it("clamps the instanced draw to the visible edge count via geometry.instanceCount -- the fat-line analog of the pre-Phase-3 setDrawRange cull, an actual GPU-side cull, not a recolor", () => {
    expect(source).toMatch(/geometry\.instanceCount = visible\.length/);
  });

  it("still filters to visibleIds BEFORE any color/width work occurs (the pre-Phase-3 visibility fix, carried forward unchanged)", () => {
    expect(source).toMatch(
      /edges\.filter\(\(edge\) => visibleIds\.has\(edge\.source\) && visibleIds\.has\(edge\.target\)\)/,
    );
  });

  it("applyPositions never allocates a Map or iterates the full edge list per tick (reflexion critique item 2, carried forward unchanged)", () => {
    const applyPositionsBody = /applyPositions\(positions, idIndexMap\) \{([\s\S]*?)\n {6}\},/.exec(source)?.[1] ?? "";
    expect(applyPositionsBody.length).toBeGreaterThan(0);
    expect(applyPositionsBody).not.toMatch(/new Map/);
    expect(applyPositionsBody).toMatch(/visibleEdgesRef\.current/);
    expect(applyPositionsBody).not.toMatch(/for \(let i = 0; i < edges\.length/);
  });

  it("an edge with no served weight falls back to the width/opacity token defaults via edgeWeightFraction's null path, never a fabricated value (J5-EDGE-WEIGHT)", () => {
    // edgeWeightFraction(edge.weight) is passed straight through to both
    // edgeWeightToWidth/edgeWeightToOpacity -- the null-fallback contract
    // itself is exhaustively unit-tested in edgeWeight.test.ts; this only
    // confirms InstancedEdges actually threads `edge.weight` (not a
    // synthesized/defaulted number) into that shared function.
    expect(source).toMatch(/edgeWeightFraction\(edge\.weight\)/);
  });
});

// VERIFICATION_NEEDS_FIX remediation (Fix 1, blocker -- T2 remediation cycle
// 1): `LineSegmentsGeometry.setPositions` (called once, with all-zero
// placeholder data, at GPU-buffer-allocation time) EAGERLY computes the
// bounding box/sphere from whatever data it's given, locking in a
// degenerate origin-centered, radius-0 sphere. `applyPositions` then mutates
// `instanceStart`/`instanceEnd` per tick but never recomputes or invalidates
// that bound. Three's own frustum test (`Frustum.intersectsObject`, in
// `Frustum.js`) only calls `geometry.computeBoundingSphere()` when
// `boundingSphere` is `null` -- so the stale, degenerate bound would
// permanently govern this single batched edge object's visibility,
// independent of where the actual graph is. Fixed by disabling
// `frustumCulled` on the one batched edge object entirely (there is only
// ever ONE such object, so per-object frustum culling buys nothing and this
// removes the whole defect class, rather than needing to remember to
// recompute the bound on every tick).
describe("InstancedEdges frustum-culling fix (VERIFICATION_NEEDS_FIX Fix 1, blocker)", () => {
  it("reproduces the underlying defect with REAL three classes: LineSegmentsGeometry.setPositions with placeholder zero data locks in a degenerate origin/zero-radius bounding sphere that a later position mutation via .setXYZ does NOT invalidate", () => {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(6)); // one segment, all zeros -- mirrors InstancedEdges.tsx's capacity-allocation call
    expect(geometry.boundingSphere).not.toBeNull();
    expect(geometry.boundingSphere!.radius).toBe(0);
    expect(geometry.boundingSphere!.center.length()).toBe(0);

    // Simulate a real applyPositions tick moving the edge far from the origin.
    const startAttr = geometry.getAttribute("instanceStart") as InterleavedBufferAttribute;
    const endAttr = geometry.getAttribute("instanceEnd") as InterleavedBufferAttribute;
    startAttr.setXYZ(0, 1000, 1000, 1000);
    endAttr.setXYZ(0, 1000, 1000, 1000);

    // The bug: boundingSphere is STILL the stale degenerate origin sphere --
    // nothing recomputes it on a position mutation alone. A camera framed on
    // the moved-away edges (the normal case after any real camera-fit) would
    // NOT see world-origin in its frustum, so `Frustum.intersectsObject`
    // would incorrectly report this object as not visible if frustumCulled
    // were left enabled.
    expect(geometry.boundingSphere!.radius).toBe(0);
    expect(geometry.boundingSphere!.center.length()).toBe(0);
  });

  it("InstancedEdges disables frustumCulled on the single batched edge object, so three's per-object frustum test (which would consult the stale bound reproduced above) is never consulted at all", () => {
    const source = readSource("InstancedEdges.tsx");
    expect(source).toMatch(/line2\.frustumCulled = false/);
  });
});

// VERIFICATION_NEEDS_FIX remediation (Fix 2, major -- T2 remediation cycle
// 1): weight-driven "opacity" must be genuine per-instance alpha (via
// edgeLineShader.ts's instanceOpacity/vOpacity patch), NOT the
// color-blend-toward-BLACK proxy the first implementation used (which reads
// backward in light theme -- `--graph-bg` is near-white there, so darkening
// toward black makes a LOW-weight edge MORE prominent, the opposite of the
// intended encoding). The PRE-EXISTING selection/hover dim (blend toward
// BLACK on focusFadeT) is unchanged/out of this fix's bounded scope -- only
// weight's contribution to that blend is removed.
describe("InstancedEdges weight-opacity fix: genuine per-instance alpha, not a background-color-coupled blend (VERIFICATION_NEEDS_FIX Fix 2, major)", () => {
  const source = readSource("InstancedEdges.tsx");

  it("writes edgeWeightToOpacity's result into a real instanceOpacity attribute, mirroring the instanceWidth pattern", () => {
    expect(source).toMatch(/setAttribute\("instanceOpacity", new InstancedBufferAttribute/);
    expect(source).toMatch(/opacityAttr\.array\[i\] = weightOpacity/);
  });

  it("no longer folds weight-driven opacity into the color-blend fadeT -- the mixColor blend uses ONLY the pre-existing focus/selection dim, unchanged from before this remediation", () => {
    // The fadeT fed into mixColor(...) must be exactly the pre-existing
    // focus-only computation -- never `Math.max(focusFadeT, weightFadeT)`
    // or any other weight-derived contribution.
    expect(source).not.toMatch(/weightFadeT/);
    expect(source).not.toMatch(/Math\.max\(focusFadeT/);
    const mixColorCallIndex = source.indexOf("mixColor(base, BLACK,");
    expect(mixColorCallIndex).toBeGreaterThan(-1);
    expect(source.slice(mixColorCallIndex, mixColorCallIndex + 40)).toMatch(/mixColor\(base, BLACK, focusFadeT\)/);
  });

  it("never reads a background/theme CSS token to compute weight-opacity -- genuine alpha needs no background coupling at all (a documentation comment MAY mention the rejected background-blend approach by name; only functional token reads are checked here)", () => {
    expect(source).not.toMatch(/readVar\(.*bg/i);
    expect(source).not.toMatch(/getPropertyValue\(.*bg/i);
    expect(source).not.toMatch(/colors\.\w*[Bb]ackground\w*/);
  });
});
