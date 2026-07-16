// Client-side graph-derivation utilities: degree/centrality sizing and a
// deterministic "community" bucketing.
//
// NOTE on communities: real Leiden communities are a *server-side* Phase 4
// concept (see src/mythic_proportion/graph/ -- graspologic hierarchical
// Leiden) but `GET /api/graph` (mode=entities|both) does not currently
// project a community id onto each node (see
// GraphStore.read_entity_graph -- id/label/type/kind/degree only, no
// community). Rather than block Phase 5's rendering deliverables on a new
// backend field, we derive a *visual* community bucket client-side via
// connected-component grouping + a stable hash into the 8-slot
// `--graph-community-*` ramp. This is intentionally NOT a Leiden
// implementation -- it exists purely so the hull/color-by-community
// deliverable has *some* grouping to render, is fully deterministic (same
// input graph -> same buckets every time), and is trivially replaced by a
// real `community` field from the server without touching any renderer
// code (see VizNode.community's single call site: `deriveVizGraph`).
import type { GraphData, VizGraphData, VizNode } from "./types";

export const COMMUNITY_COUNT = 8;

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    if (!this.parent.has(x)) this.parent.set(x, x);
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** FNV-1a-ish string hash -> non-negative int, used only for stable bucketing. */
function stringHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function computeDegrees(data: GraphData): Map<string, number> {
  const degree = new Map<string, number>();
  for (const node of data.nodes) degree.set(node.id, 0);
  for (const edge of data.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

export function computeCommunities(data: GraphData): Map<string, number> {
  const uf = new UnionFind();
  for (const node of data.nodes) uf.find(node.id);
  for (const edge of data.edges) uf.union(edge.source, edge.target);

  const roots = new Map<string, number>();
  for (const node of data.nodes) {
    const root = uf.find(node.id);
    if (!roots.has(root)) roots.set(root, stringHash(root) % COMMUNITY_COUNT);
  }

  const community = new Map<string, number>();
  for (const node of data.nodes) {
    community.set(node.id, roots.get(uf.find(node.id))!);
  }
  return community;
}

const MIN_SIZE = 0.6;
const MAX_SIZE = 3.2;

export function sizeForDegree(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return MIN_SIZE;
  const t = Math.sqrt(degree / maxDegree); // sqrt curve: high-degree hubs stand out without dwarfing everything else
  return MIN_SIZE + t * (MAX_SIZE - MIN_SIZE);
}

/** Adds degree/community/size to every node -- the one place VizNode gets built. */
export function deriveVizGraph(data: GraphData): VizGraphData {
  const degrees = computeDegrees(data);
  const communities = computeCommunities(data);
  const maxDegree = Math.max(1, ...Array.from(degrees.values()));

  const nodes: VizNode[] = data.nodes.map((node) => {
    const degree = (node as { degree?: number }).degree ?? degrees.get(node.id) ?? 0;
    return {
      ...node,
      degree,
      community: communities.get(node.id) ?? 0,
      size: sizeForDegree(degree, maxDegree),
    };
  });

  return { nodes, edges: data.edges };
}

/** 1-hop neighbor id set for a given node id, from the raw edge list. */
export function neighborsOf(data: GraphData, nodeId: string): Set<string> {
  const out = new Set<string>();
  for (const edge of data.edges) {
    if (edge.source === nodeId) out.add(edge.target);
    else if (edge.target === nodeId) out.add(edge.source);
  }
  return out;
}
