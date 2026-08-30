// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.2
// "Typography" / Section 6 Phase 2: "the two-tier label system: community
// titles win the ~40 cap; node labels carry the screen-space minimum
// size"). Pure decision functions, directly testable without a real R3F/
// troika render (same convention as `instancedNodesLod.test.ts`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeNodeLabelFontSize,
  computeScreenSpaceWorldSize,
  selectLabelTiers,
} from "../three/NodeLabels";
import type { CommunityCentroid } from "../three/CommunityCentroidBadges";
import type { LabelTierParams } from "../../../lib/graph-colors";
import type { VizNode } from "../types";

const THREE_DIR = join(__dirname, "..", "three");
function readSource(fileName: string): string {
  return readFileSync(join(THREE_DIR, fileName), "utf-8");
}

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

function centroid(community: number, count: number): CommunityCentroid {
  return { community, position: [community, 0, 0], count };
}

const LABEL_TIER: LabelTierParams = {
  communitySize: 15,
  nodeSize: 12,
  nodeMinSize: 10,
  cap: 40,
  communityMax: 12,
  outlineWidth: 0.12,
};

describe("selectLabelTiers (community titles win the shared cap, Section 5.2/5.6 item 8)", () => {
  it("includes every community as a title when the community count is within communityMax", () => {
    const centroids = [centroid(0, 10), centroid(1, 5)];
    const nodes = [node({ id: "a", community: 0 }), node({ id: "b", community: 1 })];
    const { communityTitles, nodeLabels } = selectLabelTiers(nodes, centroids, null, null, LABEL_TIER);
    expect(communityTitles).toHaveLength(2);
    expect(nodeLabels.length).toBeLessThanOrEqual(LABEL_TIER.cap - 2);
  });

  it("caps community titles at communityMax even when more communities exist, keeping the largest first (labeled judgment call, deterministic and reused from the centroid badge ranking)", () => {
    const centroids = Array.from({ length: 20 }, (_, i) => centroid(i, 20 - i)); // community 0 is largest
    const nodes: VizNode[] = [];
    const { communityTitles } = selectLabelTiers(nodes, centroids, null, null, LABEL_TIER);
    expect(communityTitles).toHaveLength(LABEL_TIER.communityMax);
    expect(communityTitles[0].community).toBe(0); // largest community's title survives the cap
  });

  it("titles win the shared ~40 cap: node-label budget is exactly cap - titlesShown, never negative", () => {
    // communityMax(12) titles + would-be node labels for 100 nodes -- budget must clamp to cap-12=28, never negative or unbounded.
    const centroids = Array.from({ length: 12 }, (_, i) => centroid(i, 12 - i));
    const nodes = Array.from({ length: 100 }, (_, i) => node({ id: `n${i}`, community: i % 12, degree: i }));
    const { communityTitles, nodeLabels } = selectLabelTiers(nodes, centroids, null, null, LABEL_TIER);
    expect(communityTitles).toHaveLength(12);
    expect(nodeLabels.length).toBeLessThanOrEqual(LABEL_TIER.cap - 12);
    expect(nodeLabels.length).toBeGreaterThan(0);
  });

  it("even at an extreme community count (titles alone would exceed cap), node-label budget never goes negative (zero, not a crash)", () => {
    const tinyCap: LabelTierParams = { ...LABEL_TIER, cap: 5, communityMax: 12 };
    const centroids = Array.from({ length: 12 }, (_, i) => centroid(i, 12 - i));
    const nodes = [node({ id: "a", community: 0 })];
    const { communityTitles, nodeLabels } = selectLabelTiers(nodes, centroids, null, null, tinyCap);
    expect(communityTitles).toHaveLength(12); // titles still win, per spec ("titles win the shared cap")
    expect(nodeLabels).toHaveLength(0);
  });

  it("hovered and selected nodes are always included in the node-label tier (never dropped for budget)", () => {
    const centroids = Array.from({ length: 12 }, (_, i) => centroid(i, 1));
    const nodes = Array.from({ length: 50 }, (_, i) => node({ id: `n${i}`, community: 0, degree: 0 }));
    const { nodeLabels } = selectLabelTiers(nodes, centroids, "n40", "n41", LABEL_TIER);
    expect(nodeLabels.some((n) => n.id === "n40")).toBe(true);
    expect(nodeLabels.some((n) => n.id === "n41")).toBe(true);
  });
});

describe("computeScreenSpaceWorldSize / computeNodeLabelFontSize (screen-space minimum, Section 5.2)", () => {
  it("world size grows proportionally with camera distance for a fixed pixel target (perspective compensation)", () => {
    const near = computeScreenSpaceWorldSize(100, 50, 900, 10);
    const far = computeScreenSpaceWorldSize(400, 50, 900, 10);
    expect(far).toBeCloseTo(near * 4, 5);
  });

  it("computeNodeLabelFontSize never drops below the base world size at close range", () => {
    const base = 1.2;
    const size = computeNodeLabelFontSize(base, 10, 50, 900, 10);
    expect(size).toBeGreaterThanOrEqual(base);
  });

  it("computeNodeLabelFontSize grows past the base size at long range, enforcing the screen-space minimum", () => {
    const base = 1.2;
    const close = computeNodeLabelFontSize(base, 50, 50, 900, 10);
    const far = computeNodeLabelFontSize(base, 5000, 50, 900, 10);
    expect(far).toBeGreaterThan(close);
  });

  it("degenerate zero-height viewport never divides by zero / returns NaN", () => {
    expect(Number.isFinite(computeScreenSpaceWorldSize(100, 50, 0, 10))).toBe(true);
  });
});

describe("NodeLabels wiring (structural, same convention as instancedNodesLod.test.ts)", () => {
  const source = readSource("NodeLabels.tsx");

  it("computes community-title centroids via the shared computeCommunityCentroids helper (single source with the badge layer, never a second aggregation)", () => {
    expect(source).toMatch(/computeCommunityCentroids\(/);
  });

  it("applies the screen-space minimum to node-tier labels via computeNodeLabelFontSize", () => {
    expect(source).toMatch(/computeNodeLabelFontSize\(/);
  });

  it("renders a chip background behind community titles (Section 5.2: 'on a chip')", () => {
    expect(source).toMatch(/graph-label-chip|chipMesh|ChipMesh|Chip/);
  });
});
