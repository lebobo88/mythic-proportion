import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { collapseCentralityScore, fetchGraph, normalizeGraphResponse } from "../api";

// Phase 4b (plan Section 6.4/7): the server's enriched `/api/graph`
// per-node `centrality` field is a richer WIRE object
// (`{degree, betweenness?, eigenvector?}`, each normalized 0..1) than the
// scalar `GraphNode.centrality` every existing graph renderer already
// consumes (see `synthetic.ts`'s Phase 4a fixture shape). `fetchGraph`
// collapses that object down to the established scalar exactly once, at the
// network boundary -- these tests cover that seam directly.
describe("collapseCentralityScore", () => {
  it("prefers eigenvector when present", () => {
    expect(collapseCentralityScore({ degree: 0.1, betweenness: 0.5, eigenvector: 0.9 })).toBe(0.9);
  });

  it("falls back to betweenness when eigenvector is absent", () => {
    expect(collapseCentralityScore({ degree: 0.1, betweenness: 0.5 })).toBe(0.5);
  });

  it("falls back to degree when neither eigenvector nor betweenness is present", () => {
    expect(collapseCentralityScore({ degree: 0.3 })).toBe(0.3);
  });

  it("is idempotent: an already-scalar value passes straight through unchanged", () => {
    expect(collapseCentralityScore(0.42)).toBe(0.42);
  });

  it("returns undefined for a missing/null/malformed value", () => {
    expect(collapseCentralityScore(undefined)).toBeUndefined();
    expect(collapseCentralityScore(null)).toBeUndefined();
    expect(collapseCentralityScore({})).toBeUndefined();
  });
});

describe("normalizeGraphResponse", () => {
  it("collapses every node's centrality object to a scalar, leaving every other field untouched", () => {
    const raw = {
      nodes: [
        {
          id: "entity:1",
          label: "E1",
          type: "person",
          kind: "entity",
          degree: 3,
          community: 2,
          level: 0,
          centrality: { degree: 0.2, eigenvector: 0.75 },
        },
      ],
      edges: [{ source: "entity:1", target: "entity:2", weight: 4.5 }],
    };
    const data = normalizeGraphResponse(raw);
    expect(data.nodes[0].centrality).toBe(0.75);
    expect(data.nodes[0].community).toBe(2);
    expect(data.nodes[0].level).toBe(0);
    expect((data.nodes[0] as { degree?: number }).degree).toBe(3);
    expect(data.edges[0].weight).toBe(4.5);
  });

  it("leaves a node with no centrality field entirely alone", () => {
    const raw = { nodes: [{ id: "a", label: "A", type: "concept" }], edges: [] };
    const data = normalizeGraphResponse(raw);
    expect(data.nodes[0]).not.toHaveProperty("centrality");
  });

  it("tolerates a response with missing nodes/edges arrays", () => {
    expect(normalizeGraphResponse({})).toEqual({ nodes: [], edges: [] });
  });
});

describe("fetchGraph() applies the centrality collapse to every node in the real fetch path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a scalar `centrality` even though the server sent an object", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        nodes: [
          {
            id: "entity:1",
            label: "E1",
            type: "person",
            centrality: { degree: 0.1, eigenvector: 0.6 },
          },
        ],
        edges: [],
      }),
    });
    const data = await fetchGraph("entities");
    expect(data.nodes[0].centrality).toBe(0.6);
  });
});
