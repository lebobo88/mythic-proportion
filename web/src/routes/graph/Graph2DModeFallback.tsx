// Visible 2D fallback for Orbital/Strata/Terrain (plan Section 6.5 item 6;
// Section 9.3 journey 3: "Orbital renders nested clusters, Strata renders a
// dendrogram plus a links table, Terrain renders a contour/region map with
// numeric elevation"). Cloud's own 2D fallback (`Graph2DFallback.tsx`, a
// mouse-driven force-directed canvas) stays exactly as it was -- this
// component is the OTHER three modes' `!mode3D` view, rendered instead of
// it (GraphView picks one or the other, never both, based on `mode`).
//
// Deliberately DOM/structural (nested lists + a table), not a re-implemented
// physics canvas: WebGL/canvas is opaque to assistive tech, so this
// codebase's established pattern (see `a11y/GraphA11yTree.tsx`'s own doc
// comment) is that a real structural DOM view IS a legitimate, honest 2D
// representation -- it just isn't a force-simulated node-link diagram the
// way Cloud's is. It shares the exact same pure grouping functions
// (`graphModeViews.ts`) and the same generative-ramp color/glyph badges
// (`CommunityBadge.tsx`) as `GraphA11yTree.tsx`'s per-mode trees, so the two
// are always in agreement (Section 6.5 item 6's last bullet: "Each mode's 2D
// fallback and accessibility tree should use the SAME generative color ramp
// ... for consistency").
import { useMemo } from "react";
import type { GraphColors } from "../../lib/graph-colors";
import type { GraphMode, VizEdge, VizNode } from "./types";
import { groupByCommunity, groupByStrataHierarchy, groupByTerrainRegion, TERRAIN_TIER_LABELS } from "./graphModeViews";
import { CommunityBadge, CommunityGlyphIcon } from "./CommunityBadge";

export interface Graph2DModeFallbackProps {
  mode: Exclude<GraphMode, "cloud">;
  nodes: VizNode[];
  /**
   * Only consumed by Strata's links table (Section 9.3 journey 3: "Strata
   * renders a dendrogram plus a links table") -- Orbital/Terrain don't need
   * edges, so this defaults to `[]` rather than being required at every call
   * site. VERIFICATION_NEEDS_FIX (major) remediation: this prop did not
   * exist at all before, so Strata's `<tbody>` was permanently empty
   * regardless of input.
   */
  edges?: VizEdge[];
  colors: GraphColors;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
}

export function Graph2DModeFallback({ mode, nodes, edges = [], colors, selectedId, onSelectNode }: Graph2DModeFallbackProps) {
  return (
    <div className="mp-graph-mode-fallback" data-mode={mode}>
      {mode === "orbital" ? (
        <OrbitalFallback nodes={nodes} colors={colors} selectedId={selectedId} onSelectNode={onSelectNode} />
      ) : mode === "strata" ? (
        <StrataFallback nodes={nodes} edges={edges} colors={colors} selectedId={selectedId} onSelectNode={onSelectNode} />
      ) : (
        <TerrainFallback nodes={nodes} colors={colors} selectedId={selectedId} onSelectNode={onSelectNode} />
      )}
    </div>
  );
}

function NodeButton({ node, selectedId, onSelectNode }: { node: VizNode; selectedId: string | null; onSelectNode: (id: string) => void }) {
  return (
    <button
      type="button"
      className={node.id === selectedId ? "mp-graph-filter mp-graph-filter--active" : "mp-graph-filter"}
      onClick={() => onSelectNode(node.id)}
    >
      {node.label}
    </button>
  );
}

function OrbitalFallback({
  nodes,
  colors,
  selectedId,
  onSelectNode,
}: {
  nodes: VizNode[];
  colors: GraphColors;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
}) {
  const groups = useMemo(() => groupByCommunity(nodes), [nodes]);
  return (
    <div className="mp-graph-mode-fallback-clusters">
      <p className="mp-graph-hint">Nested clusters by community (Orbital 2D fallback).</p>
      {groups.map((group) => (
        <fieldset key={group.community} className="mp-graph-mode-fallback-cluster">
          <legend>
            <CommunityBadge
              index={group.community}
              count={groups.length}
              color={colors.community[group.community % colors.community.length]}
              suffix={`${group.nodes.length} node${group.nodes.length === 1 ? "" : "s"}`}
            />
          </legend>
          {group.nodes.map((node) => (
            <NodeButton key={node.id} node={node} selectedId={selectedId} onSelectNode={onSelectNode} />
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function StrataFallback({
  nodes,
  edges,
  colors,
  selectedId,
  onSelectNode,
}: {
  nodes: VizNode[];
  edges: VizEdge[];
  colors: GraphColors;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
}) {
  const levels = useMemo(() => groupByStrataHierarchy(nodes), [nodes]);
  const labelById = useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes]);
  // Only edges between nodes actually rendered in this panel (the caller
  // already passes visible/filtered nodes) -- matches the same
  // both-endpoints-visible convention `GraphA11yTree.tsx`'s StandardA11yTree
  // links table already uses.
  const visibleEdges = useMemo(
    () => edges.filter((e) => labelById.has(e.source) && labelById.has(e.target)),
    [edges, labelById],
  );
  return (
    <div className="mp-graph-mode-fallback-strata">
      <p className="mp-graph-hint">Hierarchy dendrogram by level (Strata 2D fallback).</p>
      {levels.map((levelGroup) => (
        <fieldset key={levelGroup.level} className="mp-graph-mode-fallback-level">
          <legend>Level {levelGroup.level}</legend>
          {levelGroup.communities.map((communityGroup) => (
            <fieldset key={communityGroup.community} className="mp-graph-mode-fallback-cluster">
              <legend>
                <CommunityBadge
                  index={communityGroup.community}
                  count={levelGroup.communities.length}
                  level={levelGroup.level}
                  color={colors.communityAt(communityGroup.community % colors.community.length, levelGroup.level)}
                  suffix={`${communityGroup.nodes.length} node${communityGroup.nodes.length === 1 ? "" : "s"}`}
                />
              </legend>
              {communityGroup.nodes.map((node) => (
                <NodeButton key={node.id} node={node} selectedId={selectedId} onSelectNode={onSelectNode} />
              ))}
            </fieldset>
          ))}
        </fieldset>
      ))}
      <table aria-label="Graph links">
        <caption>Links between nodes</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Target</th>
          </tr>
        </thead>
        <tbody>
          {visibleEdges.map((edge, i) => (
            <tr key={`${edge.source}-${edge.target}-${i}`}>
              <td>{labelById.get(edge.source) ?? edge.source}</td>
              <td>{labelById.get(edge.target) ?? edge.target}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TerrainFallback({
  nodes,
  colors,
  selectedId,
  onSelectNode,
}: {
  nodes: VizNode[];
  colors: GraphColors;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
}) {
  const regions = useMemo(() => groupByTerrainRegion(nodes), [nodes]);
  return (
    <div className="mp-graph-mode-fallback-terrain">
      <p className="mp-graph-hint">Region/contour map with numeric elevation (Terrain 2D fallback).</p>
      {regions.map((region) => (
        <fieldset key={region.tier} className="mp-graph-mode-fallback-region">
          <legend>
            {TERRAIN_TIER_LABELS[region.tier] ?? `Tier ${region.tier}`} — tier {region.tier}, elevation{" "}
            {region.elevation01.toFixed(2)}
          </legend>
          {region.nodes.map((node) => (
            <span key={node.id} className="mp-graph-mode-fallback-region-node">
              <CommunityGlyphIcon
                index={node.community}
                size={10}
                color={`#${colors.community[node.community % colors.community.length].color.getHexString()}`}
              />
              <NodeButton node={node} selectedId={selectedId} onSelectNode={onSelectNode} />
            </span>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
