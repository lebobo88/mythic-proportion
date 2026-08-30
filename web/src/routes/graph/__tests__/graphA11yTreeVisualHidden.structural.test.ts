// T2 closeout fix (mythic-proportion-3d-visual-enhancement-phase7-320px-reflow,
// finding 2), remediation round 2: Verifier confirmed the prior remediation
// (this file's earlier version, which asserted `:focus-within` was REMOVED
// entirely) traded one real bug for another. That prior fix made
// `.mp-graph-a11y-tree` permanently sr-only at every focus state -- but this
// tree is the ONLY keyboard path to select an individual graph node in the
// default 3D mode (and Cloud's 2D fallback), so a sighted keyboard-only user
// tabbing through it now got ZERO visible page change for the whole
// traversal (the permanent `clip: rect(0,0,0,0)` zeroes the paint region for
// every descendant, including the global `:focus-visible` outline in
// base.css) -- a genuine WCAG 2.4.7 (Focus Visible) violation.
//
// The ORIGINAL `:focus-within` rule (before either T2 fix) was ALSO broken:
// it used `height: auto`/`width: auto` with no cap, revealing the tree at
// its full, unbounded intrinsic content height (~34,500px for ~1,500 items)
// the instant any descendant received focus -- unavoidable during ordinary
// keyboard operation -- which crushed `.mp-graph-canvas-wrap`/
// `.mp-graph-reading-pane` toward zero, independent of viewport width, for
// as long as focus stayed inside the tree.
//
// This fix restores a REAL visible focus location without reintroducing
// either bug: `.mp-graph-a11y-tree:focus-within` reveals the tree in normal
// document flow, but bounded to `max-height: min(300px, 40vh)` with
// `overflow-y: auto` -- so the remaining ~34,200px of content scrolls
// INSIDE the box instead of expanding it. That bound holds at every
// viewport (a fixed 300px cap, AND a 40%-of-viewport-height cap, whichever
// is smaller) -- it can never crush a sibling toward zero, including at
// 320px. `width: auto` (not a fixed/viewport-width value) keeps the tree a
// normal flex item of `.mp-graph` (column direction, default
// `align-items: stretch`), so its width is bounded by the same container
// that already bounds every other row; `overflow-x: hidden` is a second,
// independent guard (the links `<table>`'s cells don't wrap, so without
// this guard a wide table could push the box past that width).
//
// vitest/jsdom does not apply an imported stylesheet's computed rendering
// the way a real browser does, so (matching this directory's established
// "structural, source-checked" convention -- see
// graph2DFallbackChrome.structural.test.ts) this file checks the CSS source
// directly; the actual visual result at 320px (both the reveal-on-focus AND
// the no-overflow guarantee) is Browser Validator territory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "..", "graph.css"), "utf-8");

function baseRule(): string {
  return /\.mp-graph-a11y-tree\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
}

function focusWithinRule(): string {
  return /\.mp-graph-a11y-tree:focus-within\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
}

describe("GraphA11yTree stays sr-only until focused, base rule unchanged (Section 5.1, 320px reflow finding 2)", () => {
  it("keeps the base .mp-graph-a11y-tree rule on the standard sr-only clip-rect/absolute-positioning technique -- never display:none/visibility:hidden (which would break focusability)", () => {
    const base = baseRule();
    expect(base).toMatch(/position:\s*absolute/);
    expect(base).toMatch(/width:\s*1px/);
    expect(base).toMatch(/height:\s*1px/);
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
    expect(base).not.toMatch(/display:\s*none/);
    expect(base).not.toMatch(/visibility:\s*hidden/);
  });
});

describe("GraphA11yTree gains a bounded focus reveal -- real focus visibility without reintroducing the layout-crushing bug (Section 5.1, 320px reflow finding 2 remediation round 2)", () => {
  it("defines a .mp-graph-a11y-tree:focus-within rule at all (a keyboard user must get SOME visible focus location; a permanently-1px tree is a WCAG 2.4.7 violation)", () => {
    expect(source).toMatch(/\.mp-graph-a11y-tree:focus-within\s*\{/);
  });

  it("bounds the reveal with a capped max-height (never an unbounded/plain height:auto reveal) so it can never crush a sibling toward zero at any viewport", () => {
    const focusRule = focusWithinRule();
    expect(focusRule).not.toBe("");

    const maxHeightMatch = /max-height:\s*([^;]+);/.exec(focusRule);
    expect(maxHeightMatch).not.toBeNull();
    const maxHeightValue = maxHeightMatch![1];

    // Must reference both a fixed pixel cap AND a viewport-relative cap
    // (e.g. `min(300px, 40vh)`) -- a single raw vh value alone would still
    // be "bounded" at any one viewport, but a fixed px ceiling is what
    // guarantees it never grows unreasonably large on a very tall viewport,
    // and the vh term is what guarantees it stays a genuinely small
    // *fraction* of a very short one. Both together is the belt-and-braces
    // bound this job calls for.
    const pxCapMatch = /(\d+)px/.exec(maxHeightValue);
    expect(pxCapMatch).not.toBeNull();
    expect(Number(pxCapMatch![1])).toBeLessThanOrEqual(400);

    const vhCapMatch = /(\d+)vh/.exec(maxHeightValue);
    expect(vhCapMatch).not.toBeNull();
    expect(Number(vhCapMatch![1])).toBeLessThanOrEqual(50);
  });

  it("scrolls its own overflow internally (overflow-y: auto) rather than expanding past the bound", () => {
    const focusRule = focusWithinRule();
    expect(focusRule).toMatch(/overflow-y:\s*auto/);
  });

  it("never reintroduces horizontal overflow: width stays auto (not a fixed/viewport-width value) and overflow-x is guarded", () => {
    const focusRule = focusWithinRule();
    expect(focusRule).toMatch(/width:\s*auto/);
    expect(focusRule).toMatch(/overflow-x:\s*hidden/);
    expect(focusRule).not.toMatch(/width:\s*\d+vw/);
    expect(focusRule).not.toMatch(/width:\s*100%/);
  });

  it("does not permanently override the base rule's clip -- the reveal is scoped to :focus-within only, so focus leaving the tree returns it to the base sr-only state", () => {
    // Only one `.mp-graph-a11y-tree`-selector match should carry
    // `clip: auto` (or any override) -- the `:focus-within` rule -- and the
    // plain base selector (asserted sr-only above) must remain the only
    // unconditional rule for this class.
    const allSelectors = source.match(/\.mp-graph-a11y-tree(?::focus-within)?\s*\{/g) ?? [];
    expect(allSelectors.length).toBe(2);
  });
});
