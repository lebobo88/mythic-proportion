// Runtime bridge between the `--graph-*` CSS token family (see
// src/styles/tokens/graph.css) and the future R3F 3D scene (Phase 5). Reads
// the *computed* (fully var()-resolved) OKLCH values off <html> and converts
// them into THREE.Color, so the 2D chrome and 3D scene are provably driven
// by one palette. Re-reads automatically whenever `data-theme` changes.
//
// three@0.169's Color.setStyle() does not parse `oklch()` strings, so we
// convert OKLCH -> sRGB ourselves via `culori` before constructing THREE.Color.

import { Color as ThreeColor } from "three";
import { formatRgb, parse } from "culori";
import type { GraphMode } from "../routes/graph/types";

export const GRAPH_NODE_TYPES = ["source", "entity", "concept", "session"] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

const COMMUNITY_COUNT = 8;

export interface GraphColor {
  /** THREE.Color populated from the token's resolved sRGB value. */
  color: ThreeColor;
  /** Alpha channel, if the token specifies one (1 otherwise). */
  alpha: number;
}

export interface GraphColors {
  node: Record<GraphNodeType, GraphColor>;
  edge: GraphColor;
  edgeActive: GraphColor;
  /**
   * The generative community ramp (plan Section 6.5 item 5), materialized
   * at level 0 for `community.length` slots -- sized to whatever community
   * count the caller requested from `readGraphColors`/`subscribeGraphColors`
   * (NOT fixed at 8 any more), so hue spacing (`hueBase + index * (360 /
   * count)`) stays even at higher real Leiden community counts (8, 16, 32+).
   * Every existing consumer that looked up `community[id % community.length]`
   * keeps working unchanged -- only the array's length is now dynamic.
   */
  community: GraphColor[];
  /**
   * Level-aware lookup sharing the exact same generator parameters/root as
   * `community` above -- hierarchy level maps to bounded CHROMA only, never
   * lightness (visual-system spec, plan Section 5.1). Used wherever a
   * consumer has both a community index AND a hierarchy level in hand (the
   * Strata mode's per-mode 2D fallback/accessibility tree in particular);
   * `community[i]` above is exactly `communityAt(i, 0)`.
   */
  communityAt: (index: number, level: number) => GraphColor;
  hullFill: GraphColor;
  glow: GraphColor;
}

/**
 * The generative community ramp's tunable parameters (plan Section 7: the
 * `graph.community.generator` additive token family), read as PLAIN NUMBERS
 * off `--graph-community-generator-*` custom properties -- kept as numbers
 * (not colors) so `communityOklch` can compose the actual oklch() string
 * itself and hand it to culori, the single color-conversion path (no second
 * color path, no hardcoded hex, per the plan's engineering invariants).
 */
export interface CommunityGeneratorParams {
  hueBase: number;
  chromaMin: number;
  chromaMax: number;
  chromaLevelStep: number;
  /** Resolved off the current `data-theme` cascade -- dark/light differ only here (Section 5.1's flagged light-theme lightness override; dark-theme values unchanged). */
  lightness: number;
}

const DEFAULT_GENERATOR_PARAMS: CommunityGeneratorParams = {
  hueBase: 20,
  chromaMin: 0.12,
  chromaMax: 0.2,
  chromaLevelStep: 0.015,
  lightness: 0.72,
};

function readVar(varName: string, root: Element): string {
  return getComputedStyle(root).getPropertyValue(varName).trim();
}

function readNumberVar(varName: string, root: Element, fallback: number): number {
  const raw = readVar(varName, root);
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Reads the `--graph-community-generator-*` numeric tokens (see graph.css)
 * off `root`, falling back to `DEFAULT_GENERATOR_PARAMS` per-field if a
 * token is absent/unparseable (defensive only -- graph.css always defines
 * the full set in both themes).
 *
 * Deep-Field Observatory Phase 1 (plan Section 5.2 "Light-theme Terrain" /
 * Section 5.7's permitted variation / Section 6 Phase 1: "add ... a
 * terrain-aware/mode-scoped light-lightness branch ... as one culori path"):
 * when `mode === "terrain"`, `lightness` is instead read off
 * `--graph-terrain-node-lightness` -- a mode-scoped override token that
 * graph.css defines ONLY in the light theme (dark-theme Terrain is
 * unchanged, per the plan's "dark-theme values unchanged" precedent for
 * this same generator). If the override token is absent (dark theme, or any
 * other theme that never defines it), this transparently falls back to the
 * theme-wide `--graph-community-generator-lightness` -- so no theme check is
 * needed here; only token *presence* decides. Hue/chroma formulas are
 * completely untouched (Section 5.6 item 7: "the Terrain-light darkening
 * moves lightness via a separate mode-scoped token, never the ramp
 * chroma/hue path") -- this remains the exact same single culori-backed
 * generator, only its `lightness` input can be swapped by mode.
 */
export function readCommunityGeneratorParams(
  root: Element = document.documentElement,
  mode?: GraphMode,
): CommunityGeneratorParams {
  const themeWideLightness = readNumberVar(
    "--graph-community-generator-lightness",
    root,
    DEFAULT_GENERATOR_PARAMS.lightness,
  );
  const terrainLightnessOverride =
    mode === "terrain" ? readNumberVar("--graph-terrain-node-lightness", root, Number.NaN) : Number.NaN;
  return {
    hueBase: readNumberVar("--graph-community-generator-hue-base", root, DEFAULT_GENERATOR_PARAMS.hueBase),
    chromaMin: readNumberVar(
      "--graph-community-generator-chroma-min",
      root,
      DEFAULT_GENERATOR_PARAMS.chromaMin,
    ),
    chromaMax: readNumberVar(
      "--graph-community-generator-chroma-max",
      root,
      DEFAULT_GENERATOR_PARAMS.chromaMax,
    ),
    chromaLevelStep: readNumberVar(
      "--graph-community-generator-chroma-level-step",
      root,
      DEFAULT_GENERATOR_PARAMS.chromaLevelStep,
    ),
    lightness: Number.isFinite(terrainLightnessOverride) ? terrainLightnessOverride : themeWideLightness,
  };
}

/**
 * Evenly spaces `count` ramp members around the hue circle (plan Section
 * 5.1's exact formula: `hue = 20 + index * (360 / count)`), wrapping past
 * 360deg. `count <= 0` degenerates to `hueBase` rather than dividing by
 * zero, so a not-yet-loaded/empty graph never throws.
 */
export function communityHue(index: number, count: number, hueBase: number = DEFAULT_GENERATOR_PARAMS.hueBase): number {
  if (count <= 0) return ((hueBase % 360) + 360) % 360;
  return (((hueBase + index * (360 / count)) % 360) + 360) % 360;
}

/**
 * Hierarchy level maps to BOUNDED CHROMA ONLY, never lightness (visual-
 * system spec, plan Section 5.1) -- deeper/finer levels read as slightly
 * more saturated, coarser levels slightly more muted, but every level stays
 * inside `[chromaMin, chromaMax]` so the AA contrast gate (Section 6.5 item
 * 8) never has to chase an unbounded chroma. Negative levels floor at 0;
 * levels past the bound clamp at `chromaMax` rather than growing forever.
 */
export function communityChroma(
  level: number,
  params: Pick<CommunityGeneratorParams, "chromaMin" | "chromaMax" | "chromaLevelStep"> = DEFAULT_GENERATOR_PARAMS,
): number {
  const boundedLevel = Math.max(0, level);
  const raw = params.chromaMin + boundedLevel * params.chromaLevelStep;
  return Math.min(params.chromaMax, Math.max(params.chromaMin, raw));
}

/** Composes one generated ramp member into a culori-parseable `oklch()` string -- the ONLY place this module builds a color string from scratch (every other color in this module round-trips an existing `--graph-*` token). */
export function communityOklch(
  index: number,
  count: number,
  level: number,
  params: CommunityGeneratorParams = DEFAULT_GENERATOR_PARAMS,
): string {
  const hue = communityHue(index, count, params.hueBase);
  const chroma = communityChroma(level, params);
  return `oklch(${params.lightness} ${chroma} ${hue})`;
}

/**
 * The selective-bloom pass's tunable parameters (plan Section 3.1 item 1 /
 * Section 5.2 "Tokens": `--graph-bloom-*`; Section 6 Phase 1: "add
 * `readBloomParams` mirroring `readCommunityGeneratorParams`"). Kept as
 * plain numbers, same convention as `CommunityGeneratorParams` above --
 * bloom itself (the `EffectComposer`/selective-bloom pass) is Phase 4 scope
 * and is NOT wired to this helper yet; this only lays the token-reading
 * foundation so Phase 4 has a single, tested, non-duplicated read path.
 */
export interface BloomParams {
  threshold: number;
  intensity: number;
  radius: number;
  resolutionScale: number;
}

const DEFAULT_BLOOM_PARAMS: BloomParams = {
  threshold: 0.9,
  intensity: 0.6,
  radius: 0.4,
  resolutionScale: 0.5,
};

/** Reads the `--graph-bloom-*` numeric tokens (see graph.css) off `root`, falling back to `DEFAULT_BLOOM_PARAMS` per-field if a token is absent/unparseable. */
export function readBloomParams(root: Element = document.documentElement): BloomParams {
  return {
    threshold: readNumberVar("--graph-bloom-threshold", root, DEFAULT_BLOOM_PARAMS.threshold),
    intensity: readNumberVar("--graph-bloom-intensity", root, DEFAULT_BLOOM_PARAMS.intensity),
    radius: readNumberVar("--graph-bloom-radius", root, DEFAULT_BLOOM_PARAMS.radius),
    resolutionScale: readNumberVar(
      "--graph-bloom-resolution-scale",
      root,
      DEFAULT_BLOOM_PARAMS.resolutionScale,
    ),
  };
}

function toGraphColor(cssValue: string): GraphColor {
  const parsed = parse(cssValue);
  if (!parsed) {
    // Fail loud in dev, but degrade to a visible magenta rather than
    // throwing, so a single missing token doesn't blank the whole scene.
    console.warn(`graph-colors: could not parse token value "${cssValue}"`);
    return { color: new ThreeColor(1, 0, 1), alpha: 1 };
  }
  const rgbString = formatRgb({ ...parsed, alpha: undefined });
  return {
    color: new ThreeColor().setStyle(rgbString),
    alpha: parsed.alpha ?? 1,
  };
}

/**
 * Read the current `--graph-*` tokens off `document.documentElement` (or a
 * given root, for testing) into THREE.Color instances. Call again after any
 * `data-theme` change — see `subscribeGraphColors` for the standing version.
 *
 * `communityCount` (plan Section 6.5 item 5) sizes the GENERATIVE ramp --
 * defaults to 8 for backward compatibility with every pre-Phase-4c caller,
 * but a caller with a real dataset should pass the actual distinct
 * community count present so hue spacing (`hueBase + index * (360 /
 * count)`) stays even at 16, 32, or whatever a given vault's Leiden
 * clustering produces. `community[i]` is generated via `communityOklch`
 * (culori-backed, level 0) rather than read off the old fixed
 * `--graph-community-1..8` tokens -- those tokens are left in place in
 * graph.css (still consumed by `DesignPreview.tsx`'s token gallery; tokens
 * extend, never replace) but are no longer this function's community-color
 * source.
 *
 * `mode` (Deep-Field Observatory Phase 1, plan Section 5.2/5.7) forwards to
 * `readCommunityGeneratorParams` so a Terrain-mode caller gets the
 * mode-scoped light-lightness override transparently -- see that function's
 * doc comment. Optional and backward compatible; every pre-Phase-1 caller
 * is unaffected.
 */
export function readGraphColors(
  root: Element = document.documentElement,
  communityCount: number = COMMUNITY_COUNT,
  mode?: GraphMode,
): GraphColors {
  const params = readCommunityGeneratorParams(root, mode);
  const count = Math.max(1, communityCount);
  const communityAt = (index: number, level: number): GraphColor =>
    toGraphColor(communityOklch(index, count, level, params));
  const community = Array.from({ length: count }, (_, i) => communityAt(i, 0));

  return {
    node: {
      source: toGraphColor(readVar("--graph-node-source", root)),
      entity: toGraphColor(readVar("--graph-node-entity", root)),
      concept: toGraphColor(readVar("--graph-node-concept", root)),
      session: toGraphColor(readVar("--graph-node-session", root)),
    },
    edge: toGraphColor(readVar("--graph-edge", root)),
    edgeActive: toGraphColor(readVar("--graph-edge-active", root)),
    community,
    communityAt,
    hullFill: toGraphColor(readVar("--graph-hull-fill", root)),
    glow: toGraphColor(readVar("--graph-glow", root)),
  };
}

/**
 * Subscribe to graph-color changes: fires `callback` immediately with the
 * current colors, then again every time `data-theme` flips on <html>.
 * Returns an unsubscribe function. `communityCount` is forwarded to
 * `readGraphColors` on every fire (initial + every theme flip) -- pass a
 * new value by re-subscribing (see `GraphView`'s effect dependency on the
 * dataset's distinct community count).
 */
export function subscribeGraphColors(
  callback: (colors: GraphColors) => void,
  root: HTMLElement = document.documentElement,
  communityCount: number = COMMUNITY_COUNT,
): () => void {
  callback(readGraphColors(root, communityCount));

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.attributeName === "data-theme")) {
      callback(readGraphColors(root, communityCount));
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  return () => observer.disconnect();
}
