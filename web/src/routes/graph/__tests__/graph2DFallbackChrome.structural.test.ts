// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 8.3
// acceptance item "2D-fallback: each mode's 2D fallback view gets a
// corresponding lightweight visual cue for its chrome (does not need to be
// pixel-equivalent, needs to not contradict/omit the mode's identity)").
// CSS-only, decorative, token-driven -- vitest/jsdom does not apply an
// imported stylesheet's computed rendering the way a real browser does, so
// (matching this directory's established "structural, source-checked"
// convention for anything jsdom cannot genuinely render) this file checks
// the CSS source directly; the actual visual result is Browser Validator
// territory. The structural DOM content in `Graph2DModeFallback.tsx`/
// `Graph2DFallback.tsx` already carries each mode's REAL identity (Gate B
// item 5 does not depend on this decorative layer) -- this only confirms
// the additive cue exists and is token-driven, never hardcoded hex.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "..", "graph.css"), "utf-8");

describe("2D-fallback chrome cues (Phase 5, CSS-only, token-driven)", () => {
  it("gives Cloud's canvas wrapper a nebula-tinted background using the same --graph-cloud-nebula-color token the 3D chrome reads", () => {
    expect(source).toMatch(/\.mp-graph-canvas-wrap\s*\{[^}]*--graph-cloud-nebula-color/s);
  });

  it("gives Orbital's fallback panel a ring/disc-tinted cue keyed by data-mode, using the --graph-orbital-* tokens", () => {
    expect(source).toMatch(/\.mp-graph-mode-fallback\[data-mode="orbital"\]\s*\{[^}]*--graph-orbital-/s);
  });

  it("gives Strata's fallback panel a banded floor-tinted cue keyed by data-mode, using the --graph-strata-* tokens", () => {
    expect(source).toMatch(/\.mp-graph-mode-fallback\[data-mode="strata"\]\s*\{[^}]*--graph-strata-/s);
  });

  it("gives Terrain's fallback panel a theme-paired sky gradient keyed by data-mode, using the --graph-terrain-sky-* tokens", () => {
    expect(source).toMatch(
      /\.mp-graph-mode-fallback\[data-mode="terrain"\]\s*\{[^}]*--graph-terrain-sky-top[^}]*--graph-terrain-sky-horizon/s,
    );
  });

  it("never hardcodes a hex color inside any of the four new chrome-cue rules -- token-driven only (Section 5.6 item 7)", () => {
    const cloudRule = /\.mp-graph-canvas-wrap\s*\{[^}]*\}/s.exec(source)?.[0] ?? "";
    const orbitalRule = /\.mp-graph-mode-fallback\[data-mode="orbital"\]\s*\{[^}]*\}/s.exec(source)?.[0] ?? "";
    const strataRule = /\.mp-graph-mode-fallback\[data-mode="strata"\]\s*\{[^}]*\}/s.exec(source)?.[0] ?? "";
    const terrainRule = /\.mp-graph-mode-fallback\[data-mode="terrain"\]\s*\{[^}]*\}/s.exec(source)?.[0] ?? "";
    for (const rule of [cloudRule, orbitalRule, strataRule, terrainRule]) {
      expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
