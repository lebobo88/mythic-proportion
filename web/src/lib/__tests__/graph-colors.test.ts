import { describe, expect, it } from "vitest";
import { formatHex, parse } from "culori";
import { Color as ThreeColor } from "three";
import {
  communityChroma,
  communityHue,
  communityOklch,
  lerpAtmosphereFog,
  readAtmosphereFogParams,
  readBloomMotionParams,
  readBloomParams,
  readCloudChromeParams,
  readCommunityGeneratorParams,
  readEdgeWeightParams,
  readEnvironmentParams,
  readGraphColors,
  readLabelTierParams,
  readNodeMaterialParams,
  readOrbitalChromeParams,
  readPatternParams,
  readStrataChromeParams,
  readTerrainChromeParams,
  readVignetteParams,
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
    "--graph-node-fresnel-power": "2.5",
    "--graph-node-fresnel-intensity": "0.6",
    "--graph-node-emissive-idle": "0",
    "--graph-node-emissive-hover": "0.6",
    "--graph-node-emissive-selected": "1",
    "--graph-node-outline-color": "oklch(1 0 0)",
    "--graph-node-outline-width": "2",
    "--graph-pattern-luminance-delta": "0.18",
    "--graph-pattern-scale": "3",
    "--graph-label-tier-community-size": "15",
    "--graph-label-tier-node-size": "12",
    "--graph-label-tier-node-min-size": "10",
    "--graph-label-cap": "40",
    "--graph-label-community-max": "12",
    "--graph-label-outline-width": "0.12",
    "--graph-label-outline-color": "oklch(1 0 0)",
    "--graph-edge-weight-width-min": "1",
    "--graph-edge-weight-width-max": "4",
    "--graph-edge-weight-opacity-min": "0.25",
    "--graph-edge-weight-opacity-max": "0.9",
    "--graph-atmosphere-fog-color-cloud": "oklch(0.14 0.025 260 / 0.6)",
    "--graph-atmosphere-fog-color-orbital": "oklch(0.13 0.02 250 / 0.55)",
    "--graph-atmosphere-fog-color-strata": "oklch(0.15 0.02 255 / 0.5)",
    "--graph-atmosphere-fog-color-terrain": "oklch(0.16 0.03 240 / 0.45)",
    "--graph-atmosphere-fog-density-cloud": "0.045",
    "--graph-atmosphere-fog-density-orbital": "0.02",
    "--graph-atmosphere-fog-density-strata": "0.03",
    "--graph-atmosphere-fog-density-terrain": "0.015",
    "--graph-cloud-nebula-color": "oklch(0.3 0.06 280 / 0.5)",
    "--graph-cloud-nebula-opacity": "0.12",
    "--graph-orbital-disc-color": "oklch(0.35 0.05 250 / 0.4)",
    "--graph-orbital-disc-opacity": "0.18",
    "--graph-orbital-ring-color": "oklch(0.55 0.06 245 / 0.6)",
    "--graph-orbital-ring-width": "1.5",
    "--graph-orbital-core-glow-color": "oklch(0.8 0.1 240 / 0.7)",
    "--graph-orbital-core-glow-intensity": "0.8",
    "--graph-orbital-ring-inclination": "6",
    "--graph-strata-floor-color": "oklch(0.3 0.04 255 / 0.35)",
    "--graph-strata-floor-opacity": "0.14",
    "--graph-strata-floor-fog-density": "0.03",
    "--graph-strata-band-rim-color": "oklch(0.6 0.08 245 / 0.5)",
    "--graph-strata-axis-color": "oklch(0.65 0.03 260)",
    "--graph-terrain-sky-top": "oklch(0.18 0.03 255)",
    "--graph-terrain-sky-horizon": "oklch(0.28 0.04 30)",
    "--graph-terrain-hillshade-strength": "0.8",
    "--graph-terrain-contour-major-color": "oklch(0.55 0.03 255 / 0.55)",
    "--graph-terrain-contour-minor-color": "oklch(0.4 0.02 255 / 0.35)",
    "--graph-terrain-contour-major-width": "1.5",
    "--graph-terrain-contour-minor-width": "0.75",
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

  // Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section 6
  // Phase 4: wires `readBloomParams` -- already declared standalone in Phase
  // 1 -- into the SAME `GraphColors` bundle every other Phase 2/3 param
  // family (`nodeMaterial`/`pattern`/`labelTier`/`edgeWeight`) already uses,
  // rather than a second, parallel read path).
  it("folds readBloomParams into colors.bloom, matching the standalone helper", () => {
    const root = makeRoot({
      "--graph-bloom-threshold": "0.9",
      "--graph-bloom-intensity": "0.6",
      "--graph-bloom-radius": "0.4",
      "--graph-bloom-resolution-scale": "0.5",
    });
    const colors = readGraphColors(root);
    expect(colors.bloom).toEqual(readBloomParams(root));
  });
});

// Deep-Field Observatory Phase 4 (plan Section 5.3 "Token alignment": new
// `--graph-motion-bloom-suppress`/`-restore` tokens, declared in `:root` AND
// collapsed under `prefers-reduced-motion`, "like the existing durations" --
// same `readNumberVar`-adjacent, discrete-trigger-read convention as
// `lib/motion.ts`'s `getDuration`, kept here (not motion.ts) because these
// are graph-scene-scoped, not the generic `--duration-*` family).
describe("readBloomMotionParams", () => {
  it("reads the --graph-motion-bloom-suppress/-restore millisecond tokens off the root", () => {
    const root = document.createElement("div");
    root.style.setProperty("--graph-motion-bloom-suppress", "150ms");
    root.style.setProperty("--graph-motion-bloom-restore", "225ms");
    document.body.appendChild(root);
    expect(readBloomMotionParams(root)).toEqual({ suppressMs: 150, restoreMs: 225 });
    root.remove();
  });

  it("falls back to the documented 150ms/225ms defaults when absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readBloomMotionParams(root)).toEqual({ suppressMs: 150, restoreMs: 225 });
    root.remove();
  });
});

// Deep-Field Observatory Phase 4 (plan Section 3.1 item 4: "selective bloom
// plus vignette"; Section 5.7 permitted variation -- exact numerics may be
// tuned provided they remain token-driven). Same `readNumberVar` convention
// as `readBloomParams`.
describe("readVignetteParams", () => {
  it("reads the numeric --graph-vignette-* tokens off the root", () => {
    const root = document.createElement("div");
    root.style.setProperty("--graph-vignette-offset", "0.5");
    root.style.setProperty("--graph-vignette-darkness", "0.5");
    document.body.appendChild(root);
    expect(readVignetteParams(root)).toEqual({ offset: 0.5, darkness: 0.5 });
    root.remove();
  });

  it("falls back to the documented defaults when a token is absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readVignetteParams(root)).toEqual({ offset: 0.5, darkness: 0.5 });
    root.remove();
  });
});

// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.2
// per-mode chrome token families -- ALL already declared in Phase 1's
// graph.css, both themes; this only adds the matching read-only-numeric/
// color-token helpers, mirroring `readBloomParams`'s exact convention, per
// Section 6 Phase 5's "read/consume them via graph-colors.ts helpers, adding
// a helper if one doesn't already exist" instruction).
describe("readAtmosphereFogParams", () => {
  it("reads the per-mode --graph-atmosphere-fog-color/-density tokens off the root", () => {
    const root = makeRoot();
    const fog = readAtmosphereFogParams(root, "terrain");
    expect(fog.density).toBeCloseTo(0.015, 5);
    expect(fog.color.color).toBeInstanceOf(ThreeColor);
  });

  it("defaults to cloud's fog when mode is omitted", () => {
    const root = makeRoot();
    expect(readAtmosphereFogParams(root).density).toBeCloseTo(0.045, 5);
  });

  it("falls back to sane density defaults when a token is absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readAtmosphereFogParams(root, "orbital").density).toBeCloseTo(0.02, 5);
    root.remove();
  });
});

describe("lerpAtmosphereFog", () => {
  it("linearly interpolates density and color between two fog params", () => {
    const from = { color: { color: new ThreeColor(0, 0, 0), alpha: 1 }, density: 0 };
    const to = { color: { color: new ThreeColor(1, 1, 1), alpha: 1 }, density: 1 };
    const mid = lerpAtmosphereFog(from, to, 0.5);
    expect(mid.density).toBeCloseTo(0.5, 5);
    expect(mid.color.color.r).toBeCloseTo(0.5, 2);
  });

  it("resolves exactly to `from` at alpha 0 and `to` at alpha 1", () => {
    const from = { color: { color: new ThreeColor(0.2, 0.2, 0.2), alpha: 1 }, density: 0.1 };
    const to = { color: { color: new ThreeColor(0.8, 0.8, 0.8), alpha: 1 }, density: 0.9 };
    expect(lerpAtmosphereFog(from, to, 0).density).toBeCloseTo(0.1, 5);
    expect(lerpAtmosphereFog(from, to, 1).density).toBeCloseTo(0.9, 5);
  });
});

describe("readCloudChromeParams", () => {
  it("reads --graph-cloud-nebula-color/-opacity off the root", () => {
    const root = makeRoot();
    const chrome = readCloudChromeParams(root);
    expect(chrome.nebulaOpacity).toBeCloseTo(0.12, 5);
    expect(chrome.nebulaColor.color).toBeInstanceOf(ThreeColor);
  });

  it("falls back to a documented default opacity when the token is absent", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readCloudChromeParams(root).nebulaOpacity).toBeCloseTo(0.12, 5);
    root.remove();
  });
});

describe("readOrbitalChromeParams", () => {
  it("reads disc/ring/core-glow/inclination tokens off the root", () => {
    const root = makeRoot();
    const chrome = readOrbitalChromeParams(root);
    expect(chrome.discOpacity).toBeCloseTo(0.18, 5);
    expect(chrome.ringWidth).toBeCloseTo(1.5, 5);
    expect(chrome.coreGlowIntensity).toBeCloseTo(0.8, 5);
    expect(chrome.ringInclinationDeg).toBeCloseTo(6, 5);
  });
});

describe("readStrataChromeParams", () => {
  it("reads floor/rim/axis tokens off the root", () => {
    const root = makeRoot();
    const chrome = readStrataChromeParams(root);
    expect(chrome.floorOpacity).toBeCloseTo(0.14, 5);
    expect(chrome.floorFogDensity).toBeCloseTo(0.03, 5);
    expect(chrome.axisColor.color).toBeInstanceOf(ThreeColor);
  });
});

describe("readTerrainChromeParams", () => {
  it("reads sky/hillshade/contour tokens off the root", () => {
    const root = makeRoot();
    const chrome = readTerrainChromeParams(root);
    expect(chrome.hillshadeStrength).toBeCloseTo(0.8, 5);
    expect(chrome.contourMajorWidth).toBeCloseTo(1.5, 5);
    expect(chrome.contourMinorWidth).toBeCloseTo(0.75, 5);
    expect(chrome.skyTop.color).toBeInstanceOf(ThreeColor);
    expect(chrome.skyHorizon.color).toBeInstanceOf(ThreeColor);
  });
});

describe("readEnvironmentParams", () => {
  it("reads --graph-env-intensity off the root, falling back to 1 when absent", () => {
    const root = makeRoot();
    expect(readEnvironmentParams(root).intensity).toBeCloseTo(1, 5);
  });

  it("reads a theme-overridden --graph-env-intensity (e.g. light theme's 1.15)", () => {
    const root = makeRoot({ "--graph-env-intensity": "1.15" });
    expect(readEnvironmentParams(root).intensity).toBeCloseTo(1.15, 5);
  });
});

describe("readGraphColors folds per-mode chrome + atmosphere fog into the bundle (Phase 5)", () => {
  it("exposes cloudChrome/orbitalChrome/strataChrome/terrainChrome matching their standalone readers", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);
    expect(colors.cloudChrome).toEqual(readCloudChromeParams(root));
    expect(colors.orbitalChrome).toEqual(readOrbitalChromeParams(root));
    expect(colors.strataChrome).toEqual(readStrataChromeParams(root));
    expect(colors.terrainChrome).toEqual(readTerrainChromeParams(root));
  });

  it("exposes environment matching readEnvironmentParams (Phase 6)", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);
    expect(colors.environment).toEqual(readEnvironmentParams(root));
  });

  it("resolves atmosphereFog for the requested mode, defaulting to cloud", () => {
    const root = makeRoot();
    expect(readGraphColors(root, 8, "terrain").atmosphereFog).toEqual(readAtmosphereFogParams(root, "terrain"));
    expect(readGraphColors(root).atmosphereFog).toEqual(readAtmosphereFogParams(root, "cloud"));
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

// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.2
// "Tokens" -- node material fresnel/emissive/outline; Section 6 Phase 2: "the
// onBeforeCompile fresnel rim plus per-instance emissive ... taking explicit
// care against the black-multiply bug"). Same read-only-numeric-token
// convention as `readCommunityGeneratorParams`/`readBloomParams` above --
// `readNodeMaterialParams` never touches culori/color conversion itself
// (`outlineColor` is the one exception: it IS a color, converted via the
// same `toGraphColor`/culori path every other GraphColor in this module
// uses, never a second color path).
describe("readNodeMaterialParams", () => {
  it("reads the numeric --graph-node-fresnel-*/-emissive-*/-outline-width tokens, and outlineColor via the culori path", () => {
    const root = makeRoot();
    const params = readNodeMaterialParams(root);
    expect(params.fresnelPower).toBeCloseTo(2.5, 5);
    expect(params.fresnelIntensity).toBeCloseTo(0.6, 5);
    expect(params.emissiveIdle).toBe(0);
    expect(params.emissiveHover).toBeCloseTo(0.6, 5);
    expect(params.emissiveSelected).toBe(1);
    expect(params.outlineWidth).toBe(2);
    expect(params.outlineColor.color.getHexString()).toBe("ffffff");
  });

  it("falls back to the documented defaults when tokens are absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const params = readNodeMaterialParams(root);
    expect(params.fresnelPower).toBeCloseTo(2.5, 5);
    expect(params.fresnelIntensity).toBeCloseTo(0.6, 5);
    expect(params.emissiveHover).toBeCloseTo(0.6, 5);
    expect(params.emissiveSelected).toBe(1);
    expect(params.outlineWidth).toBe(2);
  });

  // Section 5.2 "Light-theme Terrain" / Section 5.7 permitted variation:
  // Terrain has its OWN darkened, non-luminance outline tokens
  // (`--graph-terrain-node-outline-color/-width`) -- mirrors the existing
  // `readCommunityGeneratorParams(root, "terrain")` mode-forwarding
  // convention exactly (mode-scoped override, never a second theme check).
  it("uses --graph-terrain-node-outline-color/-width instead of the theme-wide outline tokens when mode is 'terrain'", () => {
    const root = makeRoot({
      "--graph-terrain-node-outline-color": "oklch(0.2 0.02 260)",
      "--graph-terrain-node-outline-width": "2",
    });
    const terrainParams = readNodeMaterialParams(root, "terrain");
    expect(terrainParams.outlineColor.color.getHexString()).not.toBe("ffffff");
    const nonTerrainParams = readNodeMaterialParams(root, "cloud");
    expect(nonTerrainParams.outlineColor.color.getHexString()).toBe("ffffff");
  });
});

// Section 5.2 "Color and contrast": "Pattern identity modulates luminance:
// --graph-pattern-luminance-delta 0.18 shifts pattern lobes around the
// community color". Plain numbers, same convention as the params above --
// wired into the node fragment shader by `nodeMaterialShader.ts`.
describe("readPatternParams", () => {
  it("reads the numeric --graph-pattern-* tokens off the root", () => {
    const root = makeRoot();
    expect(readPatternParams(root)).toEqual({ luminanceDelta: 0.18, scale: 3 });
  });

  it("falls back to the documented defaults when a token is absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readPatternParams(root)).toEqual({ luminanceDelta: 0.18, scale: 3 });
  });
});

// Section 5.2 "Typography": the two-tier label system's numeric budget --
// community titles (~8-12, always-on) win the shared ~40-label cap; node
// labels carry a screen-space minimum size. Plain numbers, same convention.
describe("readLabelTierParams", () => {
  it("reads the numeric --graph-label-tier-*/-cap/-community-max/-outline-width tokens off the root", () => {
    const root = makeRoot();
    expect(readLabelTierParams(root)).toEqual({
      communitySize: 15,
      nodeSize: 12,
      nodeMinSize: 10,
      cap: 40,
      communityMax: 12,
      outlineWidth: 0.12,
    });
  });

  it("falls back to the documented defaults when a token is absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readLabelTierParams(root)).toEqual({
      communitySize: 15,
      nodeSize: 12,
      nodeMinSize: 10,
      cap: 40,
      communityMax: 12,
      outlineWidth: 0.12,
    });
  });
});

// Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.2
// "Tokens": edge-weight width/opacity `--graph-edge-weight-*`; Section 6
// Phase 3: "confirm and read them via a helper, do not redeclare" -- the
// tokens themselves were already declared in Phase 1; this only adds the
// matching read-only-numeric-token helper, same convention as
// `readBloomParams`/`readNodeMaterialParams` above.
describe("readEdgeWeightParams", () => {
  it("reads the numeric --graph-edge-weight-* tokens off the root", () => {
    const root = makeRoot();
    expect(readEdgeWeightParams(root)).toEqual({
      widthMin: 1,
      widthMax: 4,
      opacityMin: 0.25,
      opacityMax: 0.9,
    });
  });

  it("falls back to the documented defaults when a token is absent/unparseable", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(readEdgeWeightParams(root)).toEqual({
      widthMin: 1,
      widthMax: 4,
      opacityMin: 0.25,
      opacityMax: 0.9,
    });
  });
});

// `readGraphColors` forwards nodeMaterial/pattern/labelTier/edgeWeight the
// same way it already forwards `mode` into `readCommunityGeneratorParams`
// (Phase 1 precedent) -- one call site assembles every token family a
// 3D-scene consumer needs, so `InstancedNodes`/`NodeLabels`/the
// centroid-badge layer/`InstancedEdges` never each read tokens their own
// separate way.
describe("readGraphColors forwards nodeMaterial/pattern/labelTier/edgeWeight (Phase 2/3)", () => {
  it("includes nodeMaterial, pattern, labelTier, and edgeWeight on every GraphColors result", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);
    expect(colors.nodeMaterial.fresnelPower).toBeCloseTo(2.5, 5);
    expect(colors.pattern.scale).toBe(3);
    expect(colors.labelTier.cap).toBe(40);
    expect(colors.edgeWeight).toEqual({ widthMin: 1, widthMax: 4, opacityMin: 0.25, opacityMax: 0.9 });
  });

  it("forwards mode into nodeMaterial's outline so Terrain gets its own outline tokens", () => {
    const root = makeRoot({
      "--graph-terrain-node-outline-color": "oklch(0.2 0.02 260)",
      "--graph-terrain-node-outline-width": "2",
    });
    const terrainColors = readGraphColors(root, 8, "terrain");
    const defaultColors = readGraphColors(root, 8);
    expect(terrainColors.nodeMaterial.outlineColor.color.getHexString()).not.toBe(
      defaultColors.nodeMaterial.outlineColor.color.getHexString(),
    );
  });
});
