// REQUIRED 2D fallback mode (deliverable 9) -- low-end/battery/accessible
// path, a toggle away from the 3D scene at all times. This is the same
// canvas-based force simulation the pre-Phase-5 GraphView used (physics
// constants, click/drag interaction, "never blank on a slow/failed fetch"
// resilience all carried forward unchanged), now driven off `VizNode[]`
// (adds degree-scaled radius + community/kind-aware coloring) and wired to
// the shared hover/select callbacks GraphView also feeds the 3D scene and
// the a11y tree.
import { useEffect, useRef } from "react";
import type { GraphColors } from "../../lib/graph-colors";
import type { VizEdge, VizNode } from "./types";

interface SimNode {
  id: string;
  label: string;
  type: string;
  kind?: "page" | "entity";
  community: number;
  size: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}
interface SimEdge {
  source: SimNode;
  target: SimNode;
}

const REPULSION = 2600;
const SPRING = 0.02;
const SPRING_LEN = 110;
const DAMPING = 0.85;
const CENTER_PULL = 0.01;

function truncateLabel(label: string): string {
  return label.length > 24 ? `${label.slice(0, 22)}...` : label;
}

export function Graph2DFallback({
  nodes,
  edges,
  visibleIds,
  colors,
  selectedId,
  hoveredId,
  onHoverNode,
  onSelectNode,
}: {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleIds: Set<string>;
  colors: GraphColors | null;
  selectedId: string | null;
  hoveredId: string | null;
  onHoverNode: (id: string | null) => void;
  onSelectNode: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const dragNodeRef = useRef<SimNode | null>(null);
  const stateRef = useRef({ selectedId, hoveredId, visibleIds, colors });
  stateRef.current = { selectedId, hoveredId, visibleIds, colors };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function resizeCanvas() {
      if (!canvas) return;
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    const w0 = canvas.width;
    const h0 = canvas.height;
    const existingById = Object.fromEntries(nodesRef.current.map((n) => [n.id, n]));
    const nextNodes: SimNode[] = nodes.map((n) => {
      const prev = existingById[n.id];
      if (prev) return { ...prev, label: n.label, type: n.type, kind: n.kind, community: n.community, size: n.size };
      return {
        id: n.id,
        label: n.label,
        type: n.type,
        kind: n.kind,
        community: n.community,
        size: n.size,
        x: w0 / 2 + (Math.random() - 0.5) * w0 * 0.6,
        y: h0 / 2 + (Math.random() - 0.5) * h0 * 0.6,
        vx: 0,
        vy: 0,
      };
    });
    const byId = Object.fromEntries(nextNodes.map((n) => [n.id, n]));
    nodesRef.current = nextNodes;
    edgesRef.current = edges
      .map((e) => ({ source: byId[e.source], target: byId[e.target] }))
      .filter((e): e is SimEdge => Boolean(e.source && e.target));

    function nodeColor(node: SimNode): string {
      const colors = stateRef.current.colors;
      if (!colors) return "#888888";
      if (node.kind === "entity") {
        // Phase 4c (plan Section 6.5 item 5): modulo the GENERATED array's
        // own length, not a hardcoded 8 -- `colors.community` is now sized
        // to the dataset's actual distinct community count (see
        // `readGraphColors`), so this keeps working correctly at 16, 32, or
        // whatever count a real vault's Leiden clustering produces, instead
        // of silently wrapping every community back into 8 buckets.
        return colors.community[node.community % colors.community.length]?.color.getStyle() ?? "#888888";
      }
      const key = node.type as keyof GraphColors["node"];
      return colors.node[key]?.color.getStyle() ?? "#888888";
    }

    function tick() {
      const w = canvas!.width;
      const h = canvas!.height;
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const dragNode = dragNodeRef.current;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (a === dragNode) continue;
        let fx = 0;
        let fy = 0;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = dx * dx + dy * dy || 0.01;
          const force = REPULSION / distSq;
          const dist = Math.sqrt(distSq);
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }
        fx += (w / 2 - a.x) * CENTER_PULL;
        fy += (h / 2 - a.y) * CENTER_PULL;
        a.vx = (a.vx + fx) * DAMPING;
        a.vy = (a.vy + fy) * DAMPING;
      }

      for (const edge of edges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (dist - SPRING_LEN) * SPRING;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (edge.source !== dragNode) {
          edge.source.vx += fx;
          edge.source.vy += fy;
        }
        if (edge.target !== dragNode) {
          edge.target.vx -= fx;
          edge.target.vy -= fy;
        }
      }

      for (const n of nodes) {
        if (n === dragNode) continue;
        n.x += n.vx * 0.02;
        n.y += n.vy * 0.02;
        n.x = Math.max(20, Math.min(w - 20, n.x));
        n.y = Math.max(20, Math.min(h - 20, n.y));
      }

      draw();
      handle = requestAnimationFrame(tick);
    }

    function draw() {
      const w = canvas!.width;
      const h = canvas!.height;
      const { selectedId, hoveredId, visibleIds, colors } = stateRef.current;
      ctx!.clearRect(0, 0, w, h);

      ctx!.strokeStyle = colors?.edge.color.getStyle() ?? "#cccccc";
      ctx!.lineWidth = 1;
      for (const edge of edgesRef.current) {
        if (!visibleIds.has(edge.source.id) || !visibleIds.has(edge.target.id)) continue;
        ctx!.beginPath();
        ctx!.moveTo(edge.source.x, edge.source.y);
        ctx!.lineTo(edge.target.x, edge.target.y);
        ctx!.stroke();
      }

      ctx!.font = "11px sans-serif";
      ctx!.textAlign = "center";
      const textStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary");

      // Draw every visible node's circle unconditionally (unchanged).
      for (const node of nodesRef.current) {
        if (!visibleIds.has(node.id)) continue;
        const isFocused = node.id === selectedId || node.id === hoveredId;
        ctx!.globalAlpha = selectedId || hoveredId ? (isFocused ? 1 : 0.25) : 1;
        ctx!.beginPath();
        ctx!.fillStyle = nodeColor(node);
        ctx!.arc(node.x, node.y, 5 + node.size * 2, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;

      // Browser-audit item 8 (cosmetic, live-Chrome finding): draw labels in
      // a SEPARATE, priority-ordered pass with simple AABB collision
      // avoidance -- close nodes' labels (e.g. "TEXAS" and "ACME ROBOTICS")
      // previously always drew unconditionally at every visible node's
      // position with no overlap check at all. Priority: the
      // selected/hovered node's label always wins (never suppressed), then
      // larger/higher-degree nodes take priority over smaller ones, so the
      // same node's label is suppressed consistently frame-to-frame rather
      // than flickering. A skipped label's node circle above is still drawn
      // (only the text is suppressed), and its full label remains available
      // via hover/selection and the accessibility tree.
      ctx!.fillStyle = textStyle || "#111111";
      const placedLabelBoxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
      const labelCandidates = nodesRef.current
        .filter((node) => visibleIds.has(node.id))
        .sort((a, b) => {
          const aFocused = a.id === selectedId || a.id === hoveredId;
          const bFocused = b.id === selectedId || b.id === hoveredId;
          if (aFocused !== bFocused) return aFocused ? -1 : 1;
          return b.size - a.size;
        });
      for (const node of labelCandidates) {
        const isFocused = node.id === selectedId || node.id === hoveredId;
        const label = truncateLabel(node.label);
        const halfWidth = ctx!.measureText(label).width / 2;
        const labelY = node.y - 12;
        const box = { x1: node.x - halfWidth, x2: node.x + halfWidth, y1: labelY - 9, y2: labelY + 3 };
        const overlapsPlaced = placedLabelBoxes.some(
          (p) => box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1,
        );
        if (overlapsPlaced && !isFocused) continue;
        placedLabelBoxes.push(box);
        ctx!.globalAlpha = selectedId || hoveredId ? (isFocused ? 1 : 0.25) : 1;
        ctx!.fillText(label, node.x, labelY);
      }
      ctx!.globalAlpha = 1;
    }

    function nodeAt(x: number, y: number): SimNode | null {
      for (const node of nodesRef.current) {
        if (!stateRef.current.visibleIds.has(node.id)) continue;
        const dx = node.x - x;
        const dy = node.y - y;
        const r = 5 + node.size * 2 + 5;
        if (dx * dx + dy * dy <= r * r) return node;
      }
      return null;
    }

    function canvasPoint(event: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    let didDrag = false;
    function onMouseDown(event: MouseEvent) {
      const { x, y } = canvasPoint(event);
      const node = nodeAt(x, y);
      if (node) {
        dragNodeRef.current = node;
        didDrag = false;
      }
    }
    function onMouseMove(event: MouseEvent) {
      const dragNode = dragNodeRef.current;
      const { x, y } = canvasPoint(event);
      if (dragNode) {
        dragNode.x = x;
        dragNode.y = y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        didDrag = true;
        return;
      }
      onHoverNode(nodeAt(x, y)?.id ?? null);
    }
    function onMouseUp() {
      dragNodeRef.current = null;
    }
    function onClick(event: MouseEvent) {
      if (didDrag) {
        didDrag = false;
        return;
      }
      const { x, y } = canvasPoint(event);
      const node = nodeAt(x, y);
      if (node) onSelectNode(node.id);
    }

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("click", onClick);

    let handle = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(handle);
      window.removeEventListener("resize", resizeCanvas);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  return (
    <div className="mp-graph-canvas-wrap">
      <canvas ref={canvasRef} className="mp-graph-canvas" />
    </div>
  );
}
