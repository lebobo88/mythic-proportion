// Pure, dependency-free per-mode data derivation for BOTH halves of item 6
// (plan Section 6.5): the accessibility tree (`a11y/GraphA11yTree.tsx`) and
// the visible non-Cloud 2D fallback panel (`Graph2DModeFallback.tsx`) share
// exactly these builder functions -- guaranteeing they always agree on
// grouping (and, downstream, on which generative-ramp color/glyph each
// group gets), rather than risking two independently written groupings
// drifting apart. None of this touches the 3D rendering pipeline, the
// worker, or node positions -- it operates purely on `VizNode[]`, the same
// data `GraphA11yTree` already consumed pre-Phase-4c.
import type { VizNode } from "./types";
import { elevationTier, TERRAIN_TIER_COUNT } from "./three/terrainElevation";

export interface CommunityGroup {
  community: number;
  nodes: VizNode[];
}

/** Orbital mode (Section 9.3 journey 4: "Orbital is a tree grouped by community"). Sorted ascending by community id for a stable, deterministic render order. */
export function groupByCommunity(nodes: VizNode[]): CommunityGroup[] {
  const byId = new Map<number, VizNode[]>();
  for (const node of nodes) {
    const list = byId.get(node.community);
    if (list) list.push(node);
    else byId.set(node.community, [node]);
  }
  return Array.from(byId.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([community, groupNodes]) => ({ community, nodes: groupNodes }));
}

export interface StrataCommunityGroup extends CommunityGroup {
  /** This group's ancestor community id at every coarser level, straight from `VizNode.parentCommunity` (Phase 4b's enriched field) -- absent when no member node carries one. */
  parentCommunity?: Record<number, number>;
}

export interface StrataLevelGroup {
  /** Hierarchy depth, 0 = coarsest (matches the server contract's convention -- plan Section 7). */
  level: number;
  communities: StrataCommunityGroup[];
}

/**
 * Strata mode (Section 9.3 journey 4: "Strata is a Leiden-hierarchy tree
 * with level and ancestor information"). Groups by `level` first (ascending,
 * 0 = coarsest), then by `community` within each level; every community
 * group carries its `parentCommunity` chain (a node's own real Leiden
 * ancestor mapping, Phase 4b) if any member node has one, so the tree can
 * show "this level-2 community's level-0/level-1 ancestors" without
 * re-deriving anything.
 */
export function groupByStrataHierarchy(nodes: VizNode[]): StrataLevelGroup[] {
  const byLevel = new Map<number, Map<number, VizNode[]>>();
  for (const node of nodes) {
    const level = node.level ?? 0;
    let byCommunity = byLevel.get(level);
    if (!byCommunity) {
      byCommunity = new Map();
      byLevel.set(level, byCommunity);
    }
    const list = byCommunity.get(node.community);
    if (list) list.push(node);
    else byCommunity.set(node.community, [node]);
  }
  return Array.from(byLevel.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([level, byCommunity]) => ({
      level,
      communities: Array.from(byCommunity.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([community, groupNodes]) => ({
          community,
          nodes: groupNodes,
          parentCommunity: groupNodes.find((n) => n.parentCommunity)?.parentCommunity,
        })),
    }));
}

export interface TerrainRegion {
  /** 0..TERRAIN_TIER_COUNT-1, 0 = lowest ("Basin"). */
  tier: number;
  /** This region's mean elevation (0..1) -- a real, non-fabricated aggregate of its member nodes' own elevation signal. */
  elevation01: number;
  nodes: VizNode[];
}

/**
 * Terrain mode (Section 9.3 journey 4: "Terrain is a region list with tier
 * and numeric elevation"). LABELED SIMPLIFICATION: the 3D heightfield
 * (`terrainElevation.ts`) aggregates centrality spatially, over each node's
 * worker-computed XZ position -- position data that does not exist in this
 * accessibility/2D-fallback path (no worker runs here). This function uses
 * each node's own `centrality` directly as its standalone elevation signal
 * (falling back to 0.1, matching the SAME default the worker/Graph3DScene
 * terrain path already uses for a missing value -- see
 * `forceLayout.worker.ts`/`Graph3DScene.tsx`'s `node.centrality ?? 0.1`),
 * tiered via the exact same `elevationTier` helper the 3D surface uses. This
 * is a real, data-grounded region grouping, not a re-derivation of the
 * spatial heightfield -- it will not pixel-match the 3D surface's contour
 * lines, but it groups nodes by the same underlying signal at the same tier
 * resolution.
 */
export function groupByTerrainRegion(nodes: VizNode[]): TerrainRegion[] {
  const byTier = new Map<number, VizNode[]>();
  for (const node of nodes) {
    const elevation01 = node.centrality ?? 0.1;
    const tier = elevationTier(elevation01);
    const list = byTier.get(tier);
    if (list) list.push(node);
    else byTier.set(tier, [node]);
  }
  return Array.from(byTier.entries())
    .sort((a, b) => b[0] - a[0]) // highest ("peak") first
    .map(([tier, groupNodes]) => {
      const sum = groupNodes.reduce((total, n) => total + (n.centrality ?? 0.1), 0);
      return { tier, elevation01: sum / groupNodes.length, nodes: groupNodes };
    });
}

/** Lowest tier first (index == tier), paired with `terrainElevation.ts`'s TERRAIN_TIER_COUNT = 5 bands. */
export const TERRAIN_TIER_LABELS: readonly string[] = ["Basin", "Lowland", "Midland", "Highland", "Peak"];

if (TERRAIN_TIER_LABELS.length !== TERRAIN_TIER_COUNT) {
  // Defensive, dev-time-only signal if `terrainElevation.ts`'s tier count
  // ever changes without updating these labels -- never thrown in
  // production rendering paths, just a loud console warning.
  // eslint-disable-next-line no-console
  console.warn(
    `graphModeViews: TERRAIN_TIER_LABELS has ${TERRAIN_TIER_LABELS.length} entries but TERRAIN_TIER_COUNT is ${TERRAIN_TIER_COUNT}`,
  );
}
