// T2 remediation (mythic-proportion-3d-visual-enhancement-phase7-320px-reflow,
// FINAL allowed cycle on this finding): live Playwright evidence at 320x720
// found that the prior remediation's bounded `:focus-within` reveal
// (graph.css, Verifier-confirmed correct in isolation) still broke real
// layout, because its container -- `.mp-graph` -- has a FIXED
// `height: 70vh`, not `min-height`. When the tree revealed, `.mp-graph-body`
// (flex: 1; min-height: 0) shrank to absorb the reveal out of ITS OWN flex
// budget instead of `.mp-graph` growing to make room, measured crushing
// `.mp-graph-canvas-wrap` to 9px. The same squeeze also pushed the reading
// pane's content past its shrunk parent, visually overlapping the revealed
// tree box once a node was selected via the tree (Enter key).
//
// This fix (1) lets `.mp-graph` grow by exactly the reveal's own bound the
// instant a descendant of the tree holds focus (`:has()`), so
// `.mp-graph-body` never has to give up space, and (2) gives
// `.mp-graph-canvas-wrap`/`.mp-graph-reading-pane` an explicit min-height
// floor as an independent, defense-in-depth guarantee. The overlap's other
// half (focus moving off the tree onto the reading pane on tree-driven
// selection) is a GraphView.tsx/GraphView.test.tsx behavioral concern, not a
// CSS one -- see graphA11yTreeFocusMovesToReadingPane.test there.
//
// vitest/jsdom does not apply an imported stylesheet's computed rendering
// the way a real browser does, so (matching this directory's established
// "structural, source-checked" convention -- see
// graphA11yTreeVisualHidden.structural.test.ts) this file checks the CSS
// source directly; the actual visual result at 320px is Browser Validator
// territory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "..", "graph.css"), "utf-8");

function ruleBody(selectorPattern: string): string {
  const re = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`);
  return re.exec(source)?.[1] ?? "";
}

describe("`.mp-graph` grows to accommodate the a11y tree's bounded reveal instead of forcing `.mp-graph-body` to shrink (Section 5.1, 320px reflow finding, container-height architecture round)", () => {
  it("keeps the base .mp-graph rule's fixed height:70vh unchanged outside the reveal state (no regression to the normal 834px/1440px layout)", () => {
    const base = ruleBody(String.raw`\.mp-graph`);
    expect(base).toMatch(/height:\s*70vh/);
  });

  it("defines a .mp-graph:has(.mp-graph-a11y-tree:focus-within) rule that grows the container's height beyond the base 70vh while the tree is focus-revealed", () => {
    const hasRule = ruleBody(String.raw`\.mp-graph:has\(\.mp-graph-a11y-tree:focus-within\)`);
    expect(hasRule).not.toBe("");

    const heightMatch = /height:\s*([^;]+);/.exec(hasRule);
    expect(heightMatch).not.toBeNull();
    const heightValue = heightMatch![1];

    // Must still reference the base 70vh AND add extra room on top of it --
    // a flat replacement (e.g. a different fixed vh with no relation to the
    // base) would drift out of sync with the base rule over time.
    expect(heightValue).toMatch(/70vh/);
    expect(heightValue).toMatch(/\+/);

    // The extra room must reference the SAME bound as the reveal's own
    // max-height (a fixed px cap AND a viewport-relative cap) -- growing by
    // anything less would still let the reveal steal space; growing by
    // anything unbounded would reintroduce a different unbounded-height
    // regression at the container level.
    const pxCapMatch = /(\d+)px/.exec(heightValue);
    expect(pxCapMatch).not.toBeNull();
    expect(Number(pxCapMatch![1])).toBeLessThanOrEqual(400);

    const vhCapMatch = /(\d+)vh\)/.exec(heightValue) ?? /min\([^,]+,\s*(\d+)vh\)/.exec(heightValue);
    expect(vhCapMatch).not.toBeNull();
    expect(Number(vhCapMatch![1])).toBeLessThanOrEqual(50);
  });

  it("also grows by the container's own gap token, since the tree's :focus-within transition from position:absolute (out of flow) to position:static (in flow) makes it a real flex participant and introduces one new `gap` between it and `.mp-graph-body` that the reveal-height term alone does not cover (Verifier J-1-HEIGHT-MATH)", () => {
    const hasRule = ruleBody(String.raw`\.mp-graph:has\(\.mp-graph-a11y-tree:focus-within\)`);
    const heightMatch = /height:\s*([^;]+);/.exec(hasRule);
    expect(heightMatch).not.toBeNull();
    const heightValue = heightMatch![1];

    // Must reference the same gap custom property the base `.mp-graph` rule
    // uses (`gap: var(--space-2)`), not a hardcoded duplicate literal, so the
    // two stay in sync if the base gap token ever changes.
    const baseRule = ruleBody(String.raw`\.mp-graph`);
    const baseGapMatch = /gap:\s*(var\(--[\w-]+\))/.exec(baseRule);
    expect(baseGapMatch).not.toBeNull();
    const gapToken = baseGapMatch![1];

    expect(heightValue).toContain(gapToken);
  });

  it("the reveal's own :focus-within max-height rule stays completely untouched (this fix changes the CONTAINER, not the already Verifier-confirmed reveal itself)", () => {
    const focusRule = ruleBody(String.raw`\.mp-graph-a11y-tree:focus-within`);
    expect(focusRule).toMatch(/max-height:\s*min\(300px,\s*40vh\)/);
    expect(focusRule).toMatch(/position:\s*static/);
    expect(focusRule).toMatch(/overflow-y:\s*auto/);
  });
});

describe("`.mp-graph-canvas-wrap` and `.mp-graph-reading-pane` carry an explicit min-height floor the reveal cannot violate (defense-in-depth, item 2)", () => {
  it("`.mp-graph-canvas-wrap` has a nonzero min-height floor well above the live finding's measured 9px crush", () => {
    const rule = ruleBody(String.raw`\.mp-graph-canvas-wrap`);
    const match = /min-height:\s*(\d+)px/.exec(rule);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(80);
  });

  it("`.mp-graph-reading-pane`'s base rule (outside the narrow-width media query) has a nonzero min-height floor", () => {
    const rule = ruleBody(String.raw`\.mp-graph-reading-pane`);
    const match = /min-height:\s*(\d+)px/.exec(rule);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(80);

    // The already Verifier-confirmed narrow-width fixed-width override must
    // stay intact alongside the new floor.
    expect(rule).toMatch(/width:\s*320px/);
  });
});
