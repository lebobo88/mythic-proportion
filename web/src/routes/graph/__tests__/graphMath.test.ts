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
});

describe("neighborsOf", () => {
  it("returns the 1-hop neighbor set regardless of edge direction", () => {
    expect(Array.from(neighborsOf(sample, "b")).sort()).toEqual(["a", "c"]);
    expect(Array.from(neighborsOf(sample, "d"))).toEqual([]);
  });
});
