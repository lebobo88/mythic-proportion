// Worker lifecycle for the 3D graph's force simulation, extracted out of
// Graph3DScene.tsx so it can be tested directly (via React Testing
// Library's `renderHook`) WITHOUT needing a real R3F `<Canvas>`/WebGL
// context, which jsdom cannot provide (see GraphView.test.tsx /
// webglFallback.test.tsx's own established convention of stubbing
// Graph3DScene out entirely for that reason). This hook uses only plain
// React hooks (`useRef`/`useEffect`) -- never `useFrame`/`useThree` -- so it
// is safe to mount standalone, outside any R3F reconciler tree.
//
// T2 remediation root-cause fix (see the T2 job report): the Worker is
// created AND disposed inside this ONE effect, never in `useMemo`. This is
// load-bearing for React 18 StrictMode dev-mode compliance, not stylistic.
// StrictMode's documented dev-only "mount -> synchronously run every cleanup
// in reverse order -> remount" dance happens entirely within one synchronous
// commit, before a real Worker's OWN thread ever gets a turn to process
// anything. The previous code created the Worker once via `useMemo` (which
// survives StrictMode's simulated unmount) while disposing it in a SEPARATE
// `useEffect` keyed off that same stable object -- so StrictMode's simulated
// remount called `layout.init(...)` a second time against a Worker that had
// ALREADY been `.terminate()`-d in between, and `postMessage` on a
// terminated Worker silently no-ops forever after. The physics simulation
// was orphaned permanently for the rest of that mount's dev-mode lifetime:
// no `tick`/`end` ever fired again, so `applyPositions` was never called
// (every node instance kept whatever position -- or lack of one -- it had
// at mount, i.e. the origin) and the camera never camera-fit. This was
// environment-dependent (dev server only -- StrictMode's double-invoke is
// disabled in production builds), not dependent on graph shape/size/
// density, which is why it could pass one Browser Validator check and fail
// the next on unrelated data. Creating a FRESH Worker inside this effect
// fixes it structurally: StrictMode's remount now spins up a brand-new,
// live Worker instead of reusing a wrapper around a terminated one.
//
// Real regression coverage: `graphPerf.synthetic.test.ts`'s "worker
// lifecycle survives React 18 StrictMode's dev-mode double-invoke" describe
// block renders THIS hook (not a duplicated helper) via `renderHook` wrapped
// in `<React.StrictMode>`, with a fake `WorkerLike` whose `postMessage`/
// `terminate` semantics mirror a real browser Worker. Verified locally (by
// temporarily reintroducing the pre-fix `useMemo`-owned-Worker shape here
// and rerunning that test) to genuinely fail against it and pass against
// this one.
import { useEffect, useRef } from "react";
import { createForceLayoutWorker, ForceLayoutClient } from "./ForceLayoutClient";
import type { GraphMode } from "../types";

export interface WorkerNodeInput {
  id: string;
  /** Phase 4a spike scaffolding (plan Section 6.3), optional and additive -- threaded straight through to the worker's per-mode force configuration. */
  community?: number;
  level?: number;
  centrality?: number;
}

export interface WorkerLinkInput {
  source: string;
  target: string;
}

export interface UseForceLayoutWorkerHandlers {
  /** Fired on every worker "tick" message. `layout` is the SAME client instance this tick came from -- needed to call `layout.releaseBuffer(...)`. */
  onTick: (positions: Float32Array, ids: string[], alpha: number, revision: number, layout: ForceLayoutClient) => void;
  /** Fired once the worker's simulation settles ("end" / `onEngineStop`). */
  onEnd: () => void;
}

/**
 * Owns the `ForceLayoutClient`/Worker for the 3D graph's force simulation:
 * creates it, wires the given tick/end handlers, disposes it on unmount, and
 * re-initializes the simulation whenever `nodes`/`edges` change. Returns a
 * ref to the current live client (`null` before the creation effect has run,
 * or after real disposal) for callers that need direct access (e.g. drag
 * interactions elsewhere in the graph route).
 */
export function useForceLayoutWorker(
  nodes: WorkerNodeInput[],
  edges: WorkerLinkInput[],
  handlers: UseForceLayoutWorkerHandlers,
  /** Phase 4a spike addition (plan Section 6.3), optional and additive -- omitted, this hook's re-init behavior is byte-identical to its pre-spike form ("cloud"). Included in the re-init effect's deps below so a mode switch re-initializes the worker with the new mode's force configuration. */
  mode?: GraphMode,
): React.RefObject<ForceLayoutClient | null> {
  const layoutRef = useRef<ForceLayoutClient | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const layout = new ForceLayoutClient(createForceLayoutWorker());
    layoutRef.current = layout;

    const unsubscribeTick = layout.onTick((positions, ids, alpha, revision) => {
      handlersRef.current.onTick(positions, ids, alpha, revision, layout);
    });
    const unsubscribeEnd = layout.onEnd(() => {
      handlersRef.current.onEnd();
    });

    return () => {
      unsubscribeTick();
      unsubscribeEnd();
      layout.dispose();
      layoutRef.current = null;
    };
  }, []);

  // Re-heat ONLY on data change (deliverable 5) -- not on filter/selection
  // changes; callers are expected to pass the FULL dataset (not a
  // disclosed/visible subset), so toggling a filter never restarts the
  // physics simulation. Reads the CURRENT worker via `layoutRef` (never a
  // stale/memoized client) -- see the creation effect above.
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || nodes.length === 0) return;
    const workerNodes = nodes.map((n) => ({
      id: n.id,
      community: n.community,
      level: n.level,
      centrality: n.centrality,
    }));
    const workerLinks = edges.map((e) => ({ source: e.source, target: e.target }));
    layout.init(workerNodes, workerLinks, undefined, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, mode]);

  return layoutRef;
}
