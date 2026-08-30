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
  /** Deep-Field Observatory Phase 2 (Section 5.2/5.6 item 1) -- see `readNodeMaterialParams`. */
  nodeMaterial: NodeMaterialParams;
  /** Deep-Field Observatory Phase 2 (Section 5.2/5.6 item 1) -- see `readPatternParams`. */
  pattern: PatternParams;
  /** Deep-Field Observatory Phase 2 (Section 5.2 "Typography") -- see `readLabelTierParams`. */
  labelTier: LabelTierParams;
  /** Deep-Field Observatory Phase 3 (Section 3.1 item 3 / Section 5.6 item 3) -- see `readEdgeWeightParams`. */
  edgeWeight: EdgeWeightParams;
  /**
   * Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section 6
   * Phase 4) -- `readBloomParams` folded into the same bundle every other
   * Phase 2/3 param family (`nodeMaterial`/`pattern`/`labelTier`/
   * `edgeWeight`) already uses, rather than a second, parallel read path.
   * `readBloomParams` itself (already declared standalone in Phase 1) is
   * unchanged and still exported/tested on its own.
   */
  bloom: BloomParams;
  /**
   * Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.2
   * per-mode chrome/atmosphere token families -- ALL already declared in
   * Phase 1's graph.css, both themes; see `readAtmosphereFogParams`/
   * `readCloudChromeParams`/`readOrbitalChromeParams`/
   * `readStrataChromeParams`/`readTerrainChromeParams` below). `atmosphereFog`
   * is resolved for whatever `mode` the caller passed to `readGraphColors`
   * (defaulting to "cloud", mirroring `nodeMaterial`'s own mode-forwarding
   * convention); the four `*Chrome` families are mode-independent bundles
   * (a caller consumes only the one matching the active mode).
   */
  atmosphereFog: AtmosphereFogParams;
  cloudChrome: CloudChromeParams;
  orbitalChrome: OrbitalChromeParams;
  strataChrome: StrataChromeParams;
  terrainChrome: TerrainChromeParams;
  /**
   * Deep-Field Observatory Phase 6 (plan Section 3.1 item 6 / Section 5.2
   * "Tokens", "environment/IBL `--graph-env-intensity`" -- see
   * `readEnvironmentParams` below). Consumed by `TerrainEnvironment.tsx` to
   * scale `scene.environmentIntensity` once a real HDRI drives
   * `scene.environment` via PMREM; per-theme (dark 1.0 / light 1.15, per
   * graph.css). The `--graph-env-sky-top`/`-horizon` tokens declared
   * alongside it in graph.css stay Phase-1-foundation-only/unconsumed: per
   * Section 5.4's Fallback contract, an absent/failed HDRI leaves
   * `scene.environment` UNSET rather than substituting a synthesized
   * procedural IBL map (`scene.background`'s own token-driven fallback,
   * already wired via `TerrainChromeParams.skyHorizon`, is what carries the
   * "procedural token sky" fallback requirement).
   */
  environment: EnvironmentParams;
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

/**
 * Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.2
 * "Tokens" -- node material fresnel/emissive/outline; Section 6 Phase 2's
 * `onBeforeCompile` patch, see `nodeMaterialShader.ts`). Plain numbers for
 * fresnel/emissive/width, same `readNumberVar` convention as
 * `readCommunityGeneratorParams`/`readBloomParams` above; `outlineColor` is
 * the one field that IS a color, so it round-trips through the same
 * `toGraphColor`/culori path every other color in this module uses (never a
 * second, hand-rolled color parse).
 */
export interface NodeMaterialParams {
  fresnelPower: number;
  fresnelIntensity: number;
  emissiveIdle: number;
  emissiveHover: number;
  emissiveSelected: number;
  outlineColor: GraphColor;
  outlineWidth: number;
}

const DEFAULT_NODE_MATERIAL_NUMBERS = {
  fresnelPower: 2.5,
  fresnelIntensity: 0.6,
  emissiveIdle: 0,
  emissiveHover: 0.6,
  emissiveSelected: 1,
  outlineWidth: 2,
};

/**
 * Reads the `--graph-node-fresnel-*`/`-emissive-*`/`-outline-*` tokens (see
 * graph.css) off `root`. `mode` (mirrors `readCommunityGeneratorParams`'s
 * own mode-forwarding convention exactly, Section 5.7 permitted variation):
 * when `"terrain"`, outline color/width read the Terrain-scoped
 * `--graph-terrain-node-outline-color/-width` tokens instead of the
 * theme-wide `--graph-node-outline-color/-width` -- Terrain's structural
 * light-theme darkening (Section 5.2 "Light-theme Terrain") needs its own
 * darkened, non-luminance outline independent of sky brightness.
 */
export function readNodeMaterialParams(
  root: Element = document.documentElement,
  mode?: GraphMode,
): NodeMaterialParams {
  const outlineColorVar = mode === "terrain" ? "--graph-terrain-node-outline-color" : "--graph-node-outline-color";
  const outlineWidthVar = mode === "terrain" ? "--graph-terrain-node-outline-width" : "--graph-node-outline-width";
  return {
    fresnelPower: readNumberVar("--graph-node-fresnel-power", root, DEFAULT_NODE_MATERIAL_NUMBERS.fresnelPower),
    fresnelIntensity: readNumberVar(
      "--graph-node-fresnel-intensity",
      root,
      DEFAULT_NODE_MATERIAL_NUMBERS.fresnelIntensity,
    ),
    emissiveIdle: readNumberVar("--graph-node-emissive-idle", root, DEFAULT_NODE_MATERIAL_NUMBERS.emissiveIdle),
    emissiveHover: readNumberVar("--graph-node-emissive-hover", root, DEFAULT_NODE_MATERIAL_NUMBERS.emissiveHover),
    emissiveSelected: readNumberVar(
      "--graph-node-emissive-selected",
      root,
      DEFAULT_NODE_MATERIAL_NUMBERS.emissiveSelected,
    ),
    outlineColor: toGraphColor(readVar(outlineColorVar, root) || "oklch(1 0 0)"),
    outlineWidth: readNumberVar(outlineWidthVar, root, DEFAULT_NODE_MATERIAL_NUMBERS.outlineWidth),
  };
}

/**
 * Deep-Field Observatory Phase 2 (plan Section 5.2 "Color and contrast":
 * "Pattern identity modulates luminance"). Plain numbers, same convention as
 * `readBloomParams` -- wired into the node fragment shader's per-fragment
 * pattern lobes by `nodeMaterialShader.ts`.
 */
export interface PatternParams {
  luminanceDelta: number;
  scale: number;
}

const DEFAULT_PATTERN_PARAMS: PatternParams = { luminanceDelta: 0.18, scale: 3 };

export function readPatternParams(root: Element = document.documentElement): PatternParams {
  return {
    luminanceDelta: readNumberVar(
      "--graph-pattern-luminance-delta",
      root,
      DEFAULT_PATTERN_PARAMS.luminanceDelta,
    ),
    scale: readNumberVar("--graph-pattern-scale", root, DEFAULT_PATTERN_PARAMS.scale),
  };
}

/**
 * Deep-Field Observatory Phase 2 (plan Section 5.2 "Typography" -- the
 * two-tier label system). Plain numbers, same convention as the params
 * above -- consumed by `NodeLabels.tsx`'s tier-1/tier-2 selection and
 * screen-space minimum-size logic.
 */
export interface LabelTierParams {
  communitySize: number;
  nodeSize: number;
  nodeMinSize: number;
  cap: number;
  communityMax: number;
  outlineWidth: number;
}

const DEFAULT_LABEL_TIER_PARAMS: LabelTierParams = {
  communitySize: 15,
  nodeSize: 12,
  nodeMinSize: 10,
  cap: 40,
  communityMax: 12,
  outlineWidth: 0.12,
};

export function readLabelTierParams(root: Element = document.documentElement): LabelTierParams {
  return {
    communitySize: readNumberVar(
      "--graph-label-tier-community-size",
      root,
      DEFAULT_LABEL_TIER_PARAMS.communitySize,
    ),
    nodeSize: readNumberVar("--graph-label-tier-node-size", root, DEFAULT_LABEL_TIER_PARAMS.nodeSize),
    nodeMinSize: readNumberVar(
      "--graph-label-tier-node-min-size",
      root,
      DEFAULT_LABEL_TIER_PARAMS.nodeMinSize,
    ),
    cap: readNumberVar("--graph-label-cap", root, DEFAULT_LABEL_TIER_PARAMS.cap),
    communityMax: readNumberVar(
      "--graph-label-community-max",
      root,
      DEFAULT_LABEL_TIER_PARAMS.communityMax,
    ),
    outlineWidth: readNumberVar(
      "--graph-label-outline-width",
      root,
      DEFAULT_LABEL_TIER_PARAMS.outlineWidth,
    ),
  };
}

/**
 * Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.2
 * "Tokens" -- edge-weight width/opacity: `--graph-edge-weight-width-min` 1 /
 * `-max` 4, `--graph-edge-weight-opacity-min` 0.25 / `-max` 0.90; Section 6
 * Phase 3: "confirm and read them via a helper, do not redeclare" -- these
 * tokens were already declared by Phase 1's `graph.css`; this only adds the
 * matching read-only-numeric-token helper, mirroring `readBloomParams`'s
 * exact convention). Consumed by the fat-line edge pass
 * (`InstancedEdges.tsx`/`edgeWeight.ts`) to interpolate a served edge weight
 * into a per-edge width/opacity.
 */
export interface EdgeWeightParams {
  widthMin: number;
  widthMax: number;
  opacityMin: number;
  opacityMax: number;
}

const DEFAULT_EDGE_WEIGHT_PARAMS: EdgeWeightParams = {
  widthMin: 1,
  widthMax: 4,
  opacityMin: 0.25,
  opacityMax: 0.9,
};

/** Reads the `--graph-edge-weight-*` numeric tokens (see graph.css) off `root`, falling back to `DEFAULT_EDGE_WEIGHT_PARAMS` per-field if a token is absent/unparseable. */
export function readEdgeWeightParams(root: Element = document.documentElement): EdgeWeightParams {
  return {
    widthMin: readNumberVar("--graph-edge-weight-width-min", root, DEFAULT_EDGE_WEIGHT_PARAMS.widthMin),
    widthMax: readNumberVar("--graph-edge-weight-width-max", root, DEFAULT_EDGE_WEIGHT_PARAMS.widthMax),
    opacityMin: readNumberVar(
      "--graph-edge-weight-opacity-min",
      root,
      DEFAULT_EDGE_WEIGHT_PARAMS.opacityMin,
    ),
    opacityMax: readNumberVar(
      "--graph-edge-weight-opacity-max",
      root,
      DEFAULT_EDGE_WEIGHT_PARAMS.opacityMax,
    ),
  };
}

/**
 * Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.2
 * "Tokens": `--graph-atmosphere-fog-color-{cloud,orbital,strata,terrain}` /
 * `-density-{...}`; Section 5.3 "Mode-transition cross-fade": "fog color/
 * density interpolating"). Kept as one color + one plain number, same
 * `toGraphColor`/`readNumberVar` convention as every other family in this
 * module -- no second color path. `mode` selects which per-mode token pair
 * to read; defaults to "cloud" so an omitted mode still resolves to a real,
 * documented fog rather than throwing.
 */
export interface AtmosphereFogParams {
  color: GraphColor;
  density: number;
}

const DEFAULT_ATMOSPHERE_FOG_DENSITY: Record<GraphMode, number> = {
  cloud: 0.045,
  orbital: 0.02,
  strata: 0.03,
  terrain: 0.015,
};

export function readAtmosphereFogParams(
  root: Element = document.documentElement,
  mode: GraphMode = "cloud",
): AtmosphereFogParams {
  return {
    color: toGraphColor(readVar(`--graph-atmosphere-fog-color-${mode}`, root) || "oklch(0.14 0.025 260 / 0.6)"),
    density: readNumberVar(
      `--graph-atmosphere-fog-density-${mode}`,
      root,
      DEFAULT_ATMOSPHERE_FOG_DENSITY[mode],
    ),
  };
}

/**
 * Deep-Field Observatory Phase 5 (Section 5.3 "Mode-transition cross-fade":
 * "fog color/density interpolating" alongside the chrome cross-fade, riding
 * the SAME 800ms `transitioning` envelope Phase 4 already wired bloom
 * suppression to -- never a new/second fade-timing system). Pure linear
 * interpolation; `alpha` is expected to already be the eased
 * (`easeOutCubic`) progress `modeTransition.ts`'s `transitionAlpha` produces
 * -- this function does no easing of its own, matching `blendPositions`'
 * own "alpha is pre-eased by the caller" convention in that module.
 */
export function lerpAtmosphereFog(
  from: AtmosphereFogParams,
  to: AtmosphereFogParams,
  alpha: number,
): AtmosphereFogParams {
  const t = Math.min(1, Math.max(0, alpha));
  const color = from.color.color.clone().lerp(to.color.color, t);
  return {
    color: { color, alpha: from.color.alpha + (to.color.alpha - from.color.alpha) * t },
    density: from.density + (to.density - from.density) * t,
  };
}

/**
 * Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.2
 * Cloud tokens: "`--graph-cloud-nebula-color`/`-opacity` 0.12"; Section 5.1
 * J-CLOUD: "faint nebula haze"; Section 5.3 Ambient policy: "Nebula: fully
 * static, no drift ever" -- this module only reads the token, the
 * no-drift/no-animation discipline itself lives in the consuming component).
 */
export interface CloudChromeParams {
  nebulaColor: GraphColor;
  nebulaOpacity: number;
}

const DEFAULT_CLOUD_CHROME: CloudChromeParams["nebulaOpacity"] = 0.12;

export function readCloudChromeParams(root: Element = document.documentElement): CloudChromeParams {
  return {
    nebulaColor: toGraphColor(readVar("--graph-cloud-nebula-color", root) || "oklch(0.3 0.06 280 / 0.5)"),
    nebulaOpacity: readNumberVar("--graph-cloud-nebula-opacity", root, DEFAULT_CLOUD_CHROME),
  };
}

/**
 * Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.2
 * Orbital tokens: disc/ring/core-glow/inclination; Section 5.1 J-ORBITAL:
 * "an ecliptic disc, orbit rings, and a shell core glow ... an inclination
 * per the token"; Section 5.7: "Orbital ring ambient rotation ships
 * DISABLED" -- `ringInclinationDeg` is a static tilt, never an animated
 * spin; this module only reads the token).
 */
export interface OrbitalChromeParams {
  discColor: GraphColor;
  discOpacity: number;
  ringColor: GraphColor;
  ringWidth: number;
  coreGlowColor: GraphColor;
  coreGlowIntensity: number;
  ringInclinationDeg: number;
}

// Fallbacks mirror the dark-theme graph.css token block exactly (round-6
// escalation remediation raised the disc/ring contrast there -- see the
// "Orbital." comment in graph.css; no token/fallback drift).
const DEFAULT_ORBITAL_CHROME_NUMBERS = {
  discOpacity: 0.28,
  ringWidth: 1.5,
  coreGlowIntensity: 0.8,
  ringInclinationDeg: 6,
};

export function readOrbitalChromeParams(root: Element = document.documentElement): OrbitalChromeParams {
  return {
    discColor: toGraphColor(readVar("--graph-orbital-disc-color", root) || "oklch(0.52 0.06 250 / 0.4)"),
    discOpacity: readNumberVar("--graph-orbital-disc-opacity", root, DEFAULT_ORBITAL_CHROME_NUMBERS.discOpacity),
    ringColor: toGraphColor(readVar("--graph-orbital-ring-color", root) || "oklch(0.66 0.08 245 / 0.75)"),
    ringWidth: readNumberVar("--graph-orbital-ring-width", root, DEFAULT_ORBITAL_CHROME_NUMBERS.ringWidth),
    coreGlowColor: toGraphColor(readVar("--graph-orbital-core-glow-color", root) || "oklch(0.8 0.1 240 / 0.7)"),
    coreGlowIntensity: readNumberVar(
      "--graph-orbital-core-glow-intensity",
      root,
      DEFAULT_ORBITAL_CHROME_NUMBERS.coreGlowIntensity,
    ),
    ringInclinationDeg: readNumberVar(
      "--graph-orbital-ring-inclination",
      root,
      DEFAULT_ORBITAL_CHROME_NUMBERS.ringInclinationDeg,
    ),
  };
}

/**
 * Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.2
 * Strata tokens: floor/rim/axis; Section 5.1 J-STRATA: "graded translucent
 * floor planes per Leiden level plus an etched level axis with text
 * labels").
 */
export interface StrataChromeParams {
  floorColor: GraphColor;
  floorOpacity: number;
  floorFogDensity: number;
  bandRimColor: GraphColor;
  axisColor: GraphColor;
}

const DEFAULT_STRATA_CHROME_NUMBERS = { floorOpacity: 0.14, floorFogDensity: 0.03 };

export function readStrataChromeParams(root: Element = document.documentElement): StrataChromeParams {
  return {
    floorColor: toGraphColor(readVar("--graph-strata-floor-color", root) || "oklch(0.3 0.04 255 / 0.35)"),
    floorOpacity: readNumberVar("--graph-strata-floor-opacity", root, DEFAULT_STRATA_CHROME_NUMBERS.floorOpacity),
    floorFogDensity: readNumberVar(
      "--graph-strata-floor-fog-density",
      root,
      DEFAULT_STRATA_CHROME_NUMBERS.floorFogDensity,
    ),
    bandRimColor: toGraphColor(readVar("--graph-strata-band-rim-color", root) || "oklch(0.6 0.08 245 / 0.5)"),
    axisColor: toGraphColor(readVar("--graph-strata-axis-color", root) || "oklch(0.65 0.03 260)"),
  };
}

/**
 * Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.2
 * "Light-theme Terrain (structural)" + Terrain tokens: sky/hillshade/
 * contour. Terrain's structural light-theme node-darkening itself is
 * `readNodeMaterialParams`/`readCommunityGeneratorParams`'s `mode ===
 * "terrain"` branch (already Phase 1/2 territory, unchanged here) -- this
 * reader only adds the sky/hillshade/contour chrome tokens those two already
 * established branches did not cover.
 */
export interface TerrainChromeParams {
  skyTop: GraphColor;
  skyHorizon: GraphColor;
  hillshadeStrength: number;
  contourMajorColor: GraphColor;
  contourMinorColor: GraphColor;
  contourMajorWidth: number;
  contourMinorWidth: number;
}

const DEFAULT_TERRAIN_CHROME_NUMBERS = { hillshadeStrength: 0.8, contourMajorWidth: 1.5, contourMinorWidth: 0.75 };

export function readTerrainChromeParams(root: Element = document.documentElement): TerrainChromeParams {
  return {
    skyTop: toGraphColor(readVar("--graph-terrain-sky-top", root) || "oklch(0.18 0.03 255)"),
    skyHorizon: toGraphColor(readVar("--graph-terrain-sky-horizon", root) || "oklch(0.28 0.04 30)"),
    hillshadeStrength: readNumberVar(
      "--graph-terrain-hillshade-strength",
      root,
      DEFAULT_TERRAIN_CHROME_NUMBERS.hillshadeStrength,
    ),
    contourMajorColor: toGraphColor(
      readVar("--graph-terrain-contour-major-color", root) || "oklch(0.55 0.03 255 / 0.55)",
    ),
    contourMinorColor: toGraphColor(
      readVar("--graph-terrain-contour-minor-color", root) || "oklch(0.4 0.02 255 / 0.35)",
    ),
    contourMajorWidth: readNumberVar(
      "--graph-terrain-contour-major-width",
      root,
      DEFAULT_TERRAIN_CHROME_NUMBERS.contourMajorWidth,
    ),
    contourMinorWidth: readNumberVar(
      "--graph-terrain-contour-minor-width",
      root,
      DEFAULT_TERRAIN_CHROME_NUMBERS.contourMinorWidth,
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
    nodeMaterial: readNodeMaterialParams(root, mode),
    pattern: readPatternParams(root),
    labelTier: readLabelTierParams(root),
    edgeWeight: readEdgeWeightParams(root),
    bloom: readBloomParams(root),
    atmosphereFog: readAtmosphereFogParams(root, mode ?? "cloud"),
    cloudChrome: readCloudChromeParams(root),
    orbitalChrome: readOrbitalChromeParams(root),
    strataChrome: readStrataChromeParams(root),
    terrainChrome: readTerrainChromeParams(root),
    environment: readEnvironmentParams(root),
  };
}

/**
 * Deep-Field Observatory Phase 6 (plan Section 3.1 item 6 / Section 5.2
 * "Tokens": "environment/IBL `--graph-env-intensity` (dark 1.0 / light
 * 1.15)"; Section 6 Phase 6: "Extend `TerrainEnvironment.tsx` to drive
 * `scene.environment` IBL (PMREM) plus `scene.background`"). Plain number,
 * same `readNumberVar` convention as `readBloomParams`/`readVignetteParams`
 * above -- `TerrainEnvironment.tsx` multiplies `scene.environmentIntensity`
 * by this once a real HDRI (A1 dark / A2 light) has produced a PMREM
 * environment map; with no HDRI loaded, `scene.environment` stays unset and
 * this value goes unused (Section 5.4 Fallback).
 */
export interface EnvironmentParams {
  intensity: number;
}

const DEFAULT_ENVIRONMENT_PARAMS: EnvironmentParams = { intensity: 1 };

export function readEnvironmentParams(root: Element = document.documentElement): EnvironmentParams {
  return {
    intensity: readNumberVar("--graph-env-intensity", root, DEFAULT_ENVIRONMENT_PARAMS.intensity),
  };
}

/**
 * Deep-Field Observatory Phase 4 (plan Section 5.3 "Token alignment": the
 * new `--graph-motion-bloom-suppress` 150ms / `--graph-motion-bloom-restore`
 * 225ms tokens -- declared in `:root` AND collapsed under
 * `prefers-reduced-motion`, "like the existing durations"). A millisecond
 * counterpart to `readNumberVar` above, mirroring `lib/motion.ts`'s
 * `getDuration`/`readMs` convention exactly: read once per DISCRETE trigger
 * (a mode transition starting/ending, a safe-tier step), never per frame --
 * under `prefers-reduced-motion` the token itself resolves to `0ms`, so no
 * separate JS-side `prefersReducedMotion()` branch is needed here, same as
 * `getDuration`. Kept in this module (not `lib/motion.ts`) because these two
 * tokens are graph-scene-scoped, not the generic `--duration-*` family.
 */
export interface BloomMotionParams {
  suppressMs: number;
  restoreMs: number;
}

const DEFAULT_BLOOM_MOTION_PARAMS: BloomMotionParams = { suppressMs: 150, restoreMs: 225 };

function readMsVar(varName: string, root: Element, fallback: number): number {
  const raw = readVar(varName, root);
  const match = /^([\d.]+)ms$/.exec(raw);
  return match ? Number(match[1]) : fallback;
}

export function readBloomMotionParams(root: Element = document.documentElement): BloomMotionParams {
  return {
    suppressMs: readMsVar("--graph-motion-bloom-suppress", root, DEFAULT_BLOOM_MOTION_PARAMS.suppressMs),
    restoreMs: readMsVar("--graph-motion-bloom-restore", root, DEFAULT_BLOOM_MOTION_PARAMS.restoreMs),
  };
}

/**
 * Deep-Field Observatory Phase 4 (plan Section 3.1 item 4: "selective bloom
 * plus vignette"; not separately numerically specified by Section 5.2's
 * token list, so this is a labeled, token-driven small addition rather than
 * a hardcoded `<Vignette>` prop -- see graph.css's `--graph-vignette-*`
 * comment). `offset`/`darkness` match `@react-three/postprocessing`'s own
 * Vignette effect parameter names. Same `readNumberVar` convention as
 * `readBloomParams`.
 */
export interface VignetteParams {
  offset: number;
  darkness: number;
}

const DEFAULT_VIGNETTE_PARAMS: VignetteParams = { offset: 0.5, darkness: 0.5 };

export function readVignetteParams(root: Element = document.documentElement): VignetteParams {
  return {
    offset: readNumberVar("--graph-vignette-offset", root, DEFAULT_VIGNETTE_PARAMS.offset),
    darkness: readNumberVar("--graph-vignette-darkness", root, DEFAULT_VIGNETTE_PARAMS.darkness),
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
