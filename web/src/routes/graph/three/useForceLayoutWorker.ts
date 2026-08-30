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

/**
 * Field-by-field equality of the full worker dataset -- every field the init
 * payload actually carries (node id + the per-mode force inputs community/
 * level/centrality; edge source/target), in order. Order-sensitive by
 * design: the worker's posted-position `ids` array is the node order passed
 * in `init`, so a reordered dataset IS a different dataset. Pure/exported
 * for direct unit coverage (workerReinitStability.test.ts). O(nodes+edges),
 * and it runs only when the re-init effect's identity deps fire -- never
 * per tick/frame -- so it is orders of magnitude cheaper than the worker
 * re-init (and full physics re-settle) it prevents.
 */
export function isSameWorkerDataset(
  prevNodes: WorkerNodeInput[],
  prevLinks: WorkerLinkInput[],
  nodes: WorkerNodeInput[],
  edges: WorkerLinkInput[],
): boolean {
  if (prevNodes.length !== nodes.length || prevLinks.length !== edges.length) return false;
  for (let i = 0; i < nodes.length; i++) {
    const a = prevNodes[i];
    const b = nodes[i];
    if (a.id !== b.id || a.community !== b.community || a.level !== b.level || a.centrality !== b.centrality) {
      return false;
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const a = prevLinks[i];
    const b = edges[i];
    if (a.source !== b.source || a.target !== b.target) return false;
  }
  return true;
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

  // T2 escalation fix (Terrain "camera never settles" regression -- see
  // workerReinitStability.test.ts for the full evidence chain): the last
  // init actually SENT, recorded as (client instance, mapped payload, mode).
  // The re-init effect below used to be keyed purely on the REFERENCE
  // IDENTITY of `nodes`/`edges`/`mode` -- but a live runtime diagnostic
  // proved the worker was receiving repeated `init` messages in Terrain mode
  // with unchanged data, each one re-heating the simulation to alpha 0.3 and
  // landing a fresh "end" (and therefore a fresh whole-graph camera fit, on
  // a genuinely different re-settled bounding sphere) ~13.6s later --
  // Terrain's per-tick `applyTerrainElevation` grid build stretches the
  // ~247-tick alpha decay far beyond other modes, so each spurious restart
  // is a long, visible cycle that reads as "continuous drift". Since the
  // ONLY production sender of a simulation-restarting message is this
  // effect, any render-layer perturbation that re-runs it with content-
  // identical but reference-fresh arrays restarts the physics. The guard
  // makes the effect honor its own documented contract ("re-heat ONLY on
  // data change"): a re-run whose live client, mode, and full node/edge
  // CONTENT all match the last init sent is a no-op. A fresh worker
  // (remount/StrictMode -- `client` differs), a mode change, or any real
  // node/edge/force-input change still re-inits exactly as before. The
  // recorded payload is the mapped COPY sent to the worker, so an upstream
  // in-place mutation of a node object (same reference, changed fields) is
  // still detected as a genuine data change.
  const lastInitRef = useRef<{
    client: ForceLayoutClient;
    nodes: WorkerNodeInput[];
    links: WorkerLinkInput[];
    mode?: GraphMode;
  } | null>(null);

  // Re-heat ONLY on data change (deliverable 5) -- not on filter/selection
  // changes; callers are expected to pass the FULL dataset (not a
  // disclosed/visible subset), so toggling a filter never restarts the
  // physics simulation. Reads the CURRENT worker via `layoutRef` (never a
  // stale/memoized client) -- see the creation effect above. Keyed on
  // `[nodes, edges, mode]` identity as a cheap change SIGNAL, but the
  // decision to actually re-init is content-based (see `lastInitRef` above):
  // identity churn alone must never restart the simulation.
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || nodes.length === 0) return;
    const last = lastInitRef.current;
    if (last && last.client === layout && last.mode === mode && isSameWorkerDataset(last.nodes, last.links, nodes, edges)) {
      return;
    }
    const workerNodes = nodes.map((n) => ({
      id: n.id,
      community: n.community,
      level: n.level,
      centrality: n.centrality,
    }));
    const workerLinks = edges.map((e) => ({ source: e.source, target: e.target }));
    lastInitRef.current = { client: layout, nodes: workerNodes, links: workerLinks, mode };
    layout.init(workerNodes, workerLinks, undefined, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, mode]);

  return layoutRef;
}
