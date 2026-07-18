import { describe, expect, it } from "vitest";
import { formatHex, parse } from "culori";
import {
  communityChroma,
  communityHue,
  communityOklch,
  readBloomParams,
  readCommunityGeneratorParams,
  readGraphColors,
  subscribeGraphColors,
} from "../graph-colors";

// jsdom resolves custom-property values set directly via `style.setProperty`
// (unlike full var()-chain resolution across a real stylesheet cascade,
// which jsdom does not implement), so these tests set each `--graph-*`
// token's final resolved value directly on a scratch element — proving the
// OKLCH -> THREE.Color conversion, not the CSS cascade (that's covered by
// contrast.test.ts reading the real token files, and by browser-validator
// Chrome validation against the actual app).
function makeRoot(overrides: Record<string, string> = {}): HTMLElement {
  const root = document.createElement("div");
  const defaults: Record<string, string> = {
    "--graph-node-source": "oklch(0.75 0.14 230)",
    "--graph-node-entity": "oklch(0.75 0.16 20)",
    "--graph-node-concept": "oklch(0.75 0.15 150)",
    "--graph-node-session": "oklch(0.75 0.13 300)",
    "--graph-edge": "oklch(0.4 0.02 260 / 0.55)",
    "--graph-edge-active": "oklch(0.72 0.15 250)",
    "--graph-hull-fill": "oklch(0.5 0.05 260 / 0.08)",
    "--graph-glow": "oklch(0.85 0.12 250 / 0.65)",
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`--graph-community-${i + 1}`, "oklch(0.72 0.16 20)"]),
    ),
    "--graph-community-generator-hue-base": "20",
    "--graph-community-generator-chroma-min": "0.12",
    "--graph-community-generator-chroma-max": "0.20",
    "--graph-community-generator-chroma-level-step": "0.015",
    "--graph-community-generator-lightness": "0.72",
    ...overrides,
  };
  for (const [key, value] of Object.entries(defaults)) {
    root.style.setProperty(key, value);
  }
  document.body.appendChild(root);
  return root;
}

describe("readGraphColors", () => {
  it("converts every --graph-* token into a THREE.Color matching its OKLCH source", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);

    const expectedHex = formatHex(parse("oklch(0.75 0.16 20)")!);
    const actualHex = `#${colors.node.entity.color.getHexString()}`;
    expect(actualHex.toLowerCase()).toBe(expectedHex!.toLowerCase());
  });

  it("carries the alpha channel separately from the RGB color", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);
    expect(colors.edge.alpha).toBeCloseTo(0.55, 2);
    expect(colors.node.entity.alpha).toBe(1);
  });

  it("returns all 8 community colors", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);
    expect(colors.community).toHaveLength(8);
  });
});

describe("subscribeGraphColors", () => {
  it("fires immediately and again when data-theme changes", async () => {
    const root = makeRoot();
    const seen: string[] = [];
    const unsubscribe = subscribeGraphColors((colors) => {
      seen.push(`#${colors.node.entity.color.getHexString()}`);
    }, root);

    expect(seen).toHaveLength(1);

    root.style.setProperty("--graph-node-entity", "oklch(0.5 0.1 200)");
    root.setAttribute("data-theme", "light");

    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    // MutationObserver callbacks are microtask-scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });
});

// Phase 4c (plan Section 6.5 item 5): the generative OKLCH community ramp
// extending readGraphColors -- hue is index/count-driven, chroma is
// level-bounded (never lightness), and everything still funnels through
// culori (no second color path, no hardcoded hex).
describe("generative community ramp", () => {
  it("communityHue spaces ramp members evenly: hue = hueBase + index * (360 / count)", () => {
    expect(communityHue(0, 8, 20)).toBeCloseTo(20, 5);
    expect(communityHue(4, 8, 20)).toBeCloseTo(200, 5);
    expect(communityHue(1, 16, 20)).toBeCloseTo(42.5, 5);
  });

  it("communityHue wraps past 360 degrees", () => {
    expect(communityHue(7, 8, 20)).toBeCloseTo((20 + 7 * 45) % 360, 5);
  });

  it("communityChroma is bounded to [chromaMin, chromaMax] regardless of level, and never touches lightness", () => {
    const params = { chromaMin: 0.12, chromaMax: 0.2, chromaLevelStep: 0.015 };
    expect(communityChroma(0, params)).toBeCloseTo(0.12, 5);
    expect(communityChroma(1, params)).toBeCloseTo(0.135, 5);
    expect(communityChroma(100, params)).toBeCloseTo(0.2, 5); // clamped to max, not runaway
    expect(communityChroma(-5, params)).toBeCloseTo(0.12, 5); // negative level floors at 0
  });

  it("communityOklch composes hue/chroma/lightness into a valid oklch() string parseable by culori", () => {
    const params = { hueBase: 20, chromaMin: 0.12, chromaMax: 0.2, chromaLevelStep: 0.015, lightness: 0.72 };
    const value = communityOklch(2, 8, 3, params);
    const parsed = parse(value);
    expect(parsed).toBeTruthy();
    expect(parsed!.mode).toBe("oklch");
  });

  it("readCommunityGeneratorParams reads the numeric --graph-community-generator-* tokens off the root", () => {
    const root = makeRoot();
    const params = readCommunityGeneratorParams(root);
    expect(params).toEqual({
      hueBase: 20,
      chromaMin: 0.12,
      chromaMax: 0.2,
      chromaLevelStep: 0.015,
      lightness: 0.72,
    });
  });

  it("readGraphColors generates a community ramp sized to the requested count, not fixed at 8", () => {
    const root = makeRoot();
    expect(readGraphColors(root, 16).community).toHaveLength(16);
    expect(readGraphColors(root, 32).community).toHaveLength(32);
    expect(readGraphColors(root).community).toHaveLength(8); // default preserved
  });

  it("readGraphColors's generated community[i] matches the pure communityOklch formula at level 0", () => {
    const root = makeRoot();
    const colors = readGraphColors(root, 16);
    const params = readCommunityGeneratorParams(root);
    const expectedHex = formatHex(parse(communityOklch(3, 16, 0, params))!);
    const actualHex = `#${colors.community[3].color.getHexString()}`;
    expect(actualHex.toLowerCase()).toBe(expectedHex!.toLowerCase());
  });

  it("exposes a level-aware communityAt lookup sharing the same generator (Strata's chroma-by-level need)", () => {
    const root = makeRoot();
    const colors = readGraphColors(root, 8);
    const params = readCommunityGeneratorParams(root);
    const level0 = colors.communityAt(2, 0);
    const level3 = colors.communityAt(2, 3);
    // Same hue (same community index) at every level -- only chroma should move.
    const expectedLevel3Hex = formatHex(parse(communityOklch(2, 8, 3, params))!);
    expect(`#${level3.color.getHexString()}`.toLowerCase()).toBe(expectedLevel3Hex!.toLowerCase());
    // level 0 and level 3 differ (chroma moved) unless clamped -- assert they're not silently identical.
    expect(level0.color.getHexString()).not.toBe(level3.color.getHexString());
  });

  // Deep-Field Observatory Phase 1 (plan Section 5.2/5.7, Section 6 Phase 1):
  // the terrain-aware/mode-scoped light-lightness branch -- Terrain, in
  // light theme only, darkens node/community lightness via
  // `--graph-terrain-node-lightness` (structural handoff Section 5.2's
  // "Light-theme Terrain") instead of the theme-wide
  // `--graph-community-generator-lightness`, while staying on the exact
  // same culori-backed generator (hue/chroma formulas untouched -- only
  // `lightness` moves, per Section 5.6 item 7's ramp-formula invariant).
  it("readCommunityGeneratorParams uses --graph-terrain-node-lightness instead of the theme-wide lightness when mode is 'terrain' and the token is present (e.g. light theme)", () => {
    const root = makeRoot({ "--graph-terrain-node-lightness": "0.38" });
    const terrainParams = readCommunityGeneratorParams(root, "terrain");
    expect(terrainParams.lightness).toBeCloseTo(0.38, 5);
    // Every other field is untouched -- only lightness moves.
    expect(terrainParams.hueBase).toBe(20);
    expect(terrainParams.chromaMin).toBe(0.12);
    expect(terrainParams.chromaMax).toBe(0.2);
  });

  it("readCommunityGeneratorParams ignores the terrain override for non-terrain modes, even when the token is present", () => {
    const root = makeRoot({ "--graph-terrain-node-lightness": "0.38" });
    expect(readCommunityGeneratorParams(root, "cloud").lightness).toBeCloseTo(0.72, 5);
    expect(readCommunityGeneratorParams(root).lightness).toBeCloseTo(0.72, 5);
  });

  it("readCommunityGeneratorParams falls back to the theme-wide lightness for mode 'terrain' when no terrain override token is defined (dark theme has none)", () => {
    const root = makeRoot();
    expect(readCommunityGeneratorParams(root, "terrain").lightness).toBeCloseTo(0.72, 5);
  });

  it("readGraphColors forwards mode so its generated community ramp reflects the terrain override", () => {
    const root = makeRoot({ "--graph-terrain-node-lightness": "0.38" });
    const terrainColors = readGraphColors(root, 8, "terrain");
    const defaultColors = readGraphColors(root, 8);
    expect(terrainColors.community[0].color.getHexString()).not.toBe(
      defaultColors.community[0].color.getHexString(),
    );
  });
});

// Deep-Field Observatory Phase 1 (plan Section 3.1 item 1 / Section 5.2
// "Tokens": bloom `--graph-bloom-*`; Section 6 Phase 1: "add `readBloomParams`
// mirroring `readCommunityGeneratorParams`"). Bloom itself is not wired into
// the scene until Phase 4 -- this only lays the plain-number token-reading
// foundation, same convention as `readCommunityGeneratorParams` above.
describe("readBloomParams", () => {
  it("reads the numeric --graph-bloom-* tokens off the root", () => {
    const root = makeRoot({
      "--graph-bloom-threshold": "0.9",
      "--graph-bloom-intensity": "0.6",
      "--graph-bloom-radius": "0.4",
      "--graph-bloom-resolution-scale": "0.5",
    });
    expect(readBloomParams(root)).toEqual({
      threshold: 0.9,
      intensity: 0.6,
      radius: 0.4,
      resolutionScale: 0.5,
    });
  });

  it("falls back to the documented defaults when a token is absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readBloomParams(root)).toEqual({
      threshold: 0.9,
      intensity: 0.6,
      radius: 0.4,
      resolutionScale: 0.5,
    });
  });
});
