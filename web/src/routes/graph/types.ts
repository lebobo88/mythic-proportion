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
  /**
   * Community bucket. Phase 4b (plan Section 6.4): this is the REAL Leiden
   * community id, taken straight from the server's `GraphNode.community`,
   * whenever the response carries one on every node -- `deriveVizGraph`
   * falls back to the client-side union-find grouping in `graphMath.ts`
   * (explicitly labeled "approximate" there) only when the enriched field
   * is absent (a pre-Phase-4b fixture, a wikilinks-mode graph, or a vault
   * that has never run `mythic index-graph`).
   */
  community: number;
  /**
   * True when `community` above came from the client union-find fallback
   * (`graphMath.ts`'s `computeCommunities`), not the server's real Leiden
   * projection -- set per-node by `deriveVizGraph` (J-002 remediation: the
   * real/fallback boundary is per-node, since `mode=both` unions
   * never-enriched page nodes with entity nodes that may or may not be
   * enriched). Lets a future renderer visually distinguish an approximate
   * grouping from a real one without re-deriving anything. Always `false`
   * for a real-community node; `true` for every fallback-bucketed one.
   */
  communityApproximate: boolean;
  /** Client-derived visual size (degree/centrality-scaled), in world units. */
  size: number;
  // `level`/`centrality`/`parentCommunity` are inherited unchanged from
  // `GraphNode` above -- see that interface's doc comments. Phase 4a's
  // synthetic-fixture spike (`synthetic.ts`) already produces exactly this
  // shape, and Phase 4b's real server data converges onto the same shape
  // via `fetchGraph`'s `collapseCentralityScore` normalization, so nothing
  // downstream of `deriveVizGraph` (`ForceLayoutClient`, `modeForces.ts`,
  // `terrainElevation.ts`, ...) needs to change for either data source.
}

export interface VizEdge extends GraphEdge {
  // `weight`/`type` are already declared on `GraphEdge` (api.ts, Phase 4b
  // client-wiring: the server has always returned `weight` for
  // entities/both-mode edges -- see store.py's `read_entity_graph` -- this
  // just made the existing wire field visible at the type level). Kept
  // here, redeclared identically, purely so this interface's own history is
  // legible without cross-referencing api.ts.
  weight?: number;
  type?: string;
}

export interface VizGraphData {
  nodes: VizNode[];
  edges: VizEdge[];
}

/**
 * Phase 4a de-risking spike (plan Section 6.3): the four graph
 * representations under test -- the existing standard force-directed
 * "Cloud" view plus prototypes of Orbital Systems, Strata, and Knowledge
 * Terrain. This lives alongside `VizNode`/`VizEdge` because it is the shared
 * vocabulary between the synthetic fixture generator, the worker's per-mode
 * force configuration, and the mode-transition/terrain-surface rendering
 * code -- not because mode-switching is fully wired into production
 * `GraphView` yet (that remains Phase 4c's job, plan Section 6.5).
 */
export type GraphMode = "cloud" | "orbital" | "strata" | "terrain";

export const GRAPH_MODES: readonly GraphMode[] = ["cloud", "orbital", "strata", "terrain"];

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
