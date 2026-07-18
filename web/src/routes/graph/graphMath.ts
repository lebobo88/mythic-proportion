// Client-side graph-derivation utilities: degree/centrality sizing and a
// deterministic "community" bucketing.
//
// NOTE on communities: real Leiden communities are a *server-side* concept
// (see src/mythic_proportion/graph/ -- graspologic hierarchical Leiden).
// Phase 4b (plan Section 6.4/7) taught `GET /api/graph` (mode=entities|both)
// to project a real `community`/`level`/`centrality` onto each node once
// `mythic index-graph` has run -- `deriveVizGraph` below prefers that real
// projection whenever the WHOLE response carries it. `computeCommunities`
// here remains the FALLBACK path only: a *visual* community bucket derived
// client-side via connected-component grouping + a stable hash into the
// 8-slot `--graph-community-*` ramp, used only when the server hasn't
// projected real community ids yet (a pre-Phase-4b fixture, a
// wikilinks-mode graph, or a vault that has never run `mythic index-graph`).
// This is intentionally NOT a Leiden implementation -- it exists purely so
// the hull/color-by-community deliverable always has *some* grouping to
// render, and is fully deterministic (same input graph -> same buckets
// every time).
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

function hasRealCommunity(node: { community?: number }): boolean {
  return typeof node.community === "number";
}

/** Adds degree/community/size to every node -- the one place VizNode gets built.
 *
 * Phase 4b (plan Section 6.4), J-002 remediation (Codex `CODE_REVIEW`
 * checkpoint, plan Section 12): the real/fallback boundary is PER-NODE, not
 * whole-response. The production Graph view always fetches `mode=both`
 * (page nodes + entity nodes unioned) -- the server only ever projects
 * Leiden data onto ENTITY nodes (see `project_node_enrichment` in
 * communities.py), so page nodes never carry a `community` field, no matter
 * how current the index is. A whole-response "every node must have one"
 * check therefore discarded EVERY entity node's real community too, purely
 * because unrelated page nodes never carry one -- making the real
 * projection permanently unreachable in production, not merely "sometimes
 * approximate". Each node now independently uses its own real `community`
 * when present; only the nodes that actually lack one (page nodes, or every
 * node before `mythic index-graph` has ever run) fall back to the client
 * union-find grouping (still explicitly labeled "approximate" -- see
 * `computeCommunities`'s own module doc above).
 *
 * Fallback ids are offset past every real Leiden id actually present in
 * THIS response (see `fallbackCommunityOffset` below) so the two id spaces
 * can never numerically collide when they coexist in one view -- a
 * fallback-bucketed page node is never mistakable for a real Leiden
 * community by number alone. `communityApproximate` additionally marks
 * exactly which nodes got the fallback treatment, so a future renderer
 * (Phase 4c) can visually distinguish them (e.g. a muted/dashed hull)
 * without re-deriving anything.
 *
 * `level`/`centrality`/`parentCommunity` need no equivalent per-node
 * handling -- they simply ride through unchanged via the `...node` spread
 * below, exactly like every pre-existing additive field this function
 * already passed through untouched. */
export function deriveVizGraph(data: GraphData): VizGraphData {
  const degrees = computeDegrees(data);
  const needsFallback = data.nodes.some((node) => !hasRealCommunity(node));
  const fallbackCommunities = needsFallback ? computeCommunities(data) : null;
  const fallbackOffset = fallbackCommunityOffset(data);
  const maxDegree = Math.max(1, ...Array.from(degrees.values()));

  const nodes: VizNode[] = data.nodes.map((node) => {
    const degree = (node as { degree?: number }).degree ?? degrees.get(node.id) ?? 0;
    const isReal = hasRealCommunity(node);
    const community = isReal
      ? (node.community as number)
      : fallbackOffset + (fallbackCommunities!.get(node.id) ?? 0);
    return {
      ...node,
      degree,
      community,
      communityApproximate: !isReal,
      size: sizeForDegree(degree, maxDegree),
    };
  });

  return { nodes, edges: data.edges };
}

/**
 * The smallest fallback-bucket offset guaranteed to sit strictly past every
 * REAL Leiden `community` id already present in `data` -- 0 when no node
 * carries a real id at all (the common today's-default/pre-index-graph
 * case, where fallback ids stay exactly `0..COMMUNITY_COUNT-1`, unchanged
 * from this function's pre-J-002 numbering). See `deriveVizGraph`'s doc
 * comment for why this matters once real and fallback ids can coexist in
 * one response.
 */
function fallbackCommunityOffset(data: GraphData): number {
  let maxReal = -1;
  for (const node of data.nodes) {
    if (typeof node.community === "number" && node.community > maxReal) maxReal = node.community;
  }
  return maxReal + 1;
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
