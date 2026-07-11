// Capped troika-three-text labels (Issue 3c, live-Chrome hardening pass):
// the 3D scene must NEVER render one `Text` mesh per node -- at 10k/50k
// nodes that is its own GPU/CPU blowup on top of the instanced-mesh cost.
// Instead we hard-cap the labeled set to the hovered node, the selected
// node, and the highest-degree nodes among whatever's currently rendered,
// up to `maxLabels` total. Positions are written into each `Text`'s
// `.position` from the same per-tick buffer InstancedNodes/InstancedEdges
// consume -- never via React state (see Graph3DScene's single onTick
// subscriber).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { Group } from "three";
import { Text } from "troika-three-text";
import type { GraphColors } from "../../../lib/graph-colors";
import type { VizNode } from "../types";

export interface NodeLabelsHandle {
  /** Mutate label positions from the latest worker tick -- called from Graph3DScene's single onTick subscriber. */
  applyPositions(positions: Float32Array, ids: string[]): void;
}

export interface NodeLabelsProps {
  /** Already-bounded (rendered/disclosed) node set -- see Graph3DScene's `renderedNodes`. */
  nodes: VizNode[];
  colors: GraphColors;
  selectedId: string | null;
  hoveredId: string | null;
  /** Hard cap on simultaneously-labeled nodes -- a few dozen max, never one-per-node. */
  maxLabels?: number;
}

const DEFAULT_MAX_LABELS = 40;
const LABEL_Y_OFFSET = 1.6;

function colorForLabel(node: VizNode, colors: GraphColors): number {
  const base =
    node.kind === "entity"
      ? colors.community[node.community % colors.community.length]?.color
      : colors.node[node.type as keyof GraphColors["node"]]?.color;
  return (base ?? colors.node.concept.color).getHex();
}

export const NodeLabels = forwardRef<NodeLabelsHandle, NodeLabelsProps>(function NodeLabels(
  { nodes, colors, selectedId, hoveredId, maxLabels = DEFAULT_MAX_LABELS },
  ref,
) {
  const groupRef = useRef<Group>(null);
  const textsRef = useRef(new Map<string, Text>());

  // Selection: hovered + selected are always included (if currently
  // rendered), then top-degree nodes fill the remaining budget -- the
  // WHOLE set is clamped to `maxLabels`, never grows with total node count.
  const labeledNodes = useMemo(() => {
    const out: VizNode[] = [];
    const seen = new Set<string>();
    const byId = new Map(nodes.map((n) => [n.id, n]));

    for (const id of [selectedId, hoveredId]) {
      if (!id || seen.has(id)) continue;
      const node = byId.get(id);
      if (node) {
        out.push(node);
        seen.add(id);
      }
    }

    const byDegree = [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
    for (const node of byDegree) {
      if (out.length >= maxLabels) break;
      if (seen.has(node.id)) continue;
      out.push(node);
      seen.add(node.id);
    }

    return out.slice(0, maxLabels);
  }, [nodes, selectedId, hoveredId, maxLabels]);

  // Rebuild the (small, capped) set of Text meshes on selection change --
  // NOT per tick/per frame.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const existing = textsRef.current;
    const keep = new Set(labeledNodes.map((n) => n.id));

    for (const [id, text] of existing) {
      if (keep.has(id)) continue;
      group.remove(text);
      text.dispose();
      existing.delete(id);
    }

    for (const node of labeledNodes) {
      let text = existing.get(node.id);
      if (!text) {
        text = new Text();
        text.fontSize = 1.3;
        text.anchorX = "center";
        text.anchorY = "bottom";
        text.outlineWidth = "6%";
        text.outlineColor = 0x000000;
        group.add(text);
        existing.set(node.id, text);
      }
      text.text = node.label;
      text.color = colorForLabel(node, colors);
      text.sync();
    }
  }, [labeledNodes, colors]);

  useEffect(() => {
    const existing = textsRef.current;
    return () => {
      for (const text of existing.values()) text.dispose();
      existing.clear();
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      applyPositions(positions, ids) {
        const texts = textsRef.current;
        if (texts.size === 0) return;
        for (let i = 0; i < ids.length; i++) {
          const text = texts.get(ids[i]);
          if (!text) continue;
          text.position.set(positions[i * 3], positions[i * 3 + 1] + LABEL_Y_OFFSET, positions[i * 3 + 2]);
        }
      },
    }),
    [],
  );

  return <group ref={groupRef} />;
});
