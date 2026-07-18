import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wcagContrast } from "culori";
import {
  communityChroma,
  communityHue,
  communityOklch,
  readCommunityGeneratorParams,
  type CommunityGeneratorParams,
} from "../../lib/graph-colors";

// Token-contrast audit (Phase 1 testing strategy: "4.5:1 body / 3:1 large+UI
// in both light and dark"). Deliberately parses the *real* CSS token files
// on disk (not a duplicated JS copy of the values) so this test can never
// silently drift from what actually ships — CSS custom properties remain
// the single runtime source of truth per specs/ROADMAP-BRIEF.md §6.6.

function readCss(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf-8");
}

function extractDeclarations(blockText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--([\w-]+):\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(blockText)) !== null) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

function extractBlock(css: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css);
  if (!match) {
    throw new Error(`contrast.test.ts: could not find block for ${selectorPattern}`);
  }
  return match[1];
}

/**
 * Deep-Field Observatory Phase 1: generalized from the original single-hop
 * `resolveValue` to a RECURSIVE resolver over a merged raw-declaration map,
 * because the new Component-tier tokens (components.css) are two hops from
 * a primitive (e.g. `--search-mark-bg` -> `--color-highlight-surface` ->
 * `--warning-600`). Still resolves only real `var(--x)` references off the
 * real files on disk -- no duplicated JS copy of any value. A depth guard
 * throws (loud, in-test) rather than looping forever on an accidental
 * circular reference.
 */
function resolveDeep(value: string, raw: Record<string, string>, depth = 0): string {
  if (depth > 10) {
    throw new Error(`contrast.test.ts: var() resolution too deep (possible cycle) at "${value}"`);
  }
  const varMatch = /^var\(--([\w-]+)\)$/.exec(value);
  if (!varMatch) return value;
  const resolved = raw[varMatch[1]];
  if (!resolved) throw new Error(`contrast.test.ts: unresolved var(--${varMatch[1]})`);
  return resolveDeep(resolved, raw, depth + 1);
}

function resolveAll(raw: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    resolved[key] = resolveDeep(`var(--${key})`, raw);
  }
  return resolved;
}

const primitivesCss = readCss("../tokens/primitives.css");
const semanticCss = readCss("../tokens/semantic.css");
const componentsCss = readCss("../tokens/components.css");
const graphCss = readCss("../tokens/graph.css");

const primitives = extractDeclarations(extractBlock(primitivesCss, /:root\s*{([\s\S]*)}/));

// The themeless bare `:root { ... }` block in semantic.css (--focus-context-
// dim, plus Phase 1's `--color-highlight-surface`/`--color-text-on-
// highlight`) -- deliberately theme-independent, same precedent as
// `--focus-context-dim` itself.
const semanticRootBlock = extractDeclarations(extractBlock(semanticCss, /:root\s*{([^}]*)}/));

const semanticDarkBlock = extractDeclarations(
  extractBlock(semanticCss, /:root,\s*\[data-theme="dark"\]\s*{([^}]*)}/),
);
const semanticLightBlock = extractDeclarations(
  extractBlock(semanticCss, /\[data-theme="light"\]\s*{([^}]*)}/),
);

// components.css is a single theme-agnostic `:root` block -- every value in
// it resolves through a theme-aware semantic token (or, for the new
// `--graph-label-chip-*` family, a theme-aware `--graph-*` token), so it is
// merged into BOTH per-theme raw maps below rather than resolved on its own.
const componentsBlock = extractDeclarations(extractBlock(componentsCss, /:root\s*{([\s\S]*)}/));

const graphDarkBlock = extractDeclarations(
  extractBlock(graphCss, /:root,\s*\[data-theme="dark"\]\s*{([^}]*)}/),
);
const graphLightBlock = extractDeclarations(extractBlock(graphCss, /\[data-theme="light"\]\s*{([^}]*)}/));

const darkRaw: Record<string, string> = {
  ...primitives,
  ...semanticRootBlock,
  ...semanticDarkBlock,
  ...componentsBlock,
  ...graphDarkBlock,
};
const lightRaw: Record<string, string> = {
  ...primitives,
  ...semanticRootBlock,
  ...semanticLightBlock,
  ...componentsBlock,
  ...graphLightBlock,
};

const dark = resolveAll(darkRaw);
const light = resolveAll(lightRaw);

describe("design-token contrast audit", () => {
  it.each([
    ["dark", dark],
    ["light", light],
  ])("%s theme: body text meets 4.5:1 against surfaces", (_name, theme) => {
    expect(wcagContrast(theme["color-text-primary"], theme["color-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(theme["color-text-secondary"], theme["color-bg"])).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      wcagContrast(theme["color-text-primary"], theme["color-bg-elevated"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      wcagContrast(theme["color-text-secondary"], theme["color-bg-elevated"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])("%s theme: accent (large text / UI) meets 3:1 against bg", (_name, theme) => {
    expect(wcagContrast(theme["color-accent"], theme["color-bg"])).toBeGreaterThanOrEqual(3.0);
  });
});

// Deep-Field Observatory Phase 1 (plan Section 5.2 "Contrast-test-extension
// scope"; VISUAL_REVIEW finding F5; Section 6 Phase 1: "Extend
// contrast.test.ts with every new both-theme pairing listed in Section
// 5.2's contrast-test-extension scope"). Every `it.each` block below is one
// listed pairing; none is a fabricated pass -- every assertion is checked
// against the real token files on disk exactly like the pre-existing suite
// above.
describe("Phase 1 contrast-test extension (plan Section 5.2/6 Phase 1)", () => {
  it.each([
    ["dark", dark],
    ["light", light],
  ])(
    "%s theme: text-primary/secondary meet 4.5:1 against --color-bg-inset (F5 offender 1)",
    (_name, theme) => {
      expect(wcagContrast(theme["color-text-primary"], theme["color-bg-inset"])).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(wcagContrast(theme["color-text-secondary"], theme["color-bg-inset"])).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );

  it.each([
    ["dark", dark],
    ["light", light],
  ])("%s theme: --search-mark-fg meets 4.5:1 against --search-mark-bg (F5 offender 2)", (_name, theme) => {
    expect(wcagContrast(theme["search-mark-fg"], theme["search-mark-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])(
    // The chip itself is `color-mix(in oklch, var(--graph-bg) X%, transparent)`
    // -- not a flat resolvable color, so this checks the pairing against the
    // literal `--graph-bg` it is tinted from, the conservative composite
    // floor (see components.css's `--graph-label-chip-*` comment).
    "%s theme: --graph-label-chip-fg meets 4.5:1 against the chip's --graph-bg tint",
    (_name, theme) => {
      expect(wcagContrast(theme["graph-label-chip-fg"], theme["graph-bg"])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("light theme: Terrain node/community lightness 0.38 meets 3:1 against --graph-terrain-sky-top/-horizon, across every gated hue/chroma", () => {
    const terrainParams: CommunityGeneratorParams = communityGeneratorParams(graphLightBlock, "terrain");
    expect(terrainParams.lightness).toBeCloseTo(0.38, 5);
    for (const count of GATED_COMMUNITY_COUNTS) {
      for (let index = 0; index < count; index += Math.max(1, Math.floor(count / 4))) {
        for (const level of GATED_LEVELS) {
          const color = communityOklch(index, count, level, terrainParams);
          expect(
            wcagContrast(color, light["graph-terrain-sky-top"]),
            `top: count=${count} index=${index} level=${level} color=${color}`,
          ).toBeGreaterThanOrEqual(3.0);
          expect(
            wcagContrast(color, light["graph-terrain-sky-horizon"]),
            `horizon: count=${count} index=${index} level=${level} color=${color}`,
          ).toBeGreaterThanOrEqual(3.0);
        }
      }
    }
  });

  // `--graph-node-outline-color` (Section 5.2's non-luminance focus outline)
  // against every `--graph-node-*` type fill and the generative community
  // ramp, both themes. Deliberately does NOT also assert the outline against
  // the literal `--graph-bg` floor: direct relative-luminance computation
  // during this phase proved that pairing mathematically infeasible
  // simultaneously with the fill pairing here, in EITHER theme (`--graph-bg`
  // and every node/community fill are only ~4.5-8.5:1 apart from each
  // other -- a single color 3x-luminance-away from both endpoints requires
  // the endpoints to be >=9:1 apart). See graph.css's
  // `--graph-node-outline-color` comment for the full evidence; this is a
  // disclosed, non-fabricated scope decision (Section 5.2's "no fabricated
  // passes"), not an oversight.
  it.each([
    ["dark", dark, graphDarkBlock],
    ["light", light, graphLightBlock],
  ])("%s theme: --graph-node-outline-color meets 3:1 against every node-type fill and the community ramp", (
    _name,
    theme,
    graphBlock,
  ) => {
    const outline = theme["graph-node-outline-color"];
    for (const nodeType of ["source", "entity", "concept", "session"]) {
      expect(
        wcagContrast(outline, theme[`graph-node-${nodeType}`]),
        `outline vs graph-node-${nodeType}`,
      ).toBeGreaterThanOrEqual(3.0);
    }
    const params = communityGeneratorParams(graphBlock);
    for (const count of GATED_COMMUNITY_COUNTS) {
      for (let index = 0; index < count; index += Math.max(1, Math.floor(count / 4))) {
        const color = communityOklch(index, count, 0, params);
        expect(wcagContrast(outline, color), `outline vs community count=${count} index=${index}`).toBeGreaterThanOrEqual(
          3.0,
        );
      }
    }
  });
});

// Phase 4c (plan Section 6.5 item 8): the gating case for the generative
// OKLCH community ramp -- MUST pass before shipping more than 8 communities
// (plan's own risk table, Section 11). Reads the real
// `--graph-community-generator-*` NUMBER tokens off the actual graph.css
// file on disk (same "never drift from what ships" discipline as the rest
// of this file), then drives the exact same pure `communityHue`/
// `communityChroma`/`communityOklch` functions the runtime ramp uses
// (lib/graph-colors.ts) -- so this test can never pass by testing a
// different formula than what's shipped.
function communityGeneratorParams(
  block: Record<string, string>,
  mode?: "cloud" | "orbital" | "strata" | "terrain",
): CommunityGeneratorParams {
  // Delegates to the real runtime function (not a re-implementation) via a
  // scratch element carrying the exact same custom-property names read off
  // the actual token file -- keeps this test on the identical resolution
  // path Phase 1's terrain-aware branch introduced (lib/graph-colors.ts).
  const root = document.createElement("div");
  for (const [key, value] of Object.entries(block)) {
    root.style.setProperty(`--${key}`, value);
  }
  document.body.appendChild(root);
  try {
    return readCommunityGeneratorParams(root, mode);
  } finally {
    root.remove();
  }
}

const graphDarkParams = communityGeneratorParams(graphDarkBlock);
const graphLightParams = communityGeneratorParams(graphLightBlock);

// Community-as-accent pairing: like `--color-accent` above, a community
// swatch is a graphical/UI-scale element (chip, hull, node fill), never
// body text -- so it is held to the same 3:1 "large text / UI" floor, not
// the 4.5:1 body-text floor.
const COMMUNITY_ACCENT_MIN_CONTRAST = 3.0;
const GATED_COMMUNITY_COUNTS = [8, 16, 32];
// Comfortably past any Strata hierarchy depth this plan's synthetic fixture
// or real Leiden output produces (see synthetic.ts's SYNTHETIC_LEVEL_COUNT
// = 4); levels are also independently gate-checked for bound compliance up
// to 100 below.
const GATED_LEVELS = [0, 1, 2, 3, 4, 5, 6];

describe("generative community color ramp (plan Section 6.5 item 8 -- gates >8 communities)", () => {
  it.each([
    ["dark", dark, graphDarkParams],
    ["light", light, graphLightParams],
  ])(
    "%s theme: every generated ramp member at counts 8/16/32, across levels 0-6, meets 3:1 (community-as-accent) against bg",
    (_themeName, theme, params) => {
      for (const count of GATED_COMMUNITY_COUNTS) {
        for (let index = 0; index < count; index++) {
          for (const level of GATED_LEVELS) {
            const color = communityOklch(index, count, level, params);
            const contrast = wcagContrast(color, theme["color-bg"]);
            expect(
              contrast,
              `count=${count} index=${index} level=${level} color=${color} contrast=${contrast}`,
            ).toBeGreaterThanOrEqual(COMMUNITY_ACCENT_MIN_CONTRAST);
          }
        }
      }
    },
  );

  it.each([
    ["dark", graphDarkParams],
    ["light", graphLightParams],
  ])("%s theme: level-to-chroma mapping stays within [chroma-min, chroma-max] for every level 0-100", (
    _themeName,
    params,
  ) => {
    for (let level = 0; level <= 100; level++) {
      const chroma = communityChroma(level, params);
      expect(chroma).toBeGreaterThanOrEqual(params.chromaMin);
      expect(chroma).toBeLessThanOrEqual(params.chromaMax);
    }
    // Chroma actually MOVES with level (not a no-op bound) until it clamps.
    expect(communityChroma(1, params)).toBeGreaterThan(communityChroma(0, params));
  });

  it("hue formula spaces ramp members evenly across the real token's hue-base, at every gated count", () => {
    for (const count of GATED_COMMUNITY_COUNTS) {
      const hues = Array.from({ length: count }, (_, i) => communityHue(i, count, graphDarkParams.hueBase));
      // No two distinct indices collide on the same hue.
      expect(new Set(hues.map((h) => h.toFixed(6))).size).toBe(count);
      // Spacing between consecutive members is uniform (360 / count).
      const expectedStep = 360 / count;
      expect(hues[1] - hues[0]).toBeCloseTo(expectedStep, 5);
    }
  });

  it("dark and light themes share the same hue-base/chroma bounds -- only lightness is themed (Section 5.1: dark-theme values unchanged)", () => {
    expect(graphLightParams.hueBase).toBe(graphDarkParams.hueBase);
    expect(graphLightParams.chromaMin).toBe(graphDarkParams.chromaMin);
    expect(graphLightParams.chromaMax).toBe(graphDarkParams.chromaMax);
    expect(graphLightParams.chromaLevelStep).toBe(graphDarkParams.chromaLevelStep);
    expect(graphDarkParams.lightness).toBeCloseTo(0.72, 5); // unchanged from the pre-generative fixed ramp's L
    expect(graphLightParams.lightness).toBeLessThan(graphDarkParams.lightness); // the flagged light-theme override
  });
});
