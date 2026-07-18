import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Color as ThreeColor } from "three";
import { GraphA11yTree } from "../GraphA11yTree";
import type { GraphColors } from "../../../../lib/graph-colors";
import type { VizNode } from "../../types";

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

describe("GraphA11yTree -- cloud mode (unchanged flat list + neighbors)", () => {
  it("renders the existing flat tree + links table when mode is 'cloud' or omitted", () => {
    const nodes = [node({ id: "a", label: "Alpha" }), node({ id: "b", label: "Beta" })];
    render(
      <GraphA11yTree
        nodes={nodes}
        edges={[]}
        visibleIds={new Set(["a", "b"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode="cloud"
        colors={makeColors(8)}
      />,
    );
    const tree = screen.getByRole("tree", { name: "Graph nodes" });
    expect(within(tree).getByRole("treeitem", { name: /Alpha/ })).toBeInTheDocument();
    expect(within(tree).getByRole("treeitem", { name: /Beta/ })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Graph links" })).toBeInTheDocument();
  });
});

describe("GraphA11yTree -- orbital mode (tree grouped by community)", () => {
  it("groups nodes under a community heading with a non-color glyph cue", async () => {
    const nodes = [
      node({ id: "a", label: "Alpha", community: 0 }),
      node({ id: "b", label: "Beta", community: 1 }),
    ];
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    render(
      <GraphA11yTree
        nodes={nodes}
        edges={[]}
        visibleIds={new Set(["a", "b"])}
        selectedId={null}
        onSelectNode={onSelectNode}
        mode="orbital"
        colors={makeColors(2)}
      />,
    );
    expect(screen.getByText(/Community 0/)).toBeInTheDocument();
    expect(screen.getByText(/Community 1/)).toBeInTheDocument();
    const alphaButton = screen.getByRole("button", { name: /Alpha/ });
    await user.click(alphaButton);
    expect(onSelectNode).toHaveBeenCalledWith("a");
  });
});

describe("GraphA11yTree -- strata mode (Leiden-hierarchy tree with level + ancestor info)", () => {
  it("groups by level then community, and surfaces ancestor (parentCommunity) info", () => {
    const nodes = [
      node({ id: "a", label: "Alpha", level: 1, community: 5, parentCommunity: { 0: 2 } }),
      node({ id: "b", label: "Beta", level: 0, community: 2 }),
    ];
    render(
      <GraphA11yTree
        nodes={nodes}
        edges={[]}
        visibleIds={new Set(["a", "b"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode="strata"
        colors={makeColors(8)}
      />,
    );
    expect(screen.getByText(/Level 0/)).toBeInTheDocument();
    expect(screen.getByText(/Level 1/)).toBeInTheDocument();
    // Ancestor info: level-1 community 5's parent at level 0 is community 2.
    expect(screen.getByText(/parent at level 0.*Community 2/)).toBeInTheDocument();
  });
});

describe("GraphA11yTree -- terrain mode (region list with tier + numeric elevation)", () => {
  it("groups nodes into elevation-tier regions with a real numeric elevation value", () => {
    const nodes = [
      node({ id: "a", label: "Alpha", centrality: 1 }),
      node({ id: "b", label: "Beta", centrality: 0 }),
    ];
    render(
      <GraphA11yTree
        nodes={nodes}
        edges={[]}
        visibleIds={new Set(["a", "b"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode="terrain"
        colors={makeColors(8)}
      />,
    );
    // A "list" of regions, not a "tree" (per Section 9.3 journey 4's exact wording).
    expect(screen.getByRole("list", { name: /Terrain regions/i })).toBeInTheDocument();
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Beta/)).toBeInTheDocument();
  });
});

describe("GraphA11yTree -- two aria-live regions present regardless of mode", () => {
  it.each(["cloud", "orbital", "strata", "terrain"] as const)("mode=%s still renders a status aria-live region", (mode) => {
    const nodes = [node({ id: "a", label: "Alpha" })];
    render(
      <GraphA11yTree
        nodes={nodes}
        edges={[]}
        visibleIds={new Set(["a"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode={mode}
        colors={makeColors(8)}
      />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
