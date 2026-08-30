// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.9
// Decision A -- APPROVED: "Phase 2 implements the centroid glyph/badge layer
// as specified in Section 3.1 item 2 and the J-CLOUD/J-ORBITAL/J-STRATA/
// J-TERRAIN journeys"). An O(tens) billboard chrome layer, one small
// `THREE.Sprite` draw call per community centroid -- a SEPARATE chrome-layer
// addition in the same family as the existing `CommunityHulls`/`NodeLabels`
// objects, NOT a revisit of the single-draw-call node/edge invariant
// (Section 5.9's own framing: "this badge layer... is not a violation of
// that invariant"). Reuses the SAME shape/pattern source
// (`communityGlyphShape`/`communityPatternKind` in `lib/communityGlyphs.ts`,
// `PATTERN_DASH` in `CommunityBadge.tsx`) the legend/2D-fallback/a11y-tree
// `CommunityBadge` component already renders, so the in-canvas badge can
// never disagree with those (Section 5.1 Accessibility / Gate B item 2).
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { CanvasTexture } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import {
  communityGlyphShape,
  communityPatternKind,
  type CommunityGlyphShape,
} from "../../../lib/communityGlyphs";
import { PATTERN_DASH } from "../CommunityBadge";
import type { VizNode } from "../types";

export interface CommunityCentroid {
  community: number;
  position: [number, number, number];
  count: number;
}

/**
 * O(tens) safety bound (Section 5.9 Decision A: "an O(tens) billboard chrome
 * layer"). Real Leiden community counts in this app's own gating convention
 * top out at 32 (contrast.test.ts's ramp gate); this is a generous ceiling
 * above that so a pathological dataset can never regress the badge layer
 * into an unbounded per-community draw-call count. When exceeded, the
 * LARGEST communities (by currently-visible member count) keep their badge
 * -- the ones most likely to be visually significant -- rather than an
 * arbitrary/index-ordered subset.
 */
export const MAX_CENTROID_BADGES = 60;

/**
 * Pure aggregation, exported/directly testable without any R3F/WebGL
 * context (same convention as `CommunityHulls.tsx`'s own per-community
 * grouping, and `Graph3DScene.tsx`'s `computeBoundingSphere`). Only
 * `kind === "entity"` nodes contribute (Section 5.6 item 1: community
 * identity applies to community-colored nodes; source/concept/session nodes
 * are colored by TYPE, not community, and carry no meaningful centroid
 * membership).
 */
export function computeCommunityCentroids(
  nodes: VizNode[],
  visibleIds: Set<string>,
  positionsRef: { get(id: string): [number, number, number] | undefined },
): CommunityCentroid[] {
  const sums = new Map<number, { x: number; y: number; z: number; count: number }>();
  for (const node of nodes) {
    if (node.kind !== "entity") continue;
    if (!visibleIds.has(node.id)) continue;
    const pos = positionsRef.get(node.id);
    if (!pos) continue;
    const agg = sums.get(node.community) ?? { x: 0, y: 0, z: 0, count: 0 };
    agg.x += pos[0];
    agg.y += pos[1];
    agg.z += pos[2];
    agg.count += 1;
    sums.set(node.community, agg);
  }
  const out: CommunityCentroid[] = [];
  for (const [community, agg] of sums) {
    out.push({
      community,
      position: [agg.x / agg.count, agg.y / agg.count, agg.z / agg.count],
      count: agg.count,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, MAX_CENTROID_BADGES);
}

/** Minimal subset of `CanvasRenderingContext2D` this module needs -- kept narrow and mockable so `drawCommunityGlyph` is unit-testable without a real `<canvas>` (jsdom does not implement `getContext`, matching `Graph2DFallback.tsx`'s already-accepted `if (!ctx) return` limitation). */
export interface Canvas2DLike {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
}

// Ported 1:1 from `CommunityBadge.tsx`'s `renderShape` SVG point
// coordinates (same 0-16 viewBox) -- so the canvas raster and the DOM SVG
// glyph are visually the same shape, not independently re-derived.
const SHAPE_POINTS: Record<Exclude<CommunityGlyphShape, "circle">, [number, number][]> = {
  square: [
    [2, 2],
    [14, 2],
    [14, 14],
    [2, 14],
  ],
  triangle: [
    [8, 2],
    [14, 14],
    [2, 14],
  ],
  diamond: [
    [8, 1],
    [15, 8],
    [8, 15],
    [1, 8],
  ],
  star: [
    [8, 1],
    [10, 6],
    [15, 6],
    [11, 9],
    [12, 14],
    [8, 11],
    [4, 14],
    [5, 9],
    [1, 6],
    [6, 6],
  ],
  hexagon: [
    [8, 1],
    [14, 4.5],
    [14, 11.5],
    [8, 15],
    [2, 11.5],
    [2, 4.5],
  ],
  pentagon: [
    [8, 1],
    [15, 6.5],
    [12, 15],
    [4, 15],
    [1, 6.5],
  ],
  cross: [
    [6, 1],
    [10, 1],
    [10, 6],
    [15, 6],
    [15, 10],
    [10, 10],
    [10, 15],
    [6, 15],
    [6, 10],
    [1, 10],
    [1, 6],
    [6, 6],
  ],
};

/**
 * Pure canvas-drawing call sequence -- fill = the community's own ramp
 * color (community identity carrier), an optional dashed stroke = the
 * outline PATTERN non-color cue (SAME dash rhythm as
 * `CommunityBadge.tsx`'s `PATTERN_DASH`, "solid" -> empty `dash` -> no
 * stroke at all, matching the DOM glyph's own `strokeDasharray: undefined`
 * behavior for "solid").
 */
export function drawCommunityGlyph(
  ctx: Canvas2DLike,
  shape: CommunityGlyphShape,
  opts: { fill: string; dash: number[] },
): void {
  ctx.fillStyle = opts.fill;
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(8, 8, 6, 0, Math.PI * 2);
  } else {
    const points = SHAPE_POINTS[shape];
    points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }
  ctx.fill();
  if (opts.dash.length > 0) {
    // A dark, low-alpha overlay stroke -- a fixed compositing accent (not a
    // second community/semantic color source), mirroring the DOM glyph's
    // own `stroke: var(--color-bg, #000)` fallback-on-canvas convention.
    ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash(opts.dash);
    ctx.stroke();
  }
}

const CENTROID_BADGE_CANVAS_SIZE = 64;

/** `null` under jsdom (no real `<canvas>` 2D context) or any environment without `document` -- callers skip that community's sprite for the render, matching this codebase's established enhancement-layer degrade-gracefully convention (Section 5.4 "Fallback"). */
export function createCommunityGlyphCanvas(shape: CommunityGlyphShape, fillHex: string, dash: number[]): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = CENTROID_BADGE_CANVAS_SIZE;
  canvas.height = CENTROID_BADGE_CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const scale = CENTROID_BADGE_CANVAS_SIZE / 16;
  ctx.scale(scale, scale);
  drawCommunityGlyph(ctx, shape, { fill: fillHex, dash });
  return canvas;
}

function dashArrayFor(community: number): number[] {
  const pattern = communityPatternKind(community);
  const raw = PATTERN_DASH[pattern];
  return raw ? raw.split(",").map(Number) : [];
}

/**
 * Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major): decides,
 * per visible centroid, whether its cached badge texture needs a fresh
 * canvas paint -- and applies that paint -- covering BOTH cases a badge
 * texture can need repainting: (1) no cache entry yet (a brand-new
 * community), and (2) a RETAINED community whose `colors` (theme) changed
 * since it was last painted. Before this fix, only case (1) repainted;
 * a community that stayed visible across a theme flip kept its stale
 * pre-switch-colored canvas indefinitely (plan Section 5.1 J-THEME-SWITCH:
 * "scene, glow tints, ramp, and chrome re-tint without a remount"; Section
 * 5.3: "Theme switch: Instant atomic re-tint... applies to both outgoing
 * and incoming targets") -- matching the sibling community-title effect in
 * `NodeLabels.tsx`, which already re-tints every retained title
 * unconditionally on every `colors` change.
 *
 * A retained/repainted texture is the SAME `CanvasTexture` object (cheaper
 * than dispose+recreate) with its `.image` reassigned and `.needsUpdate`
 * flagged for GPU re-upload, rather than a brand-new `CanvasTexture`
 * instance -- only a genuinely new community gets a newly constructed one.
 * `paint` is injected (rather than calling `createCommunityGlyphCanvas`
 * directly) so this function is testable without a real `<canvas>` 2D
 * context (jsdom does not implement one -- see this file's other pure
 * exports for the same convention).
 */
export function applyBadgeTextureUpdates(
  centroids: CommunityCentroid[],
  cache: Map<number, CanvasTexture>,
  colorsChanged: boolean,
  paint: (community: number) => HTMLCanvasElement | null,
): { centroid: CommunityCentroid; texture: CanvasTexture | null }[] {
  return centroids.map((centroid) => {
    let texture = cache.get(centroid.community);
    const needsPaint = !texture || colorsChanged;
    if (needsPaint) {
      const canvas = paint(centroid.community);
      if (canvas) {
        if (texture) {
          texture.image = canvas;
          texture.needsUpdate = true;
        } else {
          texture = new CanvasTexture(canvas);
        }
        cache.set(centroid.community, texture);
      }
    }
    return { centroid, texture: texture ?? null };
  });
}

export interface CommunityCentroidBadgesProps {
  nodes: VizNode[];
  visibleIds: Set<string>;
  colors: GraphColors;
  /** Same `{ get(id) }` accessor shape `CommunityHulls`/`Graph3DScene` already share -- see `Graph3DScene.tsx`'s `positionsAccessorRef`. */
  positionsRef: MutableRefObject<{ get(id: string): [number, number, number] | undefined }>;
}

/**
 * Recomputed on the SAME low-frequency interval `CommunityHulls.tsx`
 * already uses for its own coarse, non-per-tick recompute (never inside the
 * per-tick/`useFrame` hot path -- "never setState in useFrame"). Renders one
 * `<sprite>` (a `THREE.Sprite`, always camera-facing by construction -- the
 * "billboard" framing Section 5.9 names) per surviving centroid, textured
 * from a canvas raster of the same glyph shape/pattern the DOM
 * `CommunityBadge` renders for the identical community index.
 */
export function CommunityCentroidBadges({ nodes, visibleIds, colors, positionsRef }: CommunityCentroidBadgesProps) {
  const [centroids, setCentroids] = useState<CommunityCentroid[]>([]);
  const textureCache = useRef(new Map<number, CanvasTexture>());
  // Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major): tracks the
  // `colors` reference this cache was last painted against, so a theme flip
  // (a new `colors` object from `subscribeGraphColors`) is distinguished
  // from the SAME `colors` merely re-triggering this effect via the
  // low-frequency `centroids` interval tick above (which fires every 800ms
  // regardless of whether colors changed) -- see `applyBadgeTextureUpdates`'
  // doc comment for the full defect this guards against.
  const lastPaintedColorsRef = useRef<GraphColors | null>(null);
  // Mirrors `centroids`/`colors` into render-safe React state -- texture
  // creation/disposal is a genuine side effect (GPU resource lifecycle), so
  // it belongs in `useEffect`, never inside `useMemo` (a `useMemo` callback
  // is not guaranteed to run exactly once per input change -- e.g. React
  // Strict Mode's dev-mode double-invoke -- so mutating/disposing a shared
  // cache there risks a spurious extra dispose+recreate cycle; `useEffect`
  // does not have that hazard).
  const [sprites, setSprites] = useState<{ centroid: CommunityCentroid; texture: CanvasTexture | null }[]>([]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setCentroids(computeCommunityCentroids(nodes, visibleIds, positionsRef.current));
    }, 800);
    return () => window.clearInterval(id);
  }, [nodes, visibleIds, positionsRef]);

  useEffect(() => {
    const cache = textureCache.current;
    const keep = new Set(centroids.map((c) => c.community));
    for (const [community, texture] of cache) {
      if (!keep.has(community)) {
        texture.dispose();
        cache.delete(community);
      }
    }

    const colorsChanged = lastPaintedColorsRef.current !== colors;
    lastPaintedColorsRef.current = colors;

    setSprites(
      applyBadgeTextureUpdates(centroids, cache, colorsChanged, (community) => {
        const swatch = colors.community[community % colors.community.length];
        const shape = communityGlyphShape(community);
        return createCommunityGlyphCanvas(shape, `#${swatch.color.getHexString()}`, dashArrayFor(community));
      }),
    );
  }, [centroids, colors]);

  useEffect(() => {
    const cache = textureCache.current;
    return () => {
      for (const texture of cache.values()) texture.dispose();
      cache.clear();
    };
  }, []);

  return (
    <group>
      {sprites.map(({ centroid, texture }) =>
        texture ? (
          <sprite key={centroid.community} position={centroid.position} scale={[3, 3, 3]}>
            <spriteMaterial map={texture} transparent depthWrite={false} />
          </sprite>
        ) : null,
      )}
    </group>
  );
}
