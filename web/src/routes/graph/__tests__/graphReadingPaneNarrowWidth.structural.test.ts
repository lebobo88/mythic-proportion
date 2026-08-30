// T2 closeout fix (mythic-proportion-3d-visual-enhancement-phase7-320px-reflow,
// finding 3 -- "re-verify the reading pane's presentation at 320px once fix
// #2 lands"): even with the a11y tree no longer crushing it (see
// graphA11yTreeVisualHidden.structural.test.ts), `.mp-graph-body` is a
// `display:flex` ROW pairing a flex:1 canvas wrap with a fixed
// `width: 320px; flex-shrink: 0;` `.mp-graph-reading-pane` aside -- a fixed
// 320px-wide non-shrinking column can never fit next to any nonzero-width
// canvas inside a 320px (or ~375px) viewport without causing genuine
// horizontal page overflow, independent of the a11y-tree defect. The plan's
// own Section 5.1 "Responsive behavior" text calls for "~375px: single
// column ... reading pane becomes a dismissible app-owned bottom sheet";
// this is the minimal CSS-only version of that -- a narrow-viewport media
// query stacks the body into a column and lets the reading pane take the
// full available width (bounded to a max-height so it still reads as a
// sheet, not a full-viewport takeover) rather than staying pinned at a
// fixed 320px.
//
// vitest/jsdom does not apply an imported stylesheet's computed rendering
// the way a real browser does, so (matching this directory's established
// "structural, source-checked" convention -- see
// graph2DFallbackChrome.structural.test.ts) this file checks the CSS source
// directly; the actual visual result at 320px is Browser Validator
// territory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "..", "graph.css"), "utf-8");

describe("Graph reading pane narrow-width reflow (Section 5.1, 320px reflow finding 3)", () => {
  it("has a narrow-viewport media query (max-width between 320px and 767px, i.e. scoped below the ~834px tablet breakpoint) that stacks .mp-graph-body into a column and makes .mp-graph-reading-pane full-width instead of a fixed 320px non-shrinking column", () => {
    const mediaMatch = /@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\}\s*\}/.exec(source);
    expect(mediaMatch).not.toBeNull();
    const [, widthStr, body] = mediaMatch!;
    const width = Number(widthStr);
    expect(width).toBeGreaterThanOrEqual(320);
    expect(width).toBeLessThanOrEqual(767);

    expect(body).toMatch(/\.mp-graph-body\s*\{[^}]*flex-direction:\s*column/s);
    expect(body).toMatch(/\.mp-graph-reading-pane\s*\{[^}]*width:\s*100%/s);
  });

  it("never removes the reading pane's fixed desktop width outside the narrow-viewport media query (the ~1440px/~834px layouts stay unchanged)", () => {
    const baseRule = /\.mp-graph-reading-pane\s*\{[^}]*\}/s.exec(source)?.[0] ?? "";
    expect(baseRule).toMatch(/width:\s*320px/);
  });
});
