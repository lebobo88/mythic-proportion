// Visually-hidden, keyboard-navigable parallel DOM (deliverable 10,
// REQUIRED): canvas/WebGL is opaque to assistive tech, so this mirrors the
// graph as a real node/neighbor tree + a links data table, with the current
// selection announced via `aria-live`. Rendered alongside the Canvas (2D or
// 3D), never inside it.
import { useMemo } from "react";
import type { VizEdge, VizNode } from "../types";
import { neighborsOf } from "../graphMath";

export interface GraphA11yTreeProps {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleIds: Set<string>;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
}

export function GraphA11yTree({ nodes, edges, visibleIds, selectedId, onSelectNode }: GraphA11yTreeProps) {
  const visibleNodes = useMemo(() => nodes.filter((n) => visibleIds.has(n.id)), [nodes, visibleIds]);
  const labelById = useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes]);
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : null;
  const neighborIds = selectedId ? neighborsOf({ nodes, edges }, selectedId) : new Set<string>();

  return (
    <div className="mp-graph-a11y-tree" aria-label="Knowledge graph (accessible view)">
      <p className="mp-visually-hidden" role="status" aria-live="polite">
        {selectedNode ? `Selected: ${selectedNode.label}, ${neighborIds.size} connections.` : "No node selected."}
      </p>

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
    </div>
  );
}
