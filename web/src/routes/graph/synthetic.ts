// DEV-ONLY synthetic graph generator. The real vault is tiny, so there is no
// way to exercise the 3D scene at the ~10k/~50k-node target without one.
// Pure client-side, deterministic (seeded), zero-dep -- no network, no
// backend change. Wired in via a dev query param (`?syntheticGraph=10000`)
// read once by `useGraphData` (see GraphView.tsx), and never imported by any
// production code path that isn't already dev-gated by `import.meta.env.DEV`.
import type { GraphData } from "../../lib/api";

const NODE_TYPES = ["source", "entity", "concept", "session"] as const;

/** Small deterministic PRNG (mulberry32) so a given seed always yields the same graph. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticGraphOptions {
  nodeCount: number;
  /** Average edges-per-node; final edge count is approximately nodeCount * avgDegree / 2. */
  avgDegree?: number;
  /** Number of loose "hub" clusters to bias edge formation toward (gives communities visible structure). */
  clusterCount?: number;
  seed?: number;
}

export function generateSyntheticGraph(options: SyntheticGraphOptions): GraphData {
  const { nodeCount, avgDegree = 4, clusterCount = Math.max(4, Math.round(Math.sqrt(nodeCount))), seed = 1 } =
    options;
  const rand = mulberry32(seed);

  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `synthetic:${i}`,
    label: `Synthetic Node ${i}`,
    type: NODE_TYPES[i % NODE_TYPES.length],
  }));

  // Assign each node to a loose cluster; edges are biased (not exclusive) toward
  // same-cluster targets so the resulting graph has visible community structure
  // for the hull/filter deliverables to render against, without being a literal
  // Leiden output (see graphMath.ts's community-derivation note).
  const clusterOf = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) clusterOf[i] = Math.floor(rand() * clusterCount);

  const clusterMembers: number[][] = Array.from({ length: clusterCount }, () => []);
  for (let i = 0; i < nodeCount; i++) clusterMembers[clusterOf[i]].push(i);

  const targetEdgeCount = Math.round((nodeCount * avgDegree) / 2);
  const seen = new Set<string>();
  const edges: { source: string; target: string }[] = [];

  let attempts = 0;
  const maxAttempts = targetEdgeCount * 8 + 1000;
  while (edges.length < targetEdgeCount && attempts < maxAttempts) {
    attempts += 1;
    const a = Math.floor(rand() * nodeCount);
    const sameCluster = rand() < 0.85;
    let b: number;
    if (sameCluster && clusterMembers[clusterOf[a]].length > 1) {
      const members = clusterMembers[clusterOf[a]];
      b = members[Math.floor(rand() * members.length)];
    } else {
      b = Math.floor(rand() * nodeCount);
    }
    if (a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: `synthetic:${a}`, target: `synthetic:${b}` });
  }

  return { nodes, edges };
}

/** Reads `?syntheticGraph=<n>` from the current location, dev-only, undefined otherwise. */
export function syntheticGraphSizeFromLocation(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  const params = new URLSearchParams(search);
  const raw = params.get("syntheticGraph");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
