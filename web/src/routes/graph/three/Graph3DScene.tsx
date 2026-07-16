// R3F Canvas root for the 3D graph (deliverables 1/6/11): owns the
// ForceLayoutClient (Web-Worker-backed simulation), the single per-frame
// position-application pass (refs only), GPU/BVH picking dispatch, adaptive
// DPR, and camera focus/fit. NEVER calls setState from inside useFrame --
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
import { NodeLabels, type NodeLabelsHandle } from "./NodeLabels";
import { CommunityHulls } from "./CommunityHulls";
import { CameraRig, type GraphFitRequest } from "./CameraRig";

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
  const labelsHandleRef = useRef<NodeLabelsHandle>(null);
  const layoutRef = useRef<ForceLayoutClient | null>(null);

  // id -> offset-into-`positions` cache, rebuilt only when the worker's
  // node ordering changes (`revision`) -- NOT once per tick (reflexion
  // critique item 2: this is what lets InstancedEdges.applyPositions stay
  // O(visible edges) without allocating a fresh Map every tick).
  const idIndexCacheRef = useRef<{ revision: number; map: Map<string, number> }>({
    revision: -1,
    map: new Map(),
  });

  // Zero-allocation position snapshot (Codex finding): a SINGLE reused flat
  // Float32Array, bulk-copied (`.set(positions)`) once per tick -- never a
  // fresh `[x, y, z]` tuple allocated per node per tick. Discrete (non-hot-
  // path) consumers -- selection focus, camera fit-to-graph, community hulls
  // -- read out of it via `positionsAccessorRef.current.get(id)`, which DOES
  // allocate a small tuple per call, but only on their own low-frequency
  // triggers (a selection change, an "end" event, an 800ms interval), never
  // once per tick/frame.
  const latestPositionsBufferRef = useRef<Float32Array>(new Float32Array(0));
  const positionsAccessorRef = useRef({
    get(id: string): [number, number, number] | undefined {
      const idx = idIndexCacheRef.current.map.get(id);
      if (idx === undefined) return undefined;
      const buf = latestPositionsBufferRef.current;
      return [buf[idx * 3], buf[idx * 3 + 1], buf[idx * 3 + 2]];
    },
  });

  const visibleIdsRef = useRef(visibleIds);
  visibleIdsRef.current = visibleIds;

  const [focusTarget, setFocusTarget] = useState<[number, number, number] | null>(null);
  const [fitRequest, setFitRequest] = useState<GraphFitRequest | null>(null);
  const fitNonceRef = useRef(0);

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
      labelsHandleRef.current?.applyPositions(positions, ids);

      // Bulk copy into the single reused buffer -- ZERO per-node allocation
      // (Codex finding: this used to allocate a fresh per-node position
      // tuple keyed by id on every tick).
      let buf = latestPositionsBufferRef.current;
      if (buf.length !== positions.length) {
        buf = new Float32Array(positions.length);
        latestPositionsBufferRef.current = buf;
      }
      buf.set(positions);

      layout.releaseBuffer(positions.buffer as ArrayBuffer);
    });
    return unsubscribe;
  }, [layout]);

  // Camera fit-to-graph (Issue 2, BLOCKING): once the worker's layout
  // settles (`onEngineStop` -- the simulation's own "end" event, fired when
  // alpha decays below its threshold), compute the bounding sphere of the
  // currently-rendered (disclosed/visible) nodes and frame the camera to
  // fit it. Fires again whenever `layout.init`/`update` restarts the sim
  // below (dataset change), so a data reload always re-fits too. This is a
  // discrete, low-frequency event handler -- NOT part of the per-tick path.
  useEffect(() => {
    return layout.onEnd(() => {
      const ids = visibleIdsRef.current;
      const indexMap = idIndexCacheRef.current.map;
      const buf = latestPositionsBufferRef.current;
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      let count = 0;
      for (const [id, idx] of indexMap) {
        if (!ids.has(id)) continue;
        const x = buf[idx * 3];
        const y = buf[idx * 3 + 1];
        const z = buf[idx * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        count++;
      }
      if (count === 0) return;
      const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
      const dx = maxX - minX;
      const dy = maxY - minY;
      const dz = maxZ - minZ;
      const radius = Math.max(8, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2);
      fitNonceRef.current += 1;
      setFitRequest({ center, radius, nonce: fitNonceRef.current });
    });
  }, [layout]);

  // Re-heat ONLY on data change (deliverable 5) -- not on filter/selection
  // changes. `nodes`/`edges` here are the FULL dataset GraphView owns (not
  // the disclosed/rendered subset below), so toggling a filter or expanding
  // a node's neighbors never restarts the physics simulation.
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
  // zero-allocation buffer above via `positionsAccessorRef`.
  useEffect(() => {
    if (!selectedId) return;
    const pos = positionsAccessorRef.current.get(selectedId);
    if (pos) setFocusTarget(pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Issue 3a (BLOCKING, GPU-footprint/context-loss hardening): only the
  // DISCLOSED/visible subset (bounded by GraphView's progressive-disclosure
  // cap + expanded neighbors) is ever pushed into the InstancedMesh2/edge
  // buffers/label layer -- the full 10k/50k `nodes`/`edges` above stay
  // reserved for the (off-main-thread) physics worker only. This is what
  // actually keeps GPU instance/buffer counts bounded regardless of total
  // dataset size, instead of relying solely on a per-instance `visible`
  // flag (which still allocated GPU-side storage for every node).
  const renderedNodes = useMemo(() => nodes.filter((n) => visibleIds.has(n.id)), [nodes, visibleIds]);
  const renderedEdges = useMemo(
    () => edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds],
  );

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={0.7} />
      <InstancedNodes
        ref={nodesHandleRef}
        nodes={renderedNodes}
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
        nodes={renderedNodes}
        edges={renderedEdges}
        visibleIds={visibleIds}
        colors={colors}
        selectedId={selectedId}
        hoveredId={hoveredId}
        neighborIds={neighborIds}
      />
      <NodeLabels
        ref={labelsHandleRef}
        nodes={renderedNodes}
        colors={colors}
        selectedId={selectedId}
        hoveredId={hoveredId}
      />
      <CommunityHulls nodes={renderedNodes} visibleIds={visibleIds} colors={colors} positionsRef={positionsAccessorRef} />
      <CameraRig focusTarget={focusTarget} fitRequest={fitRequest} />
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
