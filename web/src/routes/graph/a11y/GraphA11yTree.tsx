// Visually-hidden, keyboard-navigable parallel DOM (deliverable 10,
// REQUIRED): canvas/WebGL is opaque to assistive tech, so this mirrors the
// graph as a real node/neighbor tree + a links data table, with the current
// selection announced via `aria-live`. Rendered alongside the Canvas (2D or
// 3D), never inside it.
//
// Phase 4c (plan Section 6.5 item 6; Section 9.3 journey 4): per-mode
// parity. Cloud keeps its original flat-list-plus-neighbors tree exactly as
// it was pre-Phase-4c (nothing below changed that branch's markup); Orbital,
// Strata, and Terrain each get their own structure -- a tree grouped by
// community, a Leiden-hierarchy tree with level/ancestor info, and a region
// list with tier/numeric elevation, respectively -- built from the SAME
// pure `graphModeViews.ts` grouping functions the visible
// `Graph2DModeFallback.tsx` panel uses, and colored/glyphed via the SAME
// generative ramp (`CommunityBadge`/`lib/graph-colors.ts`) as everywhere
// else, so community coloring never means something different in one
// mode's tree than another's.
import { useMemo } from "react";
import type { VizEdge, VizNode } from "../types";
import type { GraphColors } from "../../../lib/graph-colors";
import { neighborsOf } from "../graphMath";
import { groupByCommunity, groupByStrataHierarchy, groupByTerrainRegion, TERRAIN_TIER_LABELS } from "../graphModeViews";
import { CommunityBadge, CommunityGlyphIcon } from "../CommunityBadge";

export interface GraphA11yTreeProps {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleIds: Set<string>;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  /** Defaults to "cloud" so every pre-Phase-4c caller (tests, a future standalone embed) keeps rendering the original flat tree unchanged. */
  mode?: "cloud" | "orbital" | "strata" | "terrain";
  /** Optional -- only orbital/strata/terrain need it (for community swatches); cloud's original markup never read colors and still doesn't. */
  colors?: GraphColors | null;
}

export function GraphA11yTree({
  nodes,
  edges,
  visibleIds,
  selectedId,
  onSelectNode,
  mode = "cloud",
  colors,
}: GraphA11yTreeProps) {
  const visibleNodes = useMemo(() => nodes.filter((n) => visibleIds.has(n.id)), [nodes, visibleIds]);
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : null;
  const neighborIds = selectedId ? neighborsOf({ nodes, edges }, selectedId) : new Set<string>();

  return (
    <div className="mp-graph-a11y-tree" aria-label="Knowledge graph (accessible view)">
      <p className="mp-visually-hidden" role="status" aria-live="polite">
        {selectedNode ? `Selected: ${selectedNode.label}, ${neighborIds.size} connections.` : "No node selected."}
      </p>

      {mode === "orbital" ? (
        <OrbitalA11yTree nodes={visibleNodes} selectedId={selectedId} onSelectNode={onSelectNode} colors={colors} />
      ) : mode === "strata" ? (
        <StrataA11yTree nodes={visibleNodes} selectedId={selectedId} onSelectNode={onSelectNode} colors={colors} />
      ) : mode === "terrain" ? (
        <TerrainA11yList nodes={visibleNodes} selectedId={selectedId} onSelectNode={onSelectNode} colors={colors} />
      ) : (
        <StandardA11yTree
          nodes={nodes}
          edges={edges}
          visibleNodes={visibleNodes}
          visibleIds={visibleIds}
          selectedId={selectedId}
          onSelectNode={onSelectNode}
          neighborIds={neighborIds}
        />
      )}
    </div>
  );
}

// Cloud (default/original): unchanged markup from pre-Phase-4c
// `GraphA11yTree` -- "Standard is a flat list plus neighbors" (Section 9.3
// journey 4).
function StandardA11yTree({
  nodes,
  edges,
  visibleNodes,
  visibleIds,
  selectedId,
  onSelectNode,
  neighborIds,
}: {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleNodes: VizNode[];
  visibleIds: Set<string>;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  neighborIds: Set<string>;
}) {
  const labelById = useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes]);

  return (
    <>
      <ul role="tree" aria-label="Graph nodes">
        {visibleNodes.map((node) => (
          <li key={node.id} role="treeitem" aria-selected={node.id === selectedId}>
            <button type="button" onClick={() => onSelectNode(node.id)}>
              {node.label} ({node.type})
            </button>
            {node.id === selectedId ? (
              <ul aria-label={`Neighbors of ${node.label}`}>
                {Array.from(neighborIds).map((neighborId) => (
                  <li key={neighborId}>
                    <button type="button" onClick={() => onSelectNode(neighborId)}>
                      {labelById.get(neighborId) ?? neighborId}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      <table aria-label="Graph links">
        <caption>Links between nodes</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Target</th>
          </tr>
        </thead>
        <tbody>
          {edges
            .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
            .map((edge, i) => (
              <tr key={`${edge.source}-${edge.target}-${i}`}>
                <td>{labelById.get(edge.source) ?? edge.source}</td>
                <td>{labelById.get(edge.target) ?? edge.target}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </>
  );
}

// Orbital: "a tree grouped by community" (Section 9.3 journey 4).
function OrbitalA11yTree({
  nodes,
  selectedId,
  onSelectNode,
  colors,
}: {
  nodes: VizNode[];
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  colors?: GraphColors | null;
}) {
  const groups = useMemo(() => groupByCommunity(nodes), [nodes]);
  return (
    <ul role="tree" aria-label="Communities (Orbital)">
      {groups.map((group) => (
        <li key={group.community} role="treeitem" aria-expanded="true">
          {colors ? (
            <CommunityBadge
              index={group.community}
              count={groups.length}
              color={colors.community[group.community % colors.community.length]}
              suffix={`${group.nodes.length} node${group.nodes.length === 1 ? "" : "s"}`}
            />
          ) : (
            <span>Community {group.community}</span>
          )}
          <ul aria-label={`Community ${group.community} members`}>
            {group.nodes.map((node) => (
              <li key={node.id} role="treeitem" aria-selected={node.id === selectedId}>
                <button type="button" onClick={() => onSelectNode(node.id)}>
                  {node.label} ({node.type})
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// Strata: "a Leiden-hierarchy tree with level and ancestor information"
// (Section 9.3 journey 4), using the `parentCommunity` field (Phase 4b).
function StrataA11yTree({
  nodes,
  selectedId,
  onSelectNode,
  colors,
}: {
  nodes: VizNode[];
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  colors?: GraphColors | null;
}) {
  const levels = useMemo(() => groupByStrataHierarchy(nodes), [nodes]);
  return (
    <ul role="tree" aria-label="Hierarchy levels (Strata)">
      {levels.map((levelGroup) => (
        <li key={levelGroup.level} role="treeitem" aria-expanded="true">
          <span>Level {levelGroup.level}</span>
          <ul aria-label={`Level ${levelGroup.level} communities`}>
            {levelGroup.communities.map((communityGroup) => {
              const ancestorText = communityGroup.parentCommunity
                ? Object.entries(communityGroup.parentCommunity)
                    .sort((a, b) => Number(a[0]) - Number(b[0]))
                    .map(([ancestorLevel, ancestorCommunity]) => `parent at level ${ancestorLevel}: Community ${ancestorCommunity}`)
                    .join("; ")
                : null;
              return (
                <li key={communityGroup.community} role="treeitem" aria-expanded="true">
                  {colors ? (
                    <CommunityBadge
                      index={communityGroup.community}
                      count={levelGroup.communities.length}
                      level={levelGroup.level}
                      color={colors.communityAt(communityGroup.community % colors.community.length, levelGroup.level)}
                      suffix={`${communityGroup.nodes.length} node${communityGroup.nodes.length === 1 ? "" : "s"}`}
                    />
                  ) : (
                    <span>Community {communityGroup.community}</span>
                  )}
                  {ancestorText ? <p className="mp-graph-hint">{ancestorText}</p> : null}
                  <ul aria-label={`Community ${communityGroup.community} members`}>
                    {communityGroup.nodes.map((node) => (
                      <li key={node.id} role="treeitem" aria-selected={node.id === selectedId}>
                        <button type="button" onClick={() => onSelectNode(node.id)}>
                          {node.label} ({node.type})
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// Terrain: "a region list with tier and numeric elevation" (Section 9.3
// journey 4) -- deliberately `role="list"`, not `role="tree"`, matching the
// design handoff's own wording ("region list").
function TerrainA11yList({
  nodes,
  selectedId,
  onSelectNode,
  colors,
}: {
  nodes: VizNode[];
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  colors?: GraphColors | null;
}) {
  const regions = useMemo(() => groupByTerrainRegion(nodes), [nodes]);
  return (
    <ul role="list" aria-label="Terrain regions">
      {regions.map((region) => (
        <li key={region.tier}>
          <span>
            {TERRAIN_TIER_LABELS[region.tier] ?? `Tier ${region.tier}`} (tier {region.tier}, elevation{" "}
            {region.elevation01.toFixed(2)})
          </span>
          <ul aria-label={`${TERRAIN_TIER_LABELS[region.tier] ?? `Tier ${region.tier}`} nodes`}>
            {region.nodes.map((node) => (
              // `aria-selected` is only valid on option/row/tab/treeitem/
              // gridcell roles -- this is a plain `listitem` (role="list"
              // above, per Section 9.3 journey 4's "region list" wording),
              // so `aria-current` is the ARIA-valid way to mark the active
              // item here (same token this app's TabNav fix already uses
              // for "current" state -- see Section 3.3's TabNav defect fix).
              <li key={node.id} aria-current={node.id === selectedId ? "true" : undefined}>
                {colors ? (
                  <CommunityGlyphBullet index={node.community} />
                ) : null}
                <button type="button" onClick={() => onSelectNode(node.id)}>
                  {node.label} ({node.type})
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// Small inline non-color cue for a Terrain list row (its community, not its
// elevation tier, is the color-coded dimension elsewhere in the app) --
// avoids importing CommunityBadge's full color-swatch machinery for a
// context where GraphColors keyed strictly by tier doesn't apply.
function CommunityGlyphBullet({ index }: { index: number }) {
  return <CommunityGlyphIcon index={index} size={10} />;
}
