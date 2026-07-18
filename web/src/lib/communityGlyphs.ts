// Non-color glyph + pattern cues for the generative community color ramp
// (plan Section 6.5 item 5, visual-system spec Section 5.1: "non-color
// glyph and pattern cues must accompany every color-coded distinction" --
// so a color-vision-deficient user, or anyone on the non-color-capable 2D
// accessibility tree, can still tell communities apart without relying on
// hue alone). Pure, dependency-free, deterministic: the same community
// index always yields the same (shape, pattern) pair, everywhere it's
// consumed (`CommunityGlyphIcon.tsx`, the per-mode accessibility tree, the
// per-mode 2D fallback panel).
//
// 8 shapes x 4 patterns = 32 distinct (shape, pattern) combinations before
// any repeat -- deliberately matched to the largest count named in the
// plan's own contrast-gate list (Section 6.5 item 8: "community counts of
// 8, 16, and 32"), so a 32-community graph never has two communities
// sharing BOTH a shape and a pattern, even though their generated hues
// necessarily get closer together as count grows.

export const COMMUNITY_GLYPH_SHAPES = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "star",
  "hexagon",
  "pentagon",
  "cross",
] as const;

export type CommunityGlyphShape = (typeof COMMUNITY_GLYPH_SHAPES)[number];

export const COMMUNITY_PATTERN_KINDS = ["solid", "dots", "stripes", "cross-hatch"] as const;

export type CommunityPatternKind = (typeof COMMUNITY_PATTERN_KINDS)[number];

/** Always non-negative -- guards a raw (possibly negative, e.g. a fallback-offset-free) community id. */
function nonNegativeMod(value: number, modulus: number): number {
  const m = ((value % modulus) + modulus) % modulus;
  return m;
}

export function communityGlyphShape(index: number): CommunityGlyphShape {
  return COMMUNITY_GLYPH_SHAPES[nonNegativeMod(index, COMMUNITY_GLYPH_SHAPES.length)];
}

export function communityPatternKind(index: number): CommunityPatternKind {
  const cycle = COMMUNITY_GLYPH_SHAPES.length * COMMUNITY_PATTERN_KINDS.length;
  const withinCycle = nonNegativeMod(index, cycle);
  const patternIndex = Math.floor(withinCycle / COMMUNITY_GLYPH_SHAPES.length);
  return COMMUNITY_PATTERN_KINDS[patternIndex];
}

/** Human-readable, screen-reader-friendly combination, e.g. "triangle, dotted". Used as the text half of the non-color cue everywhere a swatch is also rendered. */
export function communityGlyphDescription(index: number): string {
  const shape = communityGlyphShape(index);
  const pattern = communityPatternKind(index);
  return pattern === "solid" ? shape : `${shape}, ${pattern}`;
}
