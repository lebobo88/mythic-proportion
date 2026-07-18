// Code-native SVG glyph + swatch + text label for one community (plan
// Section 6.5 items 5/6; motion/asset spec: "code-native SVG icons for mode
// and community glyphs"). Every color-coded community distinction gets a
// paired non-color cue here -- a distinct GLYPH SHAPE, a distinct outline
// PATTERN (dash rhythm), and a plain-text label -- so nothing is
// communicated by color alone (Section 9.3 journey 4). Shared by the
// per-mode accessibility tree (`a11y/GraphA11yTree.tsx`) and the visible
// per-mode 2D fallback panel (`Graph2DModeFallback.tsx`), guaranteeing both
// render byte-for-byte the same glyph/color for the same community index.
import type { GraphColor } from "../../lib/graph-colors";
import {
  communityGlyphDescription,
  communityGlyphShape,
  communityPatternKind,
  type CommunityPatternKind,
} from "../../lib/communityGlyphs";

const PATTERN_DASH: Record<CommunityPatternKind, string | undefined> = {
  solid: undefined,
  dots: "1.4,2.2",
  stripes: "3.5,2",
  "cross-hatch": "1.8,1",
};

export function CommunityGlyphIcon({
  index,
  size = 14,
  color,
}: {
  index: number;
  size?: number;
  /** CSS color string (e.g. `#rrggbb`); omitted falls back to `currentColor` so the icon inherits surrounding text color. */
  color?: string;
}) {
  const shape = communityGlyphShape(index);
  const pattern = communityPatternKind(index);
  const dash = PATTERN_DASH[pattern];
  const fill = color ?? "currentColor";
  const shapeProps = {
    fill,
    stroke: "var(--color-bg, #000)",
    strokeWidth: 1,
    strokeDasharray: dash,
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="mp-community-glyph"
      data-glyph={shape}
      data-pattern={pattern}
    >
      {renderShape(shape, shapeProps)}
    </svg>
  );
}

function renderShape(
  shape: ReturnType<typeof communityGlyphShape>,
  props: { fill: string; stroke: string; strokeWidth: number; strokeDasharray?: string },
) {
  switch (shape) {
    case "circle":
      return <circle cx={8} cy={8} r={6} {...props} />;
    case "square":
      return <rect x={2} y={2} width={12} height={12} {...props} />;
    case "triangle":
      return <polygon points="8,2 14,14 2,14" {...props} />;
    case "diamond":
      return <polygon points="8,1 15,8 8,15 1,8" {...props} />;
    case "star":
      return <polygon points="8,1 10,6 15,6 11,9 12,14 8,11 4,14 5,9 1,6 6,6" {...props} />;
    case "hexagon":
      return <polygon points="8,1 14,4.5 14,11.5 8,15 2,11.5 2,4.5" {...props} />;
    case "pentagon":
      return <polygon points="8,1 15,6.5 12,15 4,15 1,6.5" {...props} />;
    case "cross":
      return <path d="M6,1 H10 V6 H15 V10 H10 V15 H6 V10 H1 V6 H6 Z" {...props} />;
    default:
      return <circle cx={8} cy={8} r={6} {...props} />;
  }
}

export function CommunityBadge({
  index,
  count,
  level,
  color,
  suffix,
}: {
  /** The community's slot index into the generative ramp (0..count-1). */
  index: number;
  /** Total distinct communities in the current dataset -- purely for a future caller that wants it; not read here. */
  count: number;
  /** Hierarchy level, when known (Strata) -- purely descriptive text, does not affect the glyph. */
  level?: number;
  color: GraphColor;
  /** Extra trailing text, e.g. a member count ("12 nodes"). */
  suffix?: string;
}) {
  const hex = `#${color.color.getHexString()}`;
  const glyphText = communityGlyphDescription(index);
  const levelText = level !== undefined ? ` (level ${level})` : "";
  // "of {count}" gives a screen-reader user the same "how many communities
  // total" context a sighted user gets for free from the visible ramp/legend.
  const countText = count > 0 ? ` of ${count}` : "";
  return (
    <span className="mp-community-badge">
      <CommunityGlyphIcon index={index} color={hex} />
      <span className="mp-community-badge-label">
        Community {index}
        {countText}
        {levelText} — {glyphText}
        {suffix ? `, ${suffix}` : ""}
      </span>
    </span>
  );
}
