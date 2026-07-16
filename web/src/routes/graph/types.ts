// Shared shape for the Phase 5 3D/2D graph views. `VizNode`/`VizEdge` are a
// superset of `GraphData`'s `GraphNode`/`GraphEdge` (see ../../lib/api.ts) --
// every field GraphView derives client-side (degree, community, size) is
// additive so a raw `/api/graph` response is always a valid `VizNode[]`
// input to `deriveVizGraph` below.

import type { GraphData, GraphEdge, GraphNode } from "../../lib/api";

export interface VizNode extends GraphNode {
  /** kind is only present for entities/both responses -- see api.ts GraphNode note in app.py. */
  kind?: "page" | "entity";
  /** Only present on entity nodes returned by mode=entities|both. */
  degree?: number;
  /** Client-derived community bucket (0..COMMUNITY_COUNT-1) -- see communities.ts. */
  community: number;
  /** Client-derived visual size (degree/centrality-scaled), in world units. */
  size: number;
}

export interface VizEdge extends GraphEdge {
  weight?: number;
  type?: string;
}

export interface VizGraphData {
  nodes: VizNode[];
  edges: VizEdge[];
}

export interface FilterState {
  /** Entity/page `type` values to include; empty set = "no type filter". */
  types: Set<string>;
  /** Community indices to include; empty set = "no community filter". */
  communities: Set<number>;
}

export function emptyFilterState(): FilterState {
  return { types: new Set(), communities: new Set() };
}

export function nodeVisible(node: VizNode, filter: FilterState): boolean {
  if (filter.types.size > 0 && !filter.types.has(node.type)) return false;
  if (filter.communities.size > 0 && !filter.communities.has(node.community)) return false;
  return true;
}

/** Re-export so callers of this module don't also need to import api.ts. */
export type { GraphData, GraphNode, GraphEdge };
