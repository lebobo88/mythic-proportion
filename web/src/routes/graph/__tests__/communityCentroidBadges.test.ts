// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.9
// Decision A -- APPROVED, "Phase 2 implements the centroid glyph/badge
// layer"): the O(tens) community-centroid glyph/badge chrome layer. Split
// into pure, directly-testable pieces (same convention as
// `CommunityHulls.tsx`'s centroid-free precedent and
// `instancedNodesLod.test.ts`'s pure-function extraction) because jsdom
// cannot provide a real `<canvas>` 2D context (see Graph2DFallback.tsx's
// own established `if (!ctx) return` guard for this exact, already-accepted
// jsdom limitation) or a real WebGL/R3F render.
import { describe, expect, it, vi } from "vitest";
import { CanvasTexture } from "three";
import {
  applyBadgeTextureUpdates,
  computeCommunityCentroids,
  drawCommunityGlyph,
  MAX_CENTROID_BADGES,
  type Canvas2DLike,
} from "../three/CommunityCentroidBadges";
import { PATTERN_DASH } from "../CommunityBadge";
import type { VizNode } from "../types";

function node(overrides: Partial<VizNode> & { id: string }): VizNode {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    type: overrides.type ?? "entity",
    kind: overrides.kind ?? "entity",
    degree: overrides.degree ?? 0,
    community: overrides.community ?? 0,
    communityApproximate: overrides.communityApproximate ?? false,
    size: overrides.size ?? 1,
    level: overrides.level,
    centrality: overrides.centrality,
    parentCommunity: overrides.parentCommunity,
  };
}

function positionsRef(map: Record<string, [number, number, number]>) {
  return { get: (id: string) => map[id] };
}

describe("computeCommunityCentroids (pure aggregation)", () => {
  it("averages the positions of every visible entity node per community", () => {
    const nodes = [
      node({ id: "a", community: 0 }),
      node({ id: "b", community: 0 }),
      node({ id: "c", community: 1 }),
    ];
    const visibleIds = new Set(["a", "b", "c"]);
    const positions = positionsRef({ a: [0, 0, 0], b: [10, 0, 0], c: [5, 5, 5] });

    const centroids = computeCommunityCentroids(nodes, visibleIds, positions);
    const byCommunity = new Map(centroids.map((c) => [c.community, c]));
    expect(byCommunity.get(0)?.position).toEqual([5, 0, 0]);
    expect(byCommunity.get(0)?.count).toBe(2);
    expect(byCommunity.get(1)?.position).toEqual([5, 5, 5]);
    expect(byCommunity.get(1)?.count).toBe(1);
  });

  it("excludes non-visible nodes and nodes with no resolved position yet", () => {
    const nodes = [node({ id: "a", community: 0 }), node({ id: "b", community: 0 })];
    const visibleIds = new Set(["a"]); // "b" filtered out
    const positions = positionsRef({ a: [1, 1, 1] }); // "b" has no position yet
    const centroids = computeCommunityCentroids(nodes, visibleIds, positions);
    expect(centroids).toHaveLength(1);
    expect(centroids[0].count).toBe(1);
  });

  it("excludes non-entity nodes (source/concept/session -- not community-colored, Section 5.6 item 1)", () => {
    const nodes = [node({ id: "a", community: 0, kind: "page", type: "source" })];
    const visibleIds = new Set(["a"]);
    const positions = positionsRef({ a: [1, 1, 1] });
    expect(computeCommunityCentroids(nodes, visibleIds, positions)).toHaveLength(0);
  });

  it("returns no more than MAX_CENTROID_BADGES entries, keeping the largest communities first (O(tens) safety bound, Section 5.9 Decision A)", () => {
    const nodes: VizNode[] = [];
    const positions: Record<string, [number, number, number]> = {};
    const visibleIds = new Set<string>();
    const communityCount = MAX_CENTROID_BADGES + 20;
    for (let c = 0; c < communityCount; c++) {
      // Community 0 gets the most members, so it must survive the cap.
      const memberCount = communityCount - c;
      for (let m = 0; m < memberCount; m++) {
        const id = `n${c}-${m}`;
        nodes.push(node({ id, community: c }));
        positions[id] = [c, m, 0];
        visibleIds.add(id);
      }
    }
    const centroids = computeCommunityCentroids(nodes, visibleIds, positionsRef(positions));
    expect(centroids.length).toBe(MAX_CENTROID_BADGES);
    expect(centroids.some((c) => c.community === 0)).toBe(true); // largest community kept
  });
});

describe("drawCommunityGlyph (pure canvas-drawing calls, mockable Canvas2DLike)", () => {
  function makeMockCtx(): Canvas2DLike & Record<string, ReturnType<typeof vi.fn>> {
    return {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
    } as unknown as Canvas2DLike & Record<string, ReturnType<typeof vi.fn>>;
  }

  it("draws a circle via ctx.arc for shape 'circle'", () => {
    const ctx = makeMockCtx();
    drawCommunityGlyph(ctx, "circle", { fill: "#ff0000", dash: [] });
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.fillStyle).toBe("#ff0000");
  });

  it("draws every polygon shape via moveTo/lineTo/closePath (never ctx.arc)", () => {
    for (const shape of ["square", "triangle", "diamond", "star", "hexagon", "pentagon", "cross"] as const) {
      const ctx = makeMockCtx();
      drawCommunityGlyph(ctx, shape, { fill: "#00ff00", dash: [] });
      expect(ctx.moveTo).toHaveBeenCalledTimes(1);
      expect((ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
      expect(ctx.closePath).toHaveBeenCalled();
      expect(ctx.arc).not.toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
    }
  });

  it("only strokes the dash-rhythm outline when a non-empty dash is given (solid pattern has no dash and no stroke)", () => {
    const solidCtx = makeMockCtx();
    drawCommunityGlyph(solidCtx, "circle", { fill: "#fff", dash: [] });
    expect(solidCtx.stroke).not.toHaveBeenCalled();

    const dottedCtx = makeMockCtx();
    drawCommunityGlyph(dottedCtx, "circle", { fill: "#fff", dash: [1.4, 2.2] });
    expect(dottedCtx.setLineDash).toHaveBeenCalledWith([1.4, 2.2]);
    expect(dottedCtx.stroke).toHaveBeenCalled();
  });

  it("the dash rhythm passed through matches CommunityBadge.tsx's own PATTERN_DASH for every non-solid pattern (single source, never a second hand-tuned copy)", () => {
    for (const [, dashString] of Object.entries(PATTERN_DASH)) {
      if (!dashString) continue; // "solid" -- undefined
      const numeric = dashString.split(",").map(Number);
      expect(numeric.every((n) => Number.isFinite(n))).toBe(true);
    }
  });
});

// Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major): a retained
// community's cached badge texture must repaint on every `colors` change
// (theme flip), not only the first time it's created -- plan Section 5.1
// J-THEME-SWITCH ("scene, glow tints, ramp, and chrome re-tint without a
// remount") and Section 5.3 ("Theme switch: Instant atomic re-tint...
// applies to both outgoing and incoming targets"). Mirrors the sibling
// community-title effect in NodeLabels.tsx, which already re-tints every
// retained title unconditionally on every `colors` change.
describe("applyBadgeTextureUpdates (theme-flip repaint of retained badges, Verifier remediation cycle 1)", () => {
  const centroidA = { community: 0, position: [0, 0, 0] as [number, number, number], count: 3 };

  it("repaints (not just recolors on first paint) a RETAINED community's texture when colorsChanged is true -- the exact regression: a stale pre-switch-colored canvas must not survive a theme flip", () => {
    const staleCanvas = { width: 64, height: 64 } as unknown as HTMLCanvasElement;
    const cachedTexture = new CanvasTexture(staleCanvas);
    const cache = new Map<number, CanvasTexture>([[0, cachedTexture]]);

    const freshCanvas = { width: 64, height: 64, marker: "fresh" } as unknown as HTMLCanvasElement;
    const paint = vi.fn().mockReturnValue(freshCanvas);

    const versionBeforeRepaint = cachedTexture.version;
    const result = applyBadgeTextureUpdates([centroidA], cache, /* colorsChanged */ true, paint);

    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith(0);
    expect(result[0].texture).toBe(cachedTexture); // SAME texture object reused, not dispose+recreate
    expect(result[0].texture?.image).toBe(freshCanvas); // but its backing image IS the freshly repainted canvas
    // `needsUpdate` is a write-only setter on THREE.Texture (no getter) --
    // it bumps `.version` as its only observable effect, which is what
    // WebGLRenderer actually checks to decide whether to re-upload the GPU
    // texture. A version bump is therefore the correct, real proxy for "was
    // flagged for GPU re-upload", not reading `.needsUpdate` back.
    expect(result[0].texture?.version).toBeGreaterThan(versionBeforeRepaint);
  });

  it("does NOT repaint a retained community when colorsChanged is false (no wasted work on every low-frequency centroid-recompute tick)", () => {
    const cachedTexture = new CanvasTexture({} as unknown as HTMLCanvasElement);
    const cache = new Map<number, CanvasTexture>([[0, cachedTexture]]);
    const paint = vi.fn();
    const versionBefore = cachedTexture.version;

    const result = applyBadgeTextureUpdates([centroidA], cache, /* colorsChanged */ false, paint);

    expect(paint).not.toHaveBeenCalled();
    expect(result[0].texture).toBe(cachedTexture);
    expect(result[0].texture?.version).toBe(versionBefore); // untouched -- no spurious GPU re-upload
  });

  it("still creates a brand-new texture for a community with no cache entry, regardless of colorsChanged", () => {
    const canvas = { width: 64, height: 64 } as unknown as HTMLCanvasElement;
    const paint = vi.fn().mockReturnValue(canvas);
    const cache = new Map<number, CanvasTexture>();

    const result = applyBadgeTextureUpdates([centroidA], cache, false, paint);

    expect(paint).toHaveBeenCalledTimes(1);
    expect(result[0].texture).toBeInstanceOf(CanvasTexture);
    expect(cache.get(0)).toBe(result[0].texture);
  });

  it("if paint returns null (e.g. no document/canvas available), a retained texture is left untouched rather than nulled out", () => {
    const cachedTexture = new CanvasTexture({} as unknown as HTMLCanvasElement);
    const cache = new Map<number, CanvasTexture>([[0, cachedTexture]]);
    const paint = vi.fn().mockReturnValue(null);

    const result = applyBadgeTextureUpdates([centroidA], cache, true, paint);

    expect(result[0].texture).toBe(cachedTexture);
  });
});
