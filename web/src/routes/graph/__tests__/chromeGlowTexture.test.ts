// Deep-Field Observatory Phase 5: shared canvas-glow-texture helper for the
// new decorative chrome layer (Cloud's nebula haze, Orbital's core glow) --
// same "pure canvas-drawing call sequence" plus "null under jsdom" convention
// `CommunityCentroidBadges.tsx`'s `drawCommunityGlyph`/`createCommunityGlyphCanvas`
// already established for the Phase 2 badge layer, reused here rather than
// re-invented for a second decorative sprite family.
import { describe, expect, it, vi } from "vitest";
import { drawRadialGlow, createRadialGlowCanvas, type Canvas2DGradientLike } from "../three/chromeGlowTexture";

function makeCtx() {
  const calls: string[] = [];
  const gradient: Canvas2DGradientLike = { addColorStop: vi.fn() };
  const ctx = {
    createRadialGradient: vi.fn(() => gradient),
    fillRect: vi.fn((...args: number[]) => calls.push(`fillRect(${args.join(",")})`)),
    fillStyle: "" as string | CanvasGradient,
  };
  return { ctx, gradient, calls };
}

describe("drawRadialGlow", () => {
  it("creates a radial gradient centered on the canvas and fills the full canvas with it", () => {
    const { ctx, gradient, calls } = makeCtx();
    drawRadialGlow(ctx as never, 64, "#ff8800");
    expect(ctx.createRadialGradient).toHaveBeenCalledWith(32, 32, 0, 32, 32, 32);
    expect(gradient.addColorStop).toHaveBeenCalled();
    expect(calls).toEqual(["fillRect(0,0,64,64)"]);
  });

  it("fades the gradient to fully transparent at the outer stop, never a hard edge", () => {
    const { ctx, gradient } = makeCtx();
    drawRadialGlow(ctx as never, 64, "#ff8800");
    const stops = (gradient.addColorStop as ReturnType<typeof vi.fn>).mock.calls;
    const lastStop = stops[stops.length - 1];
    expect(lastStop[0]).toBe(1);
    // Same hex color with a "00" alpha suffix -- fully transparent at the
    // outer edge, never a hard edge/solid ring.
    expect(String(lastStop[1])).toMatch(/00$/);
  });
});

describe("createRadialGlowCanvas", () => {
  it("returns null under an environment without a real 2D canvas context (jsdom)", () => {
    // jsdom's canvas.getContext("2d") returns null (no bundled canvas
    // implementation) -- same documented limitation
    // `createCommunityGlyphCanvas` already accepts.
    expect(createRadialGlowCanvas("#ff8800")).toBeNull();
  });
});
