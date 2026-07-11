// One batched LineSegments for every edge (deliverable 3): a single
// BufferGeometry with a position + a color attribute, positions rewritten
// each tick via `applyPositions` (refs only, never React state), degree/
// distance + focus-based fade baked into the color attribute's alpha via
// vertex-color intensity (LineBasicMaterial has no true per-vertex alpha,
// so "fade" here dims the RGB toward the scene background rather than
// changing opacity -- documented tradeoff, see graph.css/--graph-bg).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import type { VizEdge, VizNode } from "../types";

export interface InstancedEdgesHandle {
  applyPositions(positions: Float32Array, ids: string[]): void;
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

function mixColor(base: Color, bg: Color, t: number): Color {
  return base.clone().lerp(bg, t);
}

export const InstancedEdges = forwardRef<InstancedEdgesHandle, InstancedEdgesProps>(function InstancedEdges(
  { nodes, edges, visibleIds, colors, selectedId, hoveredId, neighborIds },
  ref,
) {
  const lineRef = useRef<LineSegments>(null);

  const geometry = useMemo(() => new BufferGeometry(), []);
  const material = useMemo(
    () => new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    [],
  );

  useEffect(() => {
    const positionAttr = new BufferAttribute(new Float32Array(edges.length * 2 * 3), 3);
    const colorAttr = new BufferAttribute(new Float32Array(edges.length * 2 * 3), 3);
    geometry.setAttribute("position", positionAttr);
    geometry.setAttribute("color", colorAttr);

    const bg = new Color(0, 0, 0);
    const focused = selectedId !== null || hoveredId !== null;
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const visible = visibleIds.has(edge.source) && visibleIds.has(edge.target);
      const isActive =
        focused &&
        (edge.source === selectedId ||
          edge.target === selectedId ||
          edge.source === hoveredId ||
          edge.target === hoveredId);
      const fadeT = !visible ? 1 : focused && !isActive ? 0.85 : 0;
      const base = isActive ? colors.edgeActive.color : colors.edge.color;
      const c = mixColor(base, bg, fadeT);
      colorAttr.setXYZ(i * 2, c.r, c.g, c.b);
      colorAttr.setXYZ(i * 2 + 1, c.r, c.g, c.b);
    }
    colorAttr.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, nodes, edges, colors, visibleIds, selectedId, hoveredId, neighborIds]);

  useImperativeHandle(
    ref,
    () => ({
      applyPositions(positions, ids) {
        const posAttr = geometry.getAttribute("position") as BufferAttribute | undefined;
        if (!posAttr) return;
        const latest = new Map<string, [number, number, number]>();
        for (let i = 0; i < ids.length; i++) {
          latest.set(ids[i], [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
        }
        for (let i = 0; i < edges.length; i++) {
          const edge = edges[i];
          const src = latest.get(edge.source);
          const tgt = latest.get(edge.target);
          if (src) posAttr.setXYZ(i * 2, src[0], src[1], src[2]);
          if (tgt) posAttr.setXYZ(i * 2 + 1, tgt[0], tgt[1], tgt[2]);
        }
        posAttr.needsUpdate = true;
      },
    }),
    [geometry, edges],
  );

  return <lineSegments ref={lineRef} geometry={geometry} material={material} frustumCulled />;
});
