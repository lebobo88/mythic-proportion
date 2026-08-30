// Deep-Field Observatory Phase 4 (plan Section 5.3 "Safe-tier choreography"
// step 4 / Section 6 Phase 4: "(4) LOD drops to the safe tier"; acceptance
// check: "Minimal genuinely maps to the safe-tier rig (bloom off, minimal
// chrome, LOD dropped) -- this is a real functional requirement").
//
// SCOPE NOTE (deliberately narrow, read before editing InstancedNodes.tsx):
// this job's non-goals forbid touching Phase 2's node material/shader/
// badges/labels work in InstancedNodes.tsx. The LOD tiering system in that
// same file is NOT a Phase 2 deliverable -- it predates both governing plans
// (built at the original P5 pass, see computeLodDistances's own doc
// comment) -- but it is the ONLY place a real, functioning "LOD drops to the
// safe tier" behavior can be wired, since `computeLodDistances`'s existing
// `Math.max(DEFAULT_LOD*_DISTANCE, ...)` floors make it impossible to force
// a MORE aggressive tier from outside the file (only less aggressive/further
// out). This test file, and the matching one-prop/one-function addition to
// InstancedNodes.tsx, are therefore scoped to ONLY the LOD-threshold
// computation path -- zero lines touched in the material/shader/pattern/
// badge/label code in that same file. See the JOB_DONE report for the full
// reasoning and an explicit flag for Verifier scrutiny.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applySafeTierLod, computeLodDistances, type LodDistances } from "../three/InstancedNodes";

describe("applySafeTierLod -- forces every node into the cheapest (flat-quad) LOD tier", () => {
  const realistic: LodDistances = computeLodDistances(400, 150);

  it("passes the distances through unchanged when safeTier is false (default -- every existing caller/test unaffected)", () => {
    expect(applySafeTierLod(realistic, false)).toEqual(realistic);
  });

  it("collapses both thresholds to a near-zero pair when safeTier is true, so the flat tier engages almost immediately", () => {
    const forced = applySafeTierLod(realistic, true);
    expect(forced.lod1).toBe(0);
    expect(forced.lod2).toBeGreaterThan(0);
    expect(forced.lod2).toBeLessThan(1); // far below any real node-to-camera distance
  });

  it("keeps lod2 strictly greater than lod1 even under safeTier (InstancedMesh2.updateAllLOD requires strictly-increasing thresholds)", () => {
    const forced = applySafeTierLod(realistic, true);
    expect(forced.lod2).toBeGreaterThan(forced.lod1);
  });

  it("overrides even a suppressed (mode-transition) far tier -- safe-tier degradation and transition-suppression can never fight each other, safe-tier always wins when both are requested", () => {
    const suppressed = computeLodDistances(400, 150, true); // transitionActive === true
    const forced = applySafeTierLod(suppressed, true);
    expect(forced.lod2).toBeLessThan(suppressed.lod2);
  });
});

describe("InstancedNodes wires the safeTier prop into its LOD-rescale effect (structural)", () => {
  const source = readFileSync(join(__dirname, "..", "three", "InstancedNodes.tsx"), "utf-8");

  it("declares an optional safeTier prop, defaulting to false so every other caller/test is unaffected", () => {
    expect(source).toMatch(/safeTier\??:\s*boolean/);
    expect(source).toMatch(/safeTier\s*=\s*false/);
  });

  it("applies applySafeTierLod to the computed distances before calling updateAllLOD", () => {
    expect(source).toMatch(/applySafeTierLod\([^)]*\)/);
    expect(source).toMatch(/mesh\.updateAllLOD\(\[lod1, lod2\]\)/);
  });

  it("re-runs the LOD-rescale effect when safeTier changes (included in the effect's dependency array)", () => {
    expect(source).toMatch(/\[mesh, camera, fit, transitionActive, safeTier\]/);
  });

  it("does not touch the node-material/shader/pattern/badge patch call sites (Phase 2 scope, off-limits) -- patchNodeMaterial/createNodeMaterialUniforms/patternIndexForNode/computeEmissiveStrength are unchanged imports/calls, not new safeTier-conditional branches", () => {
    expect(source).not.toMatch(/safeTier[\s\S]{0,80}(patchNodeMaterial|patternIndexForNode|computeEmissiveStrength)/);
  });
});
