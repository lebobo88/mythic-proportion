import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Color as ThreeColor } from "three";
import { Graph2DModeFallback } from "../Graph2DModeFallback";
import type { GraphColors } from "../../../lib/graph-colors";
import type { VizEdge, VizNode } from "../types";

function makeColors(count: number): GraphColors {
  const swatch = { color: new ThreeColor(0.5, 0.4, 0.3), alpha: 1 };
  const community = Array.from({ length: count }, () => swatch);
  return {
    node: { source: swatch, entity: swatch, concept: swatch, session: swatch },
    edge: swatch,
    edgeActive: swatch,
    community,
    communityAt: () => swatch,
    hullFill: swatch,
    glow: swatch,
    // Deep-Field Observatory Phase 2 -- not exercised by this 2D-fallback
    // test file, but required by the `GraphColors` shape (see
    // lib/graph-colors.ts's `readNodeMaterialParams`/`readPatternParams`/
    // `readLabelTierParams` for the real, token-driven defaults these mirror).
    nodeMaterial: {
      fresnelPower: 2.5,
      fresnelIntensity: 0.6,
      emissiveIdle: 0,
      emissiveHover: 0.6,
      emissiveSelected: 1,
      outlineColor: swatch,
      outlineWidth: 2,
    },
    pattern: { luminanceDelta: 0.18, scale: 3 },
    labelTier: { communitySize: 15, nodeSize: 12, nodeMinSize: 10, cap: 40, communityMax: 12, outlineWidth: 0.12 },
    // Deep-Field Observatory Phase 3 -- not exercised by this 2D-fallback
    // test file, but required by the `GraphColors` shape.
    edgeWeight: { widthMin: 1, widthMax: 4, opacityMin: 0.25, opacityMax: 0.9 },
    // Deep-Field Observatory Phase 4 -- not exercised by this 2D-fallback
    // test file, but required by the `GraphColors` shape (mirrors
    // lib/graph-colors.ts's `DEFAULT_BLOOM_PARAMS`).
    bloom: { threshold: 0.9, intensity: 0.6, radius: 0.4, resolutionScale: 0.5 },
    // Deep-Field Observatory Phase 5 -- not exercised by this 2D-fallback
    // test file, but required by the `GraphColors` shape (mirrors
    // lib/graph-colors.ts's per-mode chrome/atmosphere-fog defaults).
    atmosphereFog: { color: swatch, density: 0.03 },
    cloudChrome: { nebulaColor: swatch, nebulaOpacity: 0.12 },
    orbitalChrome: {
      discColor: swatch,
      discOpacity: 0.18,
      ringColor: swatch,
      ringWidth: 1.5,
      coreGlowColor: swatch,
      coreGlowIntensity: 0.8,
      ringInclinationDeg: 6,
    },
    strataChrome: { floorColor: swatch, floorOpacity: 0.14, floorFogDensity: 0.03, bandRimColor: swatch, axisColor: swatch },
    terrainChrome: {
      skyTop: swatch,
      skyHorizon: swatch,
      hillshadeStrength: 0.8,
      contourMajorColor: swatch,
      contourMinorColor: swatch,
      contourMajorWidth: 1.5,
      contourMinorWidth: 0.75,
    },
    // Deep-Field Observatory Phase 6 -- not exercised by this 2D-fallback
    // test file, but required by the `GraphColors` shape.
    environment: { intensity: 1 },
  };
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
  } as VizNode;
}

describe("Graph2DModeFallback (visible 2D fallback for Orbital/Strata/Terrain, plan Section 6.5 item 6)", () => {
  it("renders nested clusters for orbital mode", () => {
    const nodes = [node({ id: "a", label: "Alpha", community: 0 })];
    render(
      <Graph2DModeFallback
        mode="orbital"
        nodes={nodes}
        colors={makeColors(1)}
        selectedId={null}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/Community 0/)).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("renders a dendrogram-style hierarchy plus a links table for strata mode", () => {
    const nodes = [node({ id: "a", label: "Alpha", level: 0, community: 1 })];
    render(
      <Graph2DModeFallback
        mode="strata"
        nodes={nodes}
        edges={[]}
        colors={makeColors(1)}
        selectedId={null}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/Level 0/)).toBeInTheDocument();
  });

  describe("strata mode's links table (Section 9.3 journey 3: 'a dendrogram plus a links table')", () => {
    const nodes = [
      node({ id: "a", label: "Alpha", level: 0, community: 1 }),
      node({ id: "b", label: "Beta", level: 0, community: 1 }),
      node({ id: "c", label: "Gamma", level: 0, community: 1 }),
    ];

    function rowTexts(table: HTMLElement): string[][] {
      return within(table)
        .getAllByRole("row")
        .slice(1) // skip the header row
        .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent ?? ""));
    }

    it("populates real source/target rows from the edges prop, not an empty shell", () => {
      const edges: VizEdge[] = [{ source: "a", target: "b" }];
      render(
        <Graph2DModeFallback
          mode="strata"
          nodes={nodes}
          edges={edges}
          colors={makeColors(1)}
          selectedId={null}
          onSelectNode={vi.fn()}
        />,
      );
      const table = screen.getByRole("table", { name: "Graph links" });
      expect(rowTexts(table)).toEqual([["Alpha", "Beta"]]);
    });

    it("filters out an edge whose endpoint isn't in the currently rendered node set", () => {
      const edges: VizEdge[] = [
        { source: "a", target: "b" },
        { source: "a", target: "not-rendered" },
      ];
      render(
        <Graph2DModeFallback
          mode="strata"
          nodes={nodes}
          edges={edges}
          colors={makeColors(1)}
          selectedId={null}
          onSelectNode={vi.fn()}
        />,
      );
      const table = screen.getByRole("table", { name: "Graph links" });
      expect(rowTexts(table)).toEqual([["Alpha", "Beta"]]);
    });

    it("renders multiple rows for multiple edges, one row per edge", () => {
      const edges: VizEdge[] = [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ];
      render(
        <Graph2DModeFallback
          mode="strata"
          nodes={nodes}
          edges={edges}
          colors={makeColors(1)}
          selectedId={null}
          onSelectNode={vi.fn()}
        />,
      );
      const table = screen.getByRole("table", { name: "Graph links" });
      expect(rowTexts(table)).toEqual([
        ["Alpha", "Beta"],
        ["Beta", "Gamma"],
      ]);
    });
  });

  it("renders a region/contour map with numeric elevation for terrain mode", () => {
    const nodes = [node({ id: "a", label: "Alpha", centrality: 0.9 })];
    render(
      <Graph2DModeFallback
        mode="terrain"
        nodes={nodes}
        colors={makeColors(1)}
        selectedId={null}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/elevation/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/0\.90/)).toBeInTheDocument();
  });

  it("clicking a node calls onSelectNode -- state stays owned by GraphView", async () => {
    const nodes = [node({ id: "a", label: "Alpha", community: 0 })];
    const onSelectNode = vi.fn();
    const user = userEvent.setup();
    render(
      <Graph2DModeFallback
        mode="orbital"
        nodes={nodes}
        colors={makeColors(1)}
        selectedId={null}
        onSelectNode={onSelectNode}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onSelectNode).toHaveBeenCalledWith("a");
  });
});
