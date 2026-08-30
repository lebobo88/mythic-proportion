// Deselection (user-reported usability gap; plan Section 5.1 J-FOCUS:
// "selection persists until reselect or clear") -- structural wiring guards,
// same convention as `graph3DSceneModeWiring.structural.test.ts`.
//
// The load-bearing safety invariant this file pins: clearing a selection
// must NEVER re-enter the camera-fit machinery. The selection-scoped fit
// effect in Graph3DScene.tsx already early-returns on a null `selectedId`,
// so `selectedId = null` issues no new fit request and the camera stays
// exactly where it is -- that early-return IS the deselect camera behavior,
// and this test exists so a future edit can't remove it (or wire a
// deselect-time re-fit) without a deliberate, visible test change.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const graph3DSceneSource = readFileSync(join(__dirname, "..", "three", "Graph3DScene.tsx"), "utf-8");
const graphViewSource = readFileSync(join(__dirname, "..", "GraphView.tsx"), "utf-8");

describe("deselection wiring and camera-fit non-interaction (structural)", () => {
  it("the selection-scoped camera-fit effect still early-returns on a null selection -- clearing a selection can never issue a new fit request", () => {
    expect(graph3DSceneSource).toMatch(/useEffect\(\(\) => \{\s*if \(!selectedId\) return;/);
  });

  it("the Canvas wires onPointerMissed to the clear-selection prop (R3F fires it only for a genuine click whose pointer travelled <= 2px since pointerdown and hit nothing -- an OrbitControls drag-release can never trigger it)", () => {
    expect(graph3DSceneSource).toMatch(/onPointerMissed=\{onClearSelection\}/);
  });

  it("the clear-selection prop is consumed ONLY by the props interface, the outer destructure, and the Canvas wiring -- never by any fit-request path", () => {
    const occurrences = graph3DSceneSource.match(/onClearSelection/g) ?? [];
    expect(occurrences).toHaveLength(3);
  });

  it("GraphView's clearSelection nulls selectedId AND re-baselines the pointer-derived hoveredId (the stale-hover stuck-highlight fix), never touching expandedIds, filters, or any fit machinery", () => {
    expect(graphViewSource).toMatch(
      /const clearSelection = useCallback\(\(\) => \{\s*setSelectedId\(null\);\s*setHoveredId\(null\);\s*\}, \[\]\);/,
    );
    // The clear path must never expand/collapse disclosure state or issue a
    // camera fit -- same invariant as before this remediation.
    const clearBody = /const clearSelection = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/.exec(graphViewSource)?.[1] ?? "";
    expect(clearBody).not.toMatch(/setExpandedIds|setFilter|setFitRequest/);
  });
});
