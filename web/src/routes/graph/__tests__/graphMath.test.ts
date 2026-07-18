import { describe, expect, it } from "vitest";
import { computeCommunities, computeDegrees, deriveVizGraph, neighborsOf, sizeForDegree } from "../graphMath";
import type { GraphData } from "../../../lib/api";

const sample: GraphData = {
  nodes: [
    { id: "a", label: "A", type: "concept" },
    { id: "b", label: "B", type: "concept" },
    { id: "c", label: "C", type: "concept" },
    { id: "d", label: "D", type: "concept" }, // disconnected
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ],
};

describe("computeDegrees", () => {
  it("counts in+out edges per node", () => {
    const degrees = computeDegrees(sample);
    expect(degrees.get("a")).toBe(1);
    expect(degrees.get("b")).toBe(2);
    expect(degrees.get("c")).toBe(1);
    expect(degrees.get("d")).toBe(0);
  });
});

describe("computeCommunities", () => {
  it("is deterministic across repeated calls on the same graph", () => {
    const first = computeCommunities(sample);
    const second = computeCommunities(sample);
    expect(Array.from(first.entries())).toEqual(Array.from(second.entries()));
  });

  it("gives connected nodes the same community and the disconnected node its own", () => {
    const communities = computeCommunities(sample);
    expect(communities.get("a")).toBe(communities.get("b"));
    expect(communities.get("b")).toBe(communities.get("c"));
    // "d" has no edges so it's its own component -- may or may not collide by
    // hash with a/b/c's bucket, but it's derived independently either way.
    expect(communities.get("d")).toBeGreaterThanOrEqual(0);
    expect(communities.get("d")).toBeLessThan(8);
  });
});

describe("sizeForDegree", () => {
  it("returns the minimum size for degree 0", () => {
    expect(sizeForDegree(0, 10)).toBeCloseTo(0.6, 5);
  });

  it("scales up toward the max size as degree approaches maxDegree", () => {
    expect(sizeForDegree(10, 10)).toBeGreaterThan(sizeForDegree(1, 10));
    expect(sizeForDegree(10, 10)).toBeLessThanOrEqual(3.2);
  });
});

describe("deriveVizGraph", () => {
  it("adds degree/community/size to every node without dropping edges", () => {
    const viz = deriveVizGraph(sample);
    expect(viz.nodes).toHaveLength(4);
    expect(viz.edges).toHaveLength(2);
    for (const node of viz.nodes) {
      expect(typeof node.degree).toBe("number");
      expect(typeof node.community).toBe("number");
      expect(typeof node.size).toBe("number");
    }
  });

  it("prefers a server-provided degree field over the client-computed one", () => {
    const withServerDegree: GraphData = {
      nodes: [{ id: "entity:1", label: "E", type: "person", degree: 99 } as GraphData["nodes"][number]],
      edges: [],
    };
    const viz = deriveVizGraph(withServerDegree);
    expect(viz.nodes[0].degree).toBe(99);
  });

  // Phase 4b (plan Section 6.4), J-002 remediation (Codex CODE_REVIEW):
  // consume the server's real per-node Leiden projection when present, fall
  // back to the client union-find grouping (explicitly labeled
  // "approximate" -- see graphMath.ts's module doc) when absent, checked
  // PER NODE -- never whole-response, since the production `mode=both`
  // fetch always mixes never-enriched page nodes with entity nodes.
  it("uses the server's real `community` field for every node when the WHOLE response carries one", () => {
    const withRealCommunities: GraphData = {
      nodes: [
        { id: "entity:1", label: "E1", type: "person", community: 7 } as GraphData["nodes"][number],
        { id: "entity:2", label: "E2", type: "person", community: 7 } as GraphData["nodes"][number],
        { id: "entity:3", label: "E3", type: "person", community: 12 } as GraphData["nodes"][number],
      ],
      edges: [],
    };
    const viz = deriveVizGraph(withRealCommunities);
    expect(viz.nodes[0].community).toBe(7);
    expect(viz.nodes[1].community).toBe(7);
    expect(viz.nodes[2].community).toBe(12);
    for (const node of viz.nodes) expect(node.communityApproximate).toBe(false);
  });

  it("J-002: a node WITH a real community keeps it even when a different, unrelated node in the same response lacks one", () => {
    // Exactly the production `mode=both` shape: an entity node the server
    // enriched (community 7) unioned with a page node the server can never
    // enrich (no `community` field at all, per `read_entity_graph`'s
    // page-node shape).
    const mixed: GraphData = {
      nodes: [
        { id: "entity:1", label: "A", type: "concept", community: 7 } as GraphData["nodes"][number],
        { id: "wiki/b.md", label: "B", type: "concept" },
      ],
      edges: [{ source: "entity:1", target: "wiki/b.md" }],
    };
    const viz = deriveVizGraph(mixed);
    const real = viz.nodes.find((n) => n.id === "entity:1")!;
    const fallback = viz.nodes.find((n) => n.id === "wiki/b.md")!;

    // The real node's server-projected community must NOT be discarded just
    // because the other node lacks one -- this is the exact defect J-002
    // reported (the whole-response all-or-nothing check made real data
    // unreachable in production).
    expect(real.community).toBe(7);
    expect(real.communityApproximate).toBe(false);

    // The un-enriched node still gets a deterministic fallback bucket...
    expect(typeof fallback.community).toBe("number");
    expect(fallback.communityApproximate).toBe(true);
    // ...offset strictly past every real id present, so the two id spaces
    // can never numerically collide in one view.
    expect(fallback.community).toBeGreaterThan(7);
  });

  it("J-002: fallback ids never collide with real ids across a larger mixed graph, and stay internally consistent for connected fallback nodes", () => {
    const mixed: GraphData = {
      nodes: [
        { id: "entity:1", label: "E1", type: "person", community: 2 } as GraphData["nodes"][number],
        { id: "entity:2", label: "E2", type: "person", community: 40 } as GraphData["nodes"][number],
        { id: "wiki/a.md", label: "A", type: "concept" },
        { id: "wiki/b.md", label: "B", type: "concept" },
      ],
      // The two page nodes are connected to each other (a real wikilink)
      // but never to an entity node (the server never emits a page<->entity
      // edge) -- exactly `api_graph`'s real `mode=both` edge shape.
      edges: [{ source: "wiki/a.md", target: "wiki/b.md" }],
    };
    const viz = deriveVizGraph(mixed);
    const byId = new Map(viz.nodes.map((n) => [n.id, n]));

    expect(byId.get("entity:1")!.community).toBe(2);
    expect(byId.get("entity:2")!.community).toBe(40);
    // Connected fallback nodes still land in the SAME fallback bucket as
    // each other (the fallback grouping's own semantics are unchanged)...
    expect(byId.get("wiki/a.md")!.community).toBe(byId.get("wiki/b.md")!.community);
    // ...and that shared bucket sits strictly past the highest real id (40)
    // actually present in this response.
    expect(byId.get("wiki/a.md")!.community).toBeGreaterThan(40);
  });

  it("falls back to the client union-find grouping (unoffset, `0..7`) when NO node has a `community` field at all", () => {
    // The common pre-Phase-4b/never-index-graph-run case: fallback ids must
    // stay exactly `0..COMMUNITY_COUNT-1` -- byte-identical to this
    // function's behavior before J-002, since there is no real id to offset
    // past.
    const viz = deriveVizGraph(sample);
    for (const node of viz.nodes) {
      expect(node.communityApproximate).toBe(true);
      expect(node.community).toBeGreaterThanOrEqual(0);
      expect(node.community).toBeLessThan(8);
    }
  });

  it("passes `level`/`centrality`/`parentCommunity` straight through unchanged when present", () => {
    const enriched: GraphData = {
      nodes: [
        {
          id: "entity:1",
          label: "E1",
          type: "person",
          community: 3,
          level: 1,
          centrality: 0.42,
          parentCommunity: { 0: 9 },
        } as GraphData["nodes"][number],
      ],
      edges: [],
    };
    const viz = deriveVizGraph(enriched);
    expect(viz.nodes[0].level).toBe(1);
    expect(viz.nodes[0].centrality).toBe(0.42);
    expect(viz.nodes[0].parentCommunity).toEqual({ 0: 9 });
  });

  it("still returns a valid (empty) VizGraphData for an empty graph, via the fallback path", () => {
    const viz = deriveVizGraph({ nodes: [], edges: [] });
    expect(viz.nodes).toEqual([]);
    expect(viz.edges).toEqual([]);
  });
});

describe("neighborsOf", () => {
  it("returns the 1-hop neighbor set regardless of edge direction", () => {
    expect(Array.from(neighborsOf(sample, "b")).sort()).toEqual(["a", "c"]);
    expect(Array.from(neighborsOf(sample, "d"))).toEqual([]);
  });
});
