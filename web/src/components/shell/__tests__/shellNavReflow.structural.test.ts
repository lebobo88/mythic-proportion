// T2 closeout fix (mythic-proportion-3d-visual-enhancement-phase7-320px-reflow,
// finding 1): live Playwright evidence at the plan's required 320px reflow
// checkpoint (Section 5.1 "Responsive behavior", the WCAG 1.4.10 checkpoint)
// found `document.documentElement.scrollWidth` (456-457px) exceeding
// `clientWidth` (320px) on every page/tab, with screenshots showing
// "Ingest"/"Lint"/"Settings" and the theme-toggle button cut off past the
// viewport edge -- the top TabNav row and the Header row (which carries the
// theme toggle) never reflow/wrap at narrow widths.
//
// vitest/jsdom does not apply an imported stylesheet's computed rendering
// the way a real browser does, so (matching this codebase's established
// "structural, source-checked" convention for anything jsdom cannot
// genuinely render -- see graph2DFallbackChrome.structural.test.ts) this
// file checks the CSS source directly; the actual visual result at 320px is
// Browser Validator territory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tabNavSource = readFileSync(join(__dirname, "..", "tab-nav.css"), "utf-8");
const headerSource = readFileSync(join(__dirname, "..", "header.css"), "utf-8");

describe("TabNav reflow at narrow viewport widths (Section 5.1, 320px reflow finding)", () => {
  it("lets the seven-tab row wrap onto multiple lines instead of forcing horizontal overflow, mirroring the app's existing toolbar-wrap convention (.mp-graph-toolbar/.mp-graph-filters)", () => {
    expect(tabNavSource).toMatch(/\.mp-tab-nav ul\s*\{[^}]*flex-wrap:\s*wrap/s);
  });
});

describe("Header reflow at narrow viewport widths (Section 5.1, 320px reflow finding)", () => {
  it("lets the header row (brand, command-palette button, theme toggle) wrap instead of forcing horizontal overflow", () => {
    expect(headerSource).toMatch(/\.mp-header\s*\{[^}]*flex-wrap:\s*wrap/s);
  });
});
