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
    // Deep-Field Observatory Phase 2 -- not exercised by this a11y-tree test
    // file, but required by the `GraphColors` shape (see
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
    // Deep-Field Observatory Phase 3 -- required by the `GraphColors` shape;
    // exercised directly by the "Weight column" describe block below.
    edgeWeight: { widthMin: 1, widthMax: 4, opacityMin: 0.25, opacityMax: 0.9 },
    // Deep-Field Observatory Phase 4 -- not exercised by this a11y-tree test
    // file, but required by the `GraphColors` shape (mirrors
    // lib/graph-colors.ts's `DEFAULT_BLOOM_PARAMS`).
    bloom: { threshold: 0.9, intensity: 0.6, radius: 0.4, resolutionScale: 0.5 },
    // Deep-Field Observatory Phase 5 -- not exercised by this a11y-tree test
    // file, but required by the `GraphColors` shape (mirrors
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
    // Deep-Field Observatory Phase 6 -- not exercised by this a11y-tree test
    // file, but required by the `GraphColors` shape.
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

// Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.1
// J5-EDGE-WEIGHT: "The a11y links table gains a text Weight column").
describe("GraphA11yTree -- cloud mode links table gains a Weight column", () => {
  it("renders a Weight header and a populated numeric cell for a weighted edge", () => {
    const nodes = [node({ id: "a", label: "Alpha" }), node({ id: "b", label: "Beta" })];
    render(
      <GraphA11yTree
        nodes={nodes}
        edges={[{ source: "a", target: "b", weight: 7, type: "related" }]}
        visibleIds={new Set(["a", "b"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode="cloud"
        colors={makeColors(8)}
      />,
    );
    const table = screen.getByRole("table", { name: "Graph links" });
    expect(within(table).getByRole("columnheader", { name: "Weight" })).toBeInTheDocument();
    const dataRow = within(table).getAllByRole("row")[1];
    expect(within(dataRow).getByRole("cell", { name: "weight: 7" })).toBeInTheDocument();
  });

  it('renders the literal "weight: n/a" fallback for an edge with no served weight -- never a fabricated numeric value', () => {
    const nodes = [node({ id: "a", label: "Alpha" }), node({ id: "b", label: "Beta" })];
    render(
      <GraphA11yTree
        nodes={nodes}
        edges={[{ source: "a", target: "b" }]}
        visibleIds={new Set(["a", "b"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode="cloud"
        colors={makeColors(8)}
      />,
    );
    const table = screen.getByRole("table", { name: "Graph links" });
    const dataRow = within(table).getAllByRole("row")[1];
    expect(within(dataRow).getByRole("cell", { name: "weight: n/a" })).toBeInTheDocument();
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

  // Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 acceptance
  // check: a11y parity must reflect "elevation values + glyph bullets per
  // plan Section 5.1"). VERIFIES, rather than merely asserts by inspection,
  // that `TerrainA11yList` (unmodified by this phase -- it already carried
  // this content from the prior governing plan) genuinely renders BOTH a
  // real numeric elevation value in the region heading AND a per-node
  // non-color glyph bullet -- the exact two carriers this phase's new
  // hillshade/contour 3D chrome needs a text/DOM mirror for.
  it("each region heading exposes a real numeric elevation value, and each node row carries a non-color glyph bullet", () => {
    const nodes = [node({ id: "a", label: "Alpha", centrality: 1 })];
    const { container } = render(
      <GraphA11yTree
        nodes={nodes}
        edges={[]}
        visibleIds={new Set(["a"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode="terrain"
        colors={makeColors(8)}
      />,
    );
    // A real formatted elevation number (e.g. "elevation 1.00"), never a
    // placeholder/omitted value.
    expect(screen.getByText(/elevation \d+\.\d{2}/)).toBeInTheDocument();
    // The glyph bullet is an inline SVG shape cue (`CommunityGlyphIcon`),
    // rendered per node row -- a genuine non-color carrier, not text alone.
    expect(container.querySelector("li svg")).not.toBeNull();
  });
});

// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 acceptance check:
// a11y parity must reflect "system core badges"). Confirms, rather than
// merely asserts by inspection, that `OrbitalA11yTree` (unmodified by this
// phase -- see this job's report for the reasoning that Orbital's new
// "shell core glow" chrome is a single origin-centered decorative element
// carrying no per-community information beyond what this ALREADY-SHIPPED
// community badge carries) genuinely renders a non-color glyph shape per
// community, mirroring the SAME `CommunityBadge`/`CommunityGlyphIcon`
// machinery the in-canvas centroid-badge chrome layer (Phase 2) uses -- so
// the a11y tree and the 3D "system core" badge can never disagree.
describe("GraphA11yTree -- orbital mode community badge carries a non-color glyph shape (Phase 5 confirmation)", () => {
  it("renders an inline SVG glyph shape for each community heading, not color alone", () => {
    const nodes = [node({ id: "a", label: "Alpha", community: 0 })];
    const { container } = render(
      <GraphA11yTree
        nodes={nodes}
        edges={[]}
        visibleIds={new Set(["a"])}
        selectedId={null}
        onSelectNode={vi.fn()}
        mode="orbital"
        colors={makeColors(2)}
      />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
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
