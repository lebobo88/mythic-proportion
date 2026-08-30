// T3-advised escalation remediation (plan Section 11's documented "T3 Opus
// advisory + Fable engineering pass" track; live Browser Validator finding:
// leaving Terrain mode produced a giant distorted black label smear).
//
// CONFIRMED ROOT CAUSE (T3's hypothesis was directionally right -- the
// distance basis is wrong -- but this writer's own source trace found the
// DOMINANT mechanism is staleness, not the origin-vs-target basis alone):
// `NodeLabels.applyPositions` recomputed the screen-space-minimum font floor
// ONLY inside the worker tick path, from `camera.position.length()` (distance
// to the WORLD ORIGIN). d3-force stops ticking entirely once "end" fires
// (`forceLayout.worker.ts` -- the sim freezes itself), and that SAME "end"
// event is what triggers the settle-fit camera animation. So the font floor
// was always computed at the PRE-fit camera distance and then frozen while
// the camera moved. Leaving Terrain is the worst case: Terrain's
// extent-aware fit parks the camera the farthest away (oriented fit up to
// ~970-1500 world units), so the frozen floor was enormous in world units;
// the incoming mode's much closer settle fit then rendered those huge
// world-size, black-outlined glyphs close-up -- the reported smear -- with
// nothing ever recomputing them (no further ticks arrive while settled).
//
// Fix under test: font sizing moves out of the tick path into a per-frame
// refs-only refresh (`useFrame`, the same discipline Graph3DScene's bloom/
// fog easing already uses -- mesh property mutation, never setState), based
// on each label's OWN camera distance (`camera.position.distanceTo(...)`,
// which also subsumes T3's origin-vs-target correction), with a ratio
// hysteresis (`shouldRefreshLabelFontSize`) so troika only re-syncs glyphs
// on a material (>= 10%) change -- never thrashing SDF layout every frame.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeScreenSpaceWorldSize, shouldRefreshLabelFontSize } from "../three/NodeLabels";

function readSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("shouldRefreshLabelFontSize (NodeLabels.tsx) -- hysteresis so per-frame tracking never thrashes troika's SDF layout", () => {
  it("does not refresh for an identical or sub-threshold (<10%) change in either direction", () => {
    expect(shouldRefreshLabelFontSize(1.2, 1.2)).toBe(false);
    expect(shouldRefreshLabelFontSize(1.2, 1.25)).toBe(false);
    expect(shouldRefreshLabelFontSize(1.2, 1.15)).toBe(false);
  });

  it("refreshes on a material (>=10%) grow or shrink", () => {
    expect(shouldRefreshLabelFontSize(1.2, 1.4)).toBe(true);
    expect(shouldRefreshLabelFontSize(1.2, 1.0)).toBe(true);
    // The defect's own magnitude: a ~13x stale-to-correct ratio.
    expect(shouldRefreshLabelFontSize(13.4, 1.2)).toBe(true);
  });

  it("always refreshes away from a degenerate/uninitialized current size, and never toward a non-positive target", () => {
    expect(shouldRefreshLabelFontSize(0, 1.2)).toBe(true);
    expect(shouldRefreshLabelFontSize(Number.NaN, 1.2)).toBe(true);
    expect(shouldRefreshLabelFontSize(1.2, 0)).toBe(false);
  });
});

describe("the frozen-floor defect, quantified with the existing pure sizing math (documents the mechanism the fix removes)", () => {
  it("a font floor computed at Terrain's far fit distance renders at >~100px -- not the intended 10px minimum -- once the camera settles close after a mode switch", () => {
    const fov = 50;
    const viewportHeightPx = 900;
    const minPx = 10;
    const terrainFitDistance = 1342; // isotropic clamp region for a large settle shape
    const incomingModeFitDistance = 100;
    const staleWorldSize = computeScreenSpaceWorldSize(terrainFitDistance, fov, viewportHeightPx, minPx);
    const worldPerPixelClose = (2 * Math.tan((fov * Math.PI) / 360) * incomingModeFitDistance) / viewportHeightPx;
    const renderedPx = staleWorldSize / worldPerPixelClose;
    expect(renderedPx).toBeGreaterThan(100);
  });
});

describe("NodeLabels wiring (structural, same convention as nodeLabelTiers.test.ts)", () => {
  const source = readSource("NodeLabels.tsx");

  it("font sizing runs in a per-frame refs-only refresh (useFrame), not solely inside the tick path that freezes at settle", () => {
    expect(source).toMatch(/useFrame\(\(\) => \{/);
    expect(source).toMatch(/shouldRefreshLabelFontSize\(/);
    // Refs-only discipline: the refresh mutates troika mesh properties, it
    // never calls setState from useFrame.
    expect(source).not.toMatch(/useFrame\(\(\) => \{[\s\S]*set[A-Z][a-zA-Z]*\(/);
  });

  it("distance is each label's own camera distance, never the camera's distance to the world origin", () => {
    expect(source).toMatch(/camera\.position\.distanceTo\(/);
    expect(source).not.toMatch(/camera\.position\.length\(\)/);
  });

  it("a label created AFTER the sim has settled (hover/selection) is seeded at its node's live position, not the origin, since no further tick will ever place it", () => {
    expect(source).toMatch(/positionsRef\.current\.get\(node\.id\)/);
  });
});
