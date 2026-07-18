import { describe, expect, it } from "vitest";
import { groupByCommunity, groupByStrataHierarchy, groupByTerrainRegion, TERRAIN_TIER_LABELS } from "../graphModeViews";
import type { VizNode } from "../types";
import { TERRAIN_TIER_COUNT } from "../three/terrainElevation";

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
  } as VizNode;
}

describe("groupByCommunity (Orbital mode accessibility tree, plan Section 6.5 item 6)", () => {
  it("groups nodes by their community id, sorted ascending", () => {
    const nodes = [
      node({ id: "a", community: 2 }),
      node({ id: "b", community: 0 }),
      node({ id: "c", community: 2 }),
      node({ id: "d", community: 1 }),
    ];
    const groups = groupByCommunity(nodes);
    expect(groups.map((g) => g.community)).toEqual([0, 1, 2]);
    expect(groups.find((g) => g.community === 2)?.nodes.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array for an empty node list", () => {
    expect(groupByCommunity([])).toEqual([]);
  });
});

describe("groupByStrataHierarchy (Strata mode accessibility tree, plan Section 6.5 item 6)", () => {
  it("groups nodes by level (ascending, 0 = coarsest), then by community within each level", () => {
    const nodes = [
      node({ id: "a", level: 1, community: 5, parentCommunity: { 0: 2 } }),
      node({ id: "b", level: 0, community: 2 }),
      node({ id: "c", level: 1, community: 5, parentCommunity: { 0: 2 } }),
    ];
    const levels = groupByStrataHierarchy(nodes);
    expect(levels.map((l) => l.level)).toEqual([0, 1]);

    const level1 = levels.find((l) => l.level === 1)!;
    expect(level1.communities).toHaveLength(1);
    expect(level1.communities[0].community).toBe(5);
    expect(level1.communities[0].nodes.map((n) => n.id)).toEqual(["a", "c"]);
    // Ancestor info (Section 6.5 item 6: "level + ancestor info, using the
    // parentCommunity field") is carried through onto the group.
    expect(level1.communities[0].parentCommunity).toEqual({ 0: 2 });
  });

  it("defaults a node with no `level` to level 0 (the coarsest/default level)", () => {
    const levels = groupByStrataHierarchy([node({ id: "a", community: 3 })]);
    expect(levels).toHaveLength(1);
    expect(levels[0].level).toBe(0);
  });

  it("returns an empty array for an empty node list", () => {
    expect(groupByStrataHierarchy([])).toEqual([]);
  });
});

describe("groupByTerrainRegion (Terrain mode accessibility tree, plan Section 6.5 item 6)", () => {
  it("buckets nodes into tiers by centrality, highest tier first, with a real numeric elevation value per region", () => {
    const nodes = [
      node({ id: "peak", centrality: 1 }),
      node({ id: "valley", centrality: 0 }),
      node({ id: "mid", centrality: 0.5 }),
    ];
    const regions = groupByTerrainRegion(nodes);
    // Highest-elevation region listed first.
    expect(regions[0].tier).toBeGreaterThanOrEqual(regions[regions.length - 1].tier);
    for (const region of regions) {
      expect(region.tier).toBeGreaterThanOrEqual(0);
      expect(region.tier).toBeLessThan(TERRAIN_TIER_COUNT);
      expect(region.elevation01).toBeGreaterThanOrEqual(0);
      expect(region.elevation01).toBeLessThanOrEqual(1);
      expect(region.nodes.length).toBeGreaterThan(0);
    }
  });

  it("defaults a node with no `centrality` to a small non-zero weight (matches the codebase's `?? 0.1` convention), not zero", () => {
    const regions = groupByTerrainRegion([node({ id: "a" })]);
    expect(regions).toHaveLength(1);
    expect(regions[0].elevation01).toBeCloseTo(0.1, 5);
  });

  it("returns an empty array for an empty node list", () => {
    expect(groupByTerrainRegion([])).toEqual([]);
  });

  it("TERRAIN_TIER_LABELS has exactly TERRAIN_TIER_COUNT entries, lowest tier first", () => {
    expect(TERRAIN_TIER_LABELS).toHaveLength(TERRAIN_TIER_COUNT);
  });
});
