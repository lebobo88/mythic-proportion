// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-CLOUD "faint nebula haze" / J-ORBITAL "a shell core glow"): a shared,
// pure canvas-drawing helper for the decorative soft-glow sprites both those
// chrome layers need -- same "pure canvas-drawing call sequence" plus
// "null under jsdom, callers degrade gracefully" convention
// `CommunityCentroidBadges.tsx`'s `drawCommunityGlyph`/
// `createCommunityGlyphCanvas` already established for the Phase 2 badge
// layer (Section 5.4 "Fallback" discipline applied to a second sprite
// family, not re-invented).
export interface Canvas2DGradientLike {
  addColorStop(offset: number, color: string): void;
}

/** Minimal subset of `CanvasRenderingContext2D` this module needs -- mirrors `CommunityCentroidBadges.tsx`'s own `Canvas2DLike` narrowing so `drawRadialGlow` is unit-testable without a real `<canvas>` (jsdom does not implement one). */
export interface Canvas2DRadialGlowLike {
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Canvas2DGradientLike;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

/**
 * Pure canvas-drawing call sequence: a centered radial gradient from the
 * given `colorHex` at full alpha (center) to fully transparent (edge),
 * filled across the whole `size`x`size` canvas -- a soft, borderless glow,
 * never a hard-edged disc.
 */
export function drawRadialGlow(ctx: Canvas2DRadialGlowLike, size: number, colorHex: string): void {
  const center = size / 2;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, colorHex);
  gradient.addColorStop(1, `${colorHex}00`);
  ctx.fillStyle = gradient as unknown as CanvasGradient;
  ctx.fillRect(0, 0, size, size);
}

const GLOW_CANVAS_SIZE = 128;

/** `null` under jsdom (no real `<canvas>` 2D context) or any environment without `document` -- callers skip that sprite for the render, matching this codebase's established enhancement-layer degrade-gracefully convention (plan Section 5.4 "Fallback"). */
export function createRadialGlowCanvas(colorHex: string, size: number = GLOW_CANVAS_SIZE): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawRadialGlow(ctx, size, colorHex);
  return canvas;
}
