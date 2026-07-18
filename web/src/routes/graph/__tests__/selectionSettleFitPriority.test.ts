// T3 advisory remediation (the "Meridian Logistics" framing defect).
//
// H2 (settle-fit vs selection-fit race): Graph3DScene's worker settle handler
// (`onEnd`) and its selection-focus effect used to share one
// `fitNonceRef`/`setFitRequest` with NO sequencing -- a late-arriving settle
// event (the sim still cooling when the user clicked) issued a WHOLE-GRAPH
// fit that stomped the active user-selection fit, which is exactly the
// "reverted to whole-graph view" failure shape observed live. The fix makes
// the settle handler selection-aware: while a node is selected it re-issues
// the SELECTION fit (with the freshly settled positions -- strictly better
// than suppressing) and only falls back to the whole-graph fit when nothing
// is selected or the selection has no resolvable positions at all.
//
// H3 (silently dropped fit): the selection effect used to early-return with
// no fit at all when the clicked id had no position yet (first tick still
// pending). Both paths now share one pure, exported helper --
// `computeSelectionFit` -- and the H2 fix doubles as the H3 fallback: a
// click-time miss is retried by the settle handler once positions exist.
//
// Convention note: the fit logic lives inside an R3F scene component that
// jsdom cannot mount (no WebGL), so -- exactly like `computeBoundingSphere`/
// `computeFocusAxis`/`isStaleTickRevision` before it -- the computation is a
// pure exported function tested directly, plus structural source assertions
// that confirm the component actually wires it into both call sites.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSelectionFit } from "../three/Graph3DScene";

describe("computeSelectionFit (Graph3DScene.tsx) -- the one selection-scoped fit computation shared by the click effect and the settle handler", () => {
  const indexMap = new Map([
    ["a", 0],
    ["b", 1],
    ["c", 2],
  ]);
  // a and b are 30 units apart on x; c is a far-away isolated node.
  const positions = new Float32Array([0, 0, 0, 30, 0, 0, 500, 500, 500]);
  const edges = [{ source: "a", target: "b" }];

  it("frames the selected node plus its 1-hop neighbors, with a focus axis for a small set", () => {
    const fit = computeSelectionFit(indexMap, positions, edges, "a");
    expect(fit).not.toBeNull();
    expect(fit!.center).toEqual([15, 0, 0]);
    expect(fit!.radius).toBe(15);
    // Two resolved points -> a meaningful dominant direction (edge-on
    // avoidance stays wired in, exactly as the prior camera fix required).
    expect(fit!.axis).not.toBeNull();
  });

  it("frames a genuinely isolated selected node alone at the radius floor, with no axis", () => {
    const fit = computeSelectionFit(indexMap, positions, edges, "c");
    expect(fit).not.toBeNull();
    expect(fit!.center).toEqual([500, 500, 500]);
    expect(fit!.radius).toBe(8);
    expect(fit!.axis).toBeNull();
  });

  it("returns null when the selected id has no resolved position yet (the H3 seam -- the settle handler retries it)", () => {
    expect(computeSelectionFit(new Map(), new Float32Array(0), edges, "a")).toBeNull();
  });
});

describe("settle-fit vs selection-fit sequencing (structural -- confirms the pure helper above is wired into BOTH call sites)", () => {
  const source = readFileSync(join(__dirname, "..", "three", "Graph3DScene.tsx"), "utf-8");

  it("the worker settle handler (onEnd) re-issues the SELECTION fit while a node is selected, before ever considering a whole-graph fit", () => {
    const endMatch = /onEnd: \(\) => \{([\s\S]*?)\n {4}\},/.exec(source);
    expect(endMatch).not.toBeNull();
    const body = endMatch![1];
    expect(body).toMatch(/if \(selectedId\)/);
    const selectionIdx = body.indexOf("computeSelectionFit(");
    const wholeGraphIdx = body.indexOf("computeBoundingSphere(");
    expect(selectionIdx).toBeGreaterThan(-1);
    expect(wholeGraphIdx).toBeGreaterThan(selectionIdx);
  });

  it("the selection effect routes through the same computeSelectionFit helper and passes its axis into the fit request", () => {
    const effectMatch = /useEffect\(\(\) => \{\s*if \(!selectedId\) return;([\s\S]*?)\n {2}\}, \[selectedId\]\);/.exec(
      source,
    );
    expect(effectMatch).not.toBeNull();
    const body = effectMatch![1];
    expect(body).toMatch(/computeSelectionFit\(/);
    expect(body).toMatch(/setFitRequest\(\{[\s\S]*?axis[\s\S]*?\}\);/);
  });
});
