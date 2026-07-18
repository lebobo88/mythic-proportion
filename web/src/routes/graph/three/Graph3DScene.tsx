// R3F Canvas root for the 3D graph (deliverables 1/6/11): owns the
// ForceLayoutClient (Web-Worker-backed simulation), the single per-frame
// position-application pass (refs only), GPU/BVH picking dispatch, adaptive
// DPR, and camera focus/fit. NEVER calls setState from inside useFrame --
// discrete UI state (selected/hovered/filters) lives in GraphView.tsx and
// flows down as props; this file only mutates GPU-facing refs each frame.
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, OrbitControls, PerformanceMonitor } from "@react-three/drei";
import { ACESFilmicToneMapping } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import type { GraphMode, VizEdge, VizNode } from "../types";
import { neighborsOf } from "../graphMath";
import { prefersReducedMotion } from "../../../lib/motion";
import { useForceLayoutWorker } from "./useForceLayoutWorker";
import { InstancedNodes, type InstancedNodesHandle } from "./InstancedNodes";
import { InstancedEdges, type InstancedEdgesHandle } from "./InstancedEdges";
import { NodeLabels, type NodeLabelsHandle } from "./NodeLabels";
import { CommunityHulls } from "./CommunityHulls";
import { CameraRig, type GraphFitRequest } from "./CameraRig";
import { TerrainSurface } from "./TerrainSurface";
import { blendPositions, isTransitionActive, startModeTransition, type ModeTransitionState } from "./modeTransition";
import type { ElevationPoint } from "./terrainElevation";

export interface BoundingSphereFit {
  center: [number, number, number];
  radius: number;
  /**
   * T2 remediation (Finding 1 -- Terrain camera-fit "thin sliver near the
   * horizon" bug at scale). Full per-axis world-space extent (max-min) of
   * the same points `center`/`radius` were computed from -- `[dx, dy, dz]`.
   * Optional so every pre-existing caller/test that only destructures
   * `center`/`radius` is unaffected. See `resolveFlatShapeElevation` in
   * `CameraRig.tsx` for why this additional per-axis data is needed: a
   * single isotropic radius cannot tell a roughly cube-shaped bounding
   * volume (any viewing direction frames it fine) apart from a flat,
   * pancake-shaped one (only an elevated viewing direction frames it
   * legibly) -- Terrain's bounding volume becomes exactly that flat shape
   * at scale, because its heightfield's y-range is a fixed constant
   * (`TERRAIN_MAX_HEIGHT`) while its x/z footprint grows with node count.
   */
  extent: [number, number, number];
}

/**
 * World-space bounding sphere (center + radius) of every currently-visible
 * node's latest tick position. Pure/exported so it can be exercised directly
 * against multiple graph shapes (see graphPerf.synthetic.test.ts's T2
 * remediation coverage) instead of only indirectly via source-regex
 * matching. Returns `null` when no visible node has a known position yet
 * (worker hasn't ticked, or every visible id fell out of the latest tick's
 * id set) -- callers simply skip issuing a fit request in that case, exactly
 * as before this extraction.
 *
 * `radius` is floored at 8 world units so a near-degenerate (near-zero-
 * extent) graph still gets a sane, non-zero fit distance instead of parking
 * the camera uncomfortably close (see `computeFitDistance` in CameraRig.tsx,
 * which is the actual scale-responsive half of the fit -- this floor only
 * guards the true-zero-extent edge case, it does not re-tune per shape).
 */
export function computeBoundingSphere(
  indexMap: Map<string, number>,
  positions: Float32Array,
  visibleIds: Set<string>,
): BoundingSphereFit | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let count = 0;
  for (const [id, idx] of indexMap) {
    if (!visibleIds.has(id)) continue;
    const x = positions[idx * 3];
    const y = positions[idx * 3 + 1];
    const z = positions[idx * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    count++;
  }
  if (count === 0) return null;
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const radius = Math.max(8, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2);
  return { center, radius, extent: [dx, dy, dz] };
}

/**
 * T2 remediation (bounded remediation, second and final attempt on the
 * residual edge-on-framing defect -- see `resolveFitViewDirection` in
 * `CameraRig.tsx` for the full root cause, evidence trail, and how this
 * value is consumed). Returns the dominant direction of a SMALL focus set
 * (at most 3 points) -- the pair among `ids` with the greatest pairwise
 * distance, as a raw (non-normalized) direction vector -- or `null` when
 * that is not a meaningful/safe computation to make: fewer than 2 resolved
 * points, or more than 3 points.
 *
 * Deliberately bounded to small sets: this app's canonical repro is exactly
 * a degree-1 node plus its single neighbor (2 points), and the finding's own
 * scope note explicitly allows "e.g. ~2-3 points" for this correction. An
 * all-pairs scan is O(n^2) and is intentionally NEVER run against a large
 * focus set -- the whole-graph fit path (`onEnd` below) never calls this
 * function at all, so a large/roomy focus set keeps the already-confirmed-
 * working general fit behavior (preserving the camera's existing viewing
 * direction) completely untouched.
 */
export function computeFocusAxis(
  indexMap: Map<string, number>,
  positions: Float32Array,
  ids: Set<string>,
): [number, number, number] | null {
  if (ids.size < 2 || ids.size > 3) return null;
  const pts: [number, number, number][] = [];
  for (const id of ids) {
    const idx = indexMap.get(id);
    if (idx === undefined) continue;
    pts.push([positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]]);
  }
  if (pts.length < 2) return null;

  let best: [number, number, number] | null = null;
  let bestDistSq = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[i][0];
      const dy = pts[j][1] - pts[i][1];
      const dz = pts[j][2] - pts[i][2];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > bestDistSq) {
        bestDistSq = distSq;
        best = [dx, dy, dz];
      }
    }
  }
  // Coincident points (near-zero extent) carry no meaningful direction --
  // let the caller fall back to no-axis-correction behavior.
  if (!best || bestDistSq < 1e-6) return null;
  return best;
}

export interface SelectionFit extends BoundingSphereFit {
  axis: [number, number, number] | null;
}

/**
 * T3 advisory remediation (the "Meridian Logistics" framing defect, H2/H3):
 * the ONE selection-scoped fit computation, shared by the selection effect
 * (fires on click) AND the worker settle handler (`onEnd`) below. Frames the
 * selected node plus its 1-hop neighbors via the same
 * `computeBoundingSphere`/`computeFocusAxis` machinery as before -- this
 * extraction changes no fit geometry, it exists so the two call sites can
 * never disagree about what a selection fit is, and so the computation is
 * directly testable (see selectionSettleFitPriority.test.ts) without a real
 * R3F `<Canvas>`/WebGL context, exactly like `computeBoundingSphere` above.
 *
 * Returns `null` when the selected id (and every neighbor) has no resolved
 * position yet -- the first tick is still pending, or the id is not in the
 * worker's dataset at all. The settle handler's selection-aware retry is the
 * designed fallback for that case (H3): a click-time miss is re-attempted on
 * "end", once positions exist, instead of silently never fitting.
 */
export function computeSelectionFit(
  indexMap: Map<string, number>,
  positions: Float32Array,
  edges: { source: string; target: string }[],
  selectedId: string,
): SelectionFit | null {
  const focusIds = neighborsOf({ nodes: [], edges }, selectedId);
  focusIds.add(selectedId);
  const fit = computeBoundingSphere(indexMap, positions, focusIds);
  if (fit === null) return null;
  const axis = computeFocusAxis(indexMap, positions, focusIds);
  return { center: fit.center, radius: fit.radius, extent: fit.extent, axis };
}

/**
 * T2 remediation (3D graph intermittent-collapse investigation, round 3):
 * true when a tick's `revision` is OLDER than the highest revision already
 * applied to GPU-facing state -- see `highestAppliedRevisionRef`'s doc
 * comment inside `SceneContents`'s `useForceLayoutWorker` call for the full
 * race this guards against. Pure/exported, like `computeBoundingSphere`
 * above, so it can be exercised directly (see `graphTickStaleness.test.ts`)
 * without needing a real R3F `<Canvas>`/WebGL context, which jsdom cannot
 * provide.
 */
export function isStaleTickRevision(revision: number, highestAppliedRevision: number): boolean {
  return revision < highestAppliedRevision;
}

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
  /**
   * T2 remediation (Finding 2c): fired every time the underlying `<Canvas>`
   * successfully (re-)creates its WebGL context -- i.e. on every mount,
   * including a manual "Switch to 3D" retry after a genuine context-loss
   * fallback. Lets the caller (GraphView) clear a stale context-loss
   * announcement once 3D has actually re-rendered, instead of leaving it
   * stuck on screen forever. Optional so every other caller (tests,
   * `ModeSpikeView`) is unaffected.
   */
  onReady?: () => void;
  /**
   * Phase 4a de-risking spike (plan Section 6.3), optional and additive:
   * selects the worker's per-mode force configuration and, on a change from
   * the previous mode, starts a bounded/interruptible matrix-interpolation
   * transition (M1) toward the new mode's live worker output. Omitted,
   * this prop defaults to "cloud" and every mode-transition/terrain code
   * path below stays fully inert -- byte-identical to this component's
   * pre-spike behavior, which is why `GraphView.tsx` (production, Phase 4c
   * territory) needs no change to keep working exactly as before.
   */
  mode?: GraphMode;
  /**
   * Phase 4c graph state-lifecycle fix (plan Section 3.3/6.5, Section 11's
   * risk-table mitigation): `true` while GraphView is mounted-hidden (a tab
   * excursion away from Graph). Stops the R3F render loop (`Canvas
   * frameloop="never"`) so a hidden canvas never keeps burning GPU frames,
   * without tearing down the worker, the WebGL context, or any scene state
   * -- `frameloop` flips back to `"always"` the instant this goes false
   * again, resuming exactly where it left off. Optional/defaults to
   * `false` so every other caller (tests, `ModeSpikeView`) is unaffected.
   */
  paused?: boolean;
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
  mode = "cloud",
}: Omit<Graph3DSceneProps, "onFpsSample">) {
  const nodesHandleRef = useRef<InstancedNodesHandle>(null);
  const edgesHandleRef = useRef<InstancedEdgesHandle>(null);
  const labelsHandleRef = useRef<NodeLabelsHandle>(null);

  // T2 remediation (browser-audit item, pre-existing before the StrictMode
  // camera-fit fix): scroll-to-zoom produced zero camera change in both
  // prod and dev, on fresh loads, while drag-rotate -- wired by the exact
  // same `OrbitControls.connect()` call -- worked. Root cause traced into
  // `@react-three/drei`'s `OrbitControls` wrapper
  // (`node_modules/@react-three/drei/core/OrbitControls.js`): with no
  // explicit `domElement` prop, it resolves its listener target via
  // `domElement || events.connected || gl.domElement`, where
  // `events.connected` is only populated once R3F's own `<Canvas>` runs its
  // event-source layout effect -- a second, timing-dependent mount phase
  // distinct from (and racing against) this component's own `useEffect`
  // that calls `controls.connect(...)`. Reading `gl` directly via
  // `useThree` and pinning `domElement` on `<OrbitControls>` below removes
  // that indirection: the wheel/pointer listener always attaches to the
  // real, stable render canvas from the first connect, never to a
  // transitional or ambiguous target.
  const gl = useThree((state) => state.gl);

  // id -> offset-into-`positions` cache, rebuilt only when the worker's
  // node ordering changes (`revision`) -- NOT once per tick (reflexion
  // critique item 2: this is what lets InstancedEdges.applyPositions stay
  // O(visible edges) without allocating a fresh Map every tick).
  const idIndexCacheRef = useRef<{ revision: number; map: Map<string, number> }>({
    revision: -1,
    map: new Map(),
  });

  // T2 remediation (3D graph intermittent-collapse investigation, round 3):
  // a monotonic staleness guard. `revision` increments once per worker
  // `init`/`update` (see forceLayout.worker.ts's `buildSimulation`); this
  // tracks the HIGHEST revision whose tick has actually been applied so far.
  // A single Worker's own `postMessage` stream is guaranteed FIFO by the
  // platform (ticks from one live worker can never arrive out of revision
  // order), so this guard is not needed to protect against that case. It
  // exists as defense-in-depth against a DIFFERENT, real platform subtlety:
  // `Worker.terminate()` stops the worker's own thread from producing
  // further messages, but does NOT retroactively cancel a message the
  // worker already posted before termination and that is already sitting in
  // the main thread's own task queue, undelivered -- so a message from an
  // already-disposed worker generation could, in principle, still reach
  // this handler after a newer generation's ticks have already been
  // applied. `useForceLayoutWorker`'s cleanup already unsubscribes this
  // callback from ITS OWN client before terminating (see that file), which
  // covers a clean unmount; this guard additionally covers the case of two
  // live `ForceLayoutClient`s sharing this same closure across a data/mode
  // re-init (`layout.init(...)` bumps `revision` without tearing down the
  // worker at all -- see `useForceLayoutWorker`'s second effect), where a
  // slow-to-arrive tick from the PRE-re-init revision must never be allowed
  // to overwrite positions already applied from the NEW revision. See
  // `graphTickStaleness.test.ts` for direct behavioral coverage using real
  // out-of-order async delivery (a `MessageChannel`-backed fake worker, not
  // the synchronous mock most of this route's other tests use).
  const highestAppliedRevisionRef = useRef(-1);

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

  // T2 remediation (Finding 1): selection focus no longer routes through
  // CameraRig's `focusTarget` prop (see the selection effect below) -- it
  // reuses `fitRequest`'s scale-responsive bounding-sphere path instead.
  // `CameraRig` still accepts `focusTarget` (kept generic/available for a
  // future direct single-point-focus need), so `null` is passed through
  // unconditionally rather than removing the prop from CameraRig itself.
  const [fitRequest, setFitRequest] = useState<GraphFitRequest | null>(null);
  const fitNonceRef = useRef(0);

  // Phase 4a de-risking spike (plan Section 6.3, bet 1): mode-switch
  // transition state. `prevModeRef` lets the effect below tell a REAL mode
  // change apart from every other reason this component re-renders; a
  // fresh transition is only started when `mode` actually changes, never on
  // mount (there is nothing to blend FROM yet) and never spuriously on an
  // unrelated prop update.
  const transitionRef = useRef<ModeTransitionState | null>(null);
  const prevModeRef = useRef<GraphMode>(mode);
  const blendedPositionsRef = useRef<Float32Array>(new Float32Array(0));
  const [terrainPoints, setTerrainPoints] = useState<ElevationPoint[]>([]);
  // T2 remediation (bounded investigation, plan Section 6.5 closeout
  // finding -- transient "jagged black/teal" artifact in ~1/5 Orbital ->
  // Cloud mode-switch attempts, see instancedNodesLod.test.ts for the full
  // root-cause evidence): a REACTIVE mirror of "a transition is in flight",
  // needed ONLY so InstancedNodes' LOD-rescale effect (prop-identity-keyed)
  // actually re-runs when a transition starts/ends -- `transitionRef` alone
  // (a ref) never triggers a re-render, so InstancedNodes would never see
  // the change. This is a discrete start/stop signal, set at most twice per
  // transition (never per-tick) -- never read inside the per-tick hot path
  // itself, which still reads `transitionRef.current` exactly as before.
  const [transitioning, setTransitioning] = useState(false);

  useEffect(() => {
    if (prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    const snapshotIds = Array.from(idIndexCacheRef.current.map.keys());
    if (snapshotIds.length === 0) {
      // Nothing rendered yet (e.g. mode switched before the first tick) --
      // nothing to blend from, so the new mode's positions simply apply
      // directly once they arrive.
      transitionRef.current = null;
      return;
    }
    // Reduced-motion path (design handoff M1/deliverable 10): a
    // `durationMs` of 0 makes `transitionAlpha` resolve to 1 immediately
    // (see modeTransition.ts), i.e. an instant cross-fade with NO position
    // interpolation -- never auto-2D here specifically (GraphView already
    // owns the auto-2D-under-reduced-motion default at mount; this is the
    // "instant/cross-fade" alternative the design handoff also permits for
    // an in-session mode switch while already in 3D mode).
    const durationMs = prefersReducedMotion() ? 0 : undefined;
    const started = startModeTransition(
      snapshotIds,
      latestPositionsBufferRef.current,
      performance.now(),
      durationMs,
    );
    transitionRef.current = started;
    // Only a REAL (non-instant) blend window needs the LOD-suppression
    // mitigation -- the reduced-motion path resolves to alpha 1 immediately,
    // so there is no blend window during which a stale threshold could ever
    // be exceeded.
    setTransitioning(started.durationMs > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Terrain surface feed (bet 2): rebuilt on the SAME low-frequency
  // interval `CommunityHulls.tsx` already uses for its own coarse,
  // non-per-tick recompute -- never inside the per-tick path above.
  useEffect(() => {
    if (mode !== "terrain") {
      setTerrainPoints((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const id = window.setInterval(() => {
      const points: ElevationPoint[] = [];
      for (const node of nodes) {
        if (!visibleIdsRef.current.has(node.id)) continue;
        const pos = positionsAccessorRef.current.get(node.id);
        if (!pos) continue;
        points.push({ x: pos[0], z: pos[2], weight: node.centrality ?? 0.1 });
      }
      setTerrainPoints(points);
    }, 800);
    return () => window.clearInterval(id);
  }, [mode, nodes]);

  // Worker lifecycle (T2 remediation root-cause fix -- see the T2 job
  // report, and `graphPerf.synthetic.test.ts`'s "worker lifecycle survives
  // React 18 StrictMode's dev-mode double-invoke" describe block for the
  // dedicated StrictMode regression coverage -- there is no separate
  // `useForceLayoutWorker.strictmode.test.tsx` file): delegated entirely to
  // `useForceLayoutWorker`, which creates AND disposes the Worker inside a
  // single effect (never `useMemo`) so React 18 StrictMode's dev-mode
  // mount -> cleanup -> remount dance always ends up with a live Worker,
  // never a wrapper around one it already terminated. `nodes`/`edges` here
  // are the FULL dataset GraphView owns (not the disclosed/rendered subset
  // below), so toggling a filter or expanding a node's neighbors never
  // restarts the physics simulation.
  useForceLayoutWorker(nodes, edges, {
    onTick: (positions, ids, _alpha, revision, layout) => {
      // Staleness guard (see `highestAppliedRevisionRef`'s doc comment
      // above): a tick from an OLDER generation than the newest one already
      // applied is discarded outright -- still handed back to its OWN
      // worker for recycling (a no-op if that worker is already
      // terminated), but never applied to any GPU-facing state, the
      // id-index cache, or the position snapshot.
      if (isStaleTickRevision(revision, highestAppliedRevisionRef.current)) {
        layout.releaseBuffer(positions.buffer as ArrayBuffer);
        return;
      }
      highestAppliedRevisionRef.current = revision;

      const cache = idIndexCacheRef.current;
      if (cache.revision !== revision) {
        const map = new Map<string, number>();
        for (let i = 0; i < ids.length; i++) map.set(ids[i], i);
        idIndexCacheRef.current = { revision, map };
      }

      // Phase 4a spike (bet 1, M1): while a mode-switch transition is in
      // flight, blend the raw worker output toward it instead of applying
      // it directly. `positions` itself is UNCHANGED either way -- this
      // never mutates the worker's own transferable buffer, only reads
      // from it into the (reused) blended buffer -- so releasing it back
      // to the worker below is unaffected.
      let applied = positions;
      const transition = transitionRef.current;
      if (transition) {
        const now = performance.now();
        if (isTransitionActive(transition, now)) {
          let blended = blendedPositionsRef.current;
          if (blended.length !== positions.length) {
            blended = new Float32Array(positions.length);
            blendedPositionsRef.current = blended;
          }
          blendPositions(transition, ids, positions, now, blended);
          applied = blended;
        } else {
          transitionRef.current = null;
          // Discrete, once-per-transition completion event (see the
          // `transitioning` state's doc comment above) -- this branch only
          // executes on the single tick where the blend actually finishes,
          // never on every tick, since `transition` is read from
          // `transitionRef.current` and is nulled out immediately above.
          setTransitioning(false);
        }
      }

      nodesHandleRef.current?.applyPositions(applied, ids);
      edgesHandleRef.current?.applyPositions(applied, idIndexCacheRef.current.map);
      labelsHandleRef.current?.applyPositions(applied, ids);

      // Bulk copy into the single reused buffer -- ZERO per-node allocation
      // (Codex finding: this used to allocate a fresh per-node position
      // tuple keyed by id on every tick).
      let buf = latestPositionsBufferRef.current;
      if (buf.length !== applied.length) {
        buf = new Float32Array(applied.length);
        latestPositionsBufferRef.current = buf;
      }
      buf.set(applied);

      layout.releaseBuffer(positions.buffer as ArrayBuffer);
    },
    // Camera fit-to-graph (Issue 2, BLOCKING): once the worker's layout
    // settles (`onEngineStop` -- the simulation's own "end" event, fired
    // when alpha decays below its threshold), compute the bounding sphere
    // of the currently-rendered (disclosed/visible) nodes and frame the
    // camera to fit it. Fires again whenever `layout.init`/`update`
    // restarts the sim (dataset change), so a data reload always re-fits
    // too. This is a discrete, low-frequency event handler -- NOT part of
    // the per-tick path. Also fires on every mode switch (M3): the mode
    // change reinitializes the worker, which reliably reaches a fresh
    // "end" once the new mode's physics settles, reusing this exact path
    // rather than a mode-specific camera re-fit.
    onEnd: () => {
      // Settle-fit vs selection-fit sequencing (T3 advisory H2): this
      // handler and the selection effect below share one
      // `fitNonceRef`/`setFitRequest` with no ordering guarantee, so a
      // late-arriving settle event (the sim still cooling when the user
      // clicked) used to stomp an active user-selection fit with a
      // whole-graph fit -- the observed "reverted to whole-graph view"
      // failure shape. While a node is selected, the settle event now
      // re-issues the SELECTION fit with the freshly settled positions
      // (strictly better than suppressing: post-settle positions have
      // moved, and a mode switch's own settle re-fit keeps honoring the
      // framed camera target, per journey 1). This is also the designed H3
      // retry: a click that landed before the first tick (no position yet,
      // `computeSelectionFit` returned null) gets its fit here instead of
      // silently never fitting. The whole-graph fit still runs when nothing
      // is selected, or when the selection has no resolvable position at
      // all (an id outside the worker's dataset) -- a whole-graph frame
      // beats no frame. The `selectedId`/`edges` props read here are always
      // current: `useForceLayoutWorker` re-reads its handlers object per
      // event via `handlersRef`, never a mount-time closure.
      if (selectedId) {
        const selectionFit = computeSelectionFit(
          idIndexCacheRef.current.map,
          latestPositionsBufferRef.current,
          edges,
          selectedId,
        );
        if (selectionFit) {
          fitNonceRef.current += 1;
          setFitRequest({
            center: selectionFit.center,
            radius: selectionFit.radius,
            nonce: fitNonceRef.current,
            axis: selectionFit.axis,
            extent: selectionFit.extent,
          });
          return;
        }
      }
      const fit = computeBoundingSphere(
        idIndexCacheRef.current.map,
        latestPositionsBufferRef.current,
        visibleIdsRef.current,
      );
      if (!fit) return;
      fitNonceRef.current += 1;
      setFitRequest({ center: fit.center, radius: fit.radius, nonce: fitNonceRef.current, extent: fit.extent });
    },
  }, mode);

  useFrame(() => {
    // Positions are applied from the worker's "tick" event, not from this
    // hook -- this useFrame exists only as the documented "R3F owns the
    // render loop" seam (kept intentionally empty of any setState calls).
  });

  // Camera focus on selection (T2 remediation, Finding 1 -- live-Chrome
  // finding: selecting ANY node zoomed the camera in far beyond any legible
  // framing, leaving only a giant overlapping label sprite on screen).
  // ROOT CAUSE: this effect used to call `setFocusTarget(pos)`, handing
  // CameraRig a raw node position that it then framed with a FIXED `z + 6`
  // offset (see CameraRig.tsx's `focusTarget` effect) -- a constant six
  // world-units regardless of the graph's actual scale. `computeFitDistance`
  // (CameraRig.tsx) treats even 20 world units as its MINIMUM legible
  // distance for a near-zero-radius graph, and real settled layouts commonly
  // need hundreds; a fixed 6-unit offset parks the camera essentially INSIDE
  // the selected node, well inside its own label sprite, with the node and
  // its neighbors entirely outside the view frustum.
  //
  // Fix: reuse the EXACT SAME bounding-sphere-plus-computeFitDistance
  // machinery the whole-graph fit-to-load path already uses
  // (`computeBoundingSphere` above / `computeFitDistance` in CameraRig.tsx),
  // scoped to the selected node PLUS its immediate (1-hop) neighbors --
  // never a new, independently-tuned distance formula. This is a DISCRETE
  // state transition (fires once per selection change, not per frame) --
  // not the "never setState in useFrame" hot path. Neighbors are computed
  // from `edges` (the FULL dataset, not the hover-sensitive `neighborIds`
  // prop, which tracks `hoveredId ?? selectedId` and would report the
  // WRONG node's neighbors while hovering a different node than the one
  // selected) via the same `neighborsOf` helper GraphView already uses for
  // progressive-disclosure expansion. Positions are read out of the
  // zero-allocation buffer above via `idIndexCacheRef`/
  // `latestPositionsBufferRef` (the same buffers `computeBoundingSphere`
  // already reads for the whole-graph fit), so a neighbor that hasn't
  // rendered yet (outside the progressive-disclosure cap) still has a
  // valid position -- the worker always simulates the FULL dataset,
  // regardless of what's currently disclosed/visible.
  useEffect(() => {
    if (!selectedId) return;
    // `computeSelectionFit` = the selected node's 1-hop neighborhood framed
    // through the same bounding-sphere path as the whole-graph fit, plus the
    // small-focus-set axis correction (see its doc comment above, and
    // `resolveFitViewDirection` in `CameraRig.tsx` for how `axis` -- `null`
    // for a large/roomy set -- is consumed). A `null` fit means no position
    // has resolved yet (first tick pending): the settle handler's
    // selection-aware branch (`onEnd` above) retries this exact fit once
    // positions exist, so returning without a fit here is a deferral, not a
    // silent drop (T3 advisory H3).
    const fit = computeSelectionFit(
      idIndexCacheRef.current.map,
      latestPositionsBufferRef.current,
      edges,
      selectedId,
    );
    if (!fit) return;
    fitNonceRef.current += 1;
    setFitRequest({
      center: fit.center,
      radius: fit.radius,
      nonce: fitNonceRef.current,
      axis: fit.axis,
      extent: fit.extent,
    });
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
        fit={fitRequest}
        transitionActive={transitioning}
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
      {mode === "terrain" ? <TerrainSurface points={terrainPoints} /> : null}
      <CameraRig focusTarget={null} fitRequest={fitRequest} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} enableZoom domElement={gl.domElement} />
    </>
  );
}

/**
 * T2 remediation (Finding 2a -- live-Chrome finding: clicking the "Switch to
 * 2D" toggle, a deliberate WORKING user action, incorrectly triggered the
 * SAME genuine-context-loss failure message). ROOT CAUSE: unmounting this
 * component (which is exactly what the manual toggle does -- GraphView
 * conditionally renders `Graph3DScene` only while `mode3D` is true) tears
 * down the R3F `<Canvas>`, and three.js's `WebGLRenderer.dispose()` (called
 * internally by R3F/drei during that teardown) calls its own
 * `forceContextLoss()`, which uses the `WEBGL_lose_context` extension to
 * deliberately fire the SAME `webglcontextlost` event a real driver
 * crash/GPU reset would -- browsers dispatch that event asynchronously
 * (never synchronously inside the `loseContext()` call), so it lands on the
 * event loop strictly AFTER this component's own synchronous unmount-cleanup
 * effects have already run. That gives a reliable way to tell the two apart:
 * `unmounting` below flips to `true` synchronously during this component's
 * unmount, before any dispose-triggered `webglcontextlost` event the browser
 * schedules for that same unmount can ever be dispatched and observed here.
 * Pure/exported so the distinction itself is directly testable without a
 * real WebGL context (which jsdom cannot provide -- see this directory's
 * established convention, e.g. `isStaleTickRevision` above).
 */
export function isGenuineContextLoss(alreadyReported: boolean, unmounting: boolean): boolean {
  return !alreadyReported && !unmounting;
}

export function Graph3DScene(props: Graph3DSceneProps) {
  const { onFpsSample, onContextLost, onReady, paused, ...sceneProps } = props;
  const reported = useRef(false);
  // See `isGenuineContextLoss`'s doc comment above for the full root cause.
  const unmountingRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountingRef.current = true;
    };
  }, []);
  const report = () => {
    if (!isGenuineContextLoss(reported.current, unmountingRef.current)) return;
    reported.current = true;
    onContextLost?.();
  };
  return (
    <WebglErrorBoundary onError={report}>
      <Canvas
        camera={{ position: [0, 0, 60], far: 4000 }}
        dpr={[0.75, 2]}
        // Deep-Field Observatory Phase 1 (plan Section 3.1 item 1 / Section
        // 5.6): ACES filmic tone mapping, explicitly configured rather than
        // relying on @react-three/fiber's implicit default (which applies
        // the same mapping today only as long as no future `gl`/`flat`
        // config on this mount opts out of it) -- an explicit, testable,
        // regression-proof declaration of the plan's tone-mapping invariant.
        gl={{ toneMapping: ACESFilmicToneMapping }}
        frameloop={paused ? "never" : "always"}
        onCreated={(state) => {
          // Auto-fallback floor (critique item 4): a live context loss --
          // driver crash, GPU reset, tab backgrounding on some mobile
          // browsers -- fires this event on the WebGLRenderer's canvas;
          // WebGL creation *failure* is caught by WebglErrorBoundary above.
          state.gl.domElement.addEventListener("webglcontextlost", (event) => {
            event.preventDefault();
            report();
          });
          // Finding 2c: fires on every successful (re-)creation of the
          // WebGL context, including a manual post-context-loss retry, so
          // the caller can clear a stale failure announcement.
          onReady?.();
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
