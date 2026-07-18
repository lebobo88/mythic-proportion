import { describe, expect, it } from "vitest";
import {
  COMMUNITY_GLYPH_SHAPES,
  COMMUNITY_PATTERN_KINDS,
  communityGlyphDescription,
  communityGlyphShape,
  communityPatternKind,
} from "../communityGlyphs";

describe("communityGlyphShape / communityPatternKind", () => {
  it("is deterministic: same index always yields the same shape and pattern", () => {
    expect(communityGlyphShape(5)).toBe(communityGlyphShape(5));
    expect(communityPatternKind(5)).toBe(communityPatternKind(5));
  });

  it("cycles through all 8 shapes before repeating", () => {
    const seen = new Set(Array.from({ length: 8 }, (_, i) => communityGlyphShape(i)));
    expect(seen.size).toBe(COMMUNITY_GLYPH_SHAPES.length);
    expect(communityGlyphShape(8)).toBe(communityGlyphShape(0));
  });

  it("gives every community index 0..31 a UNIQUE (shape, pattern) combination", () => {
    const combos = new Set(
      Array.from({ length: 32 }, (_, i) => `${communityGlyphShape(i)}:${communityPatternKind(i)}`),
    );
    expect(combos.size).toBe(32);
  });

  it("repeats the (shape, pattern) combination past 32 (8 shapes x 4 patterns)", () => {
    expect(communityGlyphShape(32)).toBe(communityGlyphShape(0));
    expect(communityPatternKind(32)).toBe(communityPatternKind(0));
  });

  it("handles a negative-safe index (never throws, never returns undefined)", () => {
    expect(COMMUNITY_GLYPH_SHAPES).toContain(communityGlyphShape(-3));
    expect(COMMUNITY_PATTERN_KINDS).toContain(communityPatternKind(-3));
  });

  it("communityGlyphDescription reads as a screen-reader-friendly non-color cue", () => {
    expect(communityGlyphDescription(0)).toBe("circle");
    // index 8 = shape cycles back to "circle" but pattern advances to "dots".
    expect(communityGlyphDescription(8)).toBe("circle, dots");
  });
});
