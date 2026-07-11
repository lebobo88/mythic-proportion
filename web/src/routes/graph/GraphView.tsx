import { useEffect, useRef, useState } from "react";
import { fetchGraph, type GraphData } from "../../lib/api";
import { subscribeGraphColors, type GraphColors, type GraphNodeType } from "../../lib/graph-colors";
import "./graph.css";

// Graph view: renders GET /api/graph (2D for now, using the existing
// node/edge shape -- the 3D upgrade is Phase 5), styled from the
// `--graph-*` tokens. Parity target for the legacy #view-graph canvas force
// layout (see src/mythic_proportion/web/static/app.js `loadGraph`/
// `runGraphSimulation`/`drawGraph`) -- same physics constants, same
// click/drag interaction, same "never blank on a slow/failed fetch"
// resilience, ported from vanilla canvas to a React-owned canvas ref.
interface SimNode {
  id: string;
  label: string;
  type: string;
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

export function GraphView({ onOpenPage }: { onOpenPage: (path: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const dragNodeRef = useRef<SimNode | null>(null);
  const colorsRef = useRef<GraphColors | null>(null);
  const [statusHint, setStatusHint] = useState<string | null>(null);

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

    const unsubscribeColors = subscribeGraphColors((colors) => {
      colorsRef.current = colors;
    });

    function applyGraphData(data: GraphData) {
      if (!canvas) return;
      const w = canvas.width;
      const h = canvas.height;
      const existingById = Object.fromEntries(nodesRef.current.map((n) => [n.id, n]));
      const nextNodes: SimNode[] = data.nodes.map((n) => {
        const prev = existingById[n.id];
        if (prev) return { ...prev, label: n.label, type: n.type };
        return {
          id: n.id,
          label: n.label,
          type: n.type,
          x: w / 2 + (Math.random() - 0.5) * w * 0.6,
          y: h / 2 + (Math.random() - 0.5) * h * 0.6,
          vx: 0,
          vy: 0,
        };
      });
      const byId = Object.fromEntries(nextNodes.map((n) => [n.id, n]));
      nodesRef.current = nextNodes;
      edgesRef.current = data.edges
        .map((e) => ({ source: byId[e.source], target: byId[e.target] }))
        .filter((e): e is SimEdge => Boolean(e.source && e.target));
    }

    let cancelled = false;
    fetchGraph()
      .then((data) => {
        if (cancelled) return;
        applyGraphData(data);
        setStatusHint(null);
      })
      .catch(() => {
        if (!cancelled) setStatusHint("Couldn't load the graph -- retry from the Graph tab.");
      });

    function nodeColor(type: string): string {
      const colors = colorsRef.current;
      if (!colors) return "#888888";
      const key = type as GraphNodeType;
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
      const colors = colorsRef.current;
      ctx!.clearRect(0, 0, w, h);

      ctx!.strokeStyle = colors?.edge.color.getStyle() ?? "#cccccc";
      ctx!.lineWidth = 1;
      for (const edge of edgesRef.current) {
        ctx!.beginPath();
        ctx!.moveTo(edge.source.x, edge.source.y);
        ctx!.lineTo(edge.target.x, edge.target.y);
        ctx!.stroke();
      }

      ctx!.font = "11px sans-serif";
      ctx!.textAlign = "center";
      const textStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary");
      for (const node of nodesRef.current) {
        ctx!.beginPath();
        ctx!.fillStyle = nodeColor(node.type);
        ctx!.arc(node.x, node.y, 7, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = textStyle || "#111111";
        ctx!.fillText(truncateLabel(node.label), node.x, node.y - 12);
      }
    }

    function nodeAt(x: number, y: number): SimNode | null {
      for (const node of nodesRef.current) {
        const dx = node.x - x;
        const dy = node.y - y;
        if (dx * dx + dy * dy <= 12 * 12) return node;
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
      if (!dragNode) return;
      const { x, y } = canvasPoint(event);
      dragNode.x = x;
      dragNode.y = y;
      dragNode.vx = 0;
      dragNode.vy = 0;
      didDrag = true;
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
      if (node) onOpenPage(node.id);
    }

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("click", onClick);

    let handle = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
      window.removeEventListener("resize", resizeCanvas);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", onClick);
      unsubscribeColors();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpenPage]);

  return (
    <div className="mp-graph">
      {statusHint ? <p className="mp-graph-hint">{statusHint}</p> : null}
      <div className="mp-graph-canvas-wrap">
        <canvas ref={canvasRef} className="mp-graph-canvas" />
      </div>
    </div>
  );
}
