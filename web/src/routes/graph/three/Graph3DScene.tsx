// R3F Canvas root for the 3D graph (deliverables 1/6/11): owns the
// ForceLayoutClient (Web-Worker-backed simulation), the single per-frame
// position-application pass (refs only), GPU/BVH picking dispatch, adaptive
// DPR, and camera focus. NEVER calls setState from inside useFrame --
// discrete UI state (selected/hovered/filters) lives in GraphView.tsx and
// flows down as props; this file only mutates GPU-facing refs each frame.
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr, OrbitControls, PerformanceMonitor } from "@react-three/drei";
import type { GraphColors } from "../../../lib/graph-colors";
import type { VizEdge, VizNode } from "../types";
import { createForceLayoutWorker, ForceLayoutClient } from "./ForceLayoutClient";
import { InstancedNodes, type InstancedNodesHandle } from "./InstancedNodes";
import { InstancedEdges, type InstancedEdgesHandle } from "./InstancedEdges";
import { CommunityHulls } from "./CommunityHulls";
import { CameraRig } from "./CameraRig";

export interface Graph3DSceneProps {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleIds: Set<string>;
  colors: GraphColors;
  selectedId: string | null;
  hoveredId: string | null;
  neighborIds: Set<string>;
  onHoverNode: (id: string | null) => void;
  onSelectNode: (id: string) => void;
  /** Dev/test hook: called with each PerformanceMonitor fps sample -- never asserted as a hard budget (see graphPerf tests). */
  onFpsSample?: (fps: number) => void;
  /**
   * REQUIRED graceful-degradation floor (reflexion critique item 4): fired
   * on a `webglcontextlost` event OR a WebGL renderer creation failure, so
   * the caller (GraphView) can auto-switch to the 2D fallback WITHOUT
   * requiring the user to notice and click the manual toggle themselves.
   */
  onContextLost?: () => void;
}

/** Catches synchronous WebGLRenderer-construction failures from `<Canvas>` (some
 *  browsers/drivers throw rather than firing `webglcontextlost`) and reports
 *  them the same way as a live context loss. */
class WebglErrorBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function SceneContents({
  nodes,
  edges,
  visibleIds,
  colors,
  selectedId,
  hoveredId,
  neighborIds,
  onHoverNode,
  onSelectNode,
}: Omit<Graph3DSceneProps, "onFpsSample">) {
  const nodesHandleRef = useRef<InstancedNodesHandle>(null);
  const edgesHandleRef = useRef<InstancedEdgesHandle>(null);
  const latestPositionsRef = useRef(new Map<string, [number, number, number]>());
  const layoutRef = useRef<ForceLayoutClient | null>(null);
  // id -> offset-into-`positions` cache, rebuilt only when the worker's
  // node ordering changes (`revision`) -- NOT once per tick (reflexion
  // critique item 2: this is what lets InstancedEdges.applyPositions stay
  // O(visible edges) without allocating a fresh Map every tick).
  const idIndexCacheRef = useRef<{ revision: number; map: Map<string, number> }>({
    revision: -1,
    map: new Map(),
  });
  const [focusTarget, setFocusTarget] = useState<[number, number, number] | null>(null);

  const layout = useMemo(() => new ForceLayoutClient(createForceLayoutWorker()), []);

  useEffect(() => {
    layoutRef.current = layout;
    return () => layout.dispose();
  }, [layout]);

  useEffect(() => {
    const unsubscribe = layout.onTick((positions, ids, _alpha, revision) => {
      const cache = idIndexCacheRef.current;
      if (cache.revision !== revision) {
        const map = new Map<string, number>();
        for (let i = 0; i < ids.length; i++) map.set(ids[i], i);
        idIndexCacheRef.current = { revision, map };
      }
      nodesHandleRef.current?.applyPositions(positions, ids);
      edgesHandleRef.current?.applyPositions(positions, idIndexCacheRef.current.map);
      const map = latestPositionsRef.current;
      for (let i = 0; i < ids.length; i++) {
        map.set(ids[i], [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      }
      layout.releaseBuffer(positions.buffer as ArrayBuffer);
    });
    return unsubscribe;
  }, [layout]);

  // Re-heat ONLY on data change (deliverable 5) -- not on filter/selection changes.
  useEffect(() => {
    const workerNodes = nodes.map((n) => ({ id: n.id }));
    const workerLinks = edges.map((e) => ({ source: e.source, target: e.target }));
    if (nodes.length === 0) return;
    layout.init(workerNodes, workerLinks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, nodes, edges]);

  useFrame(() => {
    // Positions are applied from the worker's "tick" event, not from this
    // hook -- this useFrame exists only as the documented "R3F owns the
    // render loop" seam (kept intentionally empty of any setState calls).
  });

  // Camera focus (deliverable 7): a DISCRETE state transition (fires once
  // per selection change, not per frame) -- not the "never setState in
  // useFrame" hot path. Reads the node's current position out of the
  // imperative `latestPositionsRef` the tick subscriber above maintains.
  useEffect(() => {
    if (!selectedId) return;
    const pos = latestPositionsRef.current.get(selectedId);
    if (pos) setFocusTarget(pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={0.7} />
      <InstancedNodes
        ref={nodesHandleRef}
        nodes={nodes}
        visibleIds={visibleIds}
        colors={colors}
        selectedId={selectedId}
        hoveredId={hoveredId}
        neighborIds={neighborIds}
        onHoverNode={onHoverNode}
        onSelectNode={onSelectNode}
      />
      <InstancedEdges
        ref={edgesHandleRef}
        nodes={nodes}
        edges={edges}
        visibleIds={visibleIds}
        colors={colors}
        selectedId={selectedId}
        hoveredId={hoveredId}
        neighborIds={neighborIds}
      />
      <CommunityHulls nodes={nodes} visibleIds={visibleIds} colors={colors} positionsRef={latestPositionsRef} />
      <CameraRig focusTarget={focusTarget} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
    </>
  );
}

export function Graph3DScene(props: Graph3DSceneProps) {
  const { onFpsSample, onContextLost, ...sceneProps } = props;
  const reported = useRef(false);
  const report = () => {
    if (reported.current) return;
    reported.current = true;
    onContextLost?.();
  };
  return (
    <WebglErrorBoundary onError={report}>
      <Canvas
        camera={{ position: [0, 0, 60], far: 4000 }}
        dpr={[0.75, 2]}
        onCreated={(state) => {
          // Auto-fallback floor (critique item 4): a live context loss --
          // driver crash, GPU reset, tab backgrounding on some mobile
          // browsers -- fires this event on the WebGLRenderer's canvas;
          // WebGL creation *failure* is caught by WebglErrorBoundary above.
          state.gl.domElement.addEventListener("webglcontextlost", (event) => {
            event.preventDefault();
            report();
          });
        }}
      >
        <PerformanceMonitor onChange={({ fps }) => onFpsSample?.(fps)}>
          <AdaptiveDpr pixelated />
          <Suspense fallback={null}>
            <SceneContents {...sceneProps} />
          </Suspense>
        </PerformanceMonitor>
      </Canvas>
    </WebglErrorBoundary>
  );
}
