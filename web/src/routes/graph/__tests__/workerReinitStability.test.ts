// T2 escalation (plan Section 11 escalation track -- Terrain "camera never
// settles" regression, T3-advised + live-diagnostic-confirmed): the live
// runtime diagnostic proved the physics worker's "end"/settle event re-fires
// repeatedly in Terrain mode (one run: 3 distinct fit nonces with materially
// different radii 542 -> 579 -> 547, ~13.6s apart -- each ~13.6s gap is one
// full Terrain re-settle, whose per-tick `applyTerrainElevation` grid build
// stretches the ~247-tick alpha decay far beyond Cloud's ~4s). T3's source
// audit proved CameraRig's fit machinery is one-shot and correct; d3-force's
// own `step()` fires "end" exactly ONCE per restart (stepper.stop() precedes
// the event call -- see node_modules/d3-force-3d/src/simulation.js). The
// worker restarts ONLY on an `init`/`update`/`reheat`/`drag` message, and
// the ONLY production sender of any of those is `useForceLayoutWorker`'s
// re-init effect. Therefore every spurious settle/fit cycle is that effect
// re-running -- and the effect was keyed on the REFERENCE IDENTITY of
// `nodes`/`edges`/`mode`, so ANY render-layer perturbation that hands the
// hook content-identical but reference-fresh arrays (or replays the effect)
// restarts the whole physics simulation, re-heats it to alpha 0.3, and
// ~13.6s later lands a fresh "end" on a genuinely different bounding sphere
// -- which is exactly what visually reads as "continuous drift". Terrain is
// the only mode where this is so visible because (a) its settle is the
// slowest, and (b) it is the only mode with a standing extra render cadence
// (the 800ms `terrainPoints` interval in Graph3DScene's SceneContents).
//
// The fix under test: the re-init effect is now keyed on the DATA it is
// documented to react to ("re-heat ONLY on data change" -- the hook's own
// contract since deliverable 5), not on array reference identity. A re-run
// whose live worker client, mode, and full node/edge content all match the
// last init actually sent is a no-op; a genuine data change, a mode change,
// or a fresh worker (remount/StrictMode) still re-inits exactly as before.
//
// Same fake-Worker convention as graphPerf.synthetic.test.ts's StrictMode
// lifecycle coverage: the REAL `useForceLayoutWorker` hook and the REAL
// `ForceLayoutClient` run unmodified; only the Worker factory is faked
// (jsdom has no real Worker), with `postMessage`-after-`terminate` as a
// silent no-op, mirroring a real browser Worker.
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useForceLayoutWorker } from "../three/useForceLayoutWorker";
import type { ForceLayoutInMessage } from "../three/forceLayout.worker";

interface FakeWorkerHandle {
  terminated: boolean;
  messages: ForceLayoutInMessage[];
  /** Count of `init`/`update` messages this worker has settled (responded to with tick+end) so far. */
  settledCount: number;
  listener: ((event: { data: unknown }) => void) | null;
  addEventListener(type: "message", cb: (event: { data: unknown }) => void): void;
  postMessage(message: ForceLayoutInMessage): void;
  terminate(): void;
  /** Number of `init`/`update` (simulation-restarting) messages received. */
  initCount(): number;
  /**
   * Simulates the worker thread reaching a full settle for every
   * so-far-unanswered `init`/`update`: one batched tick plus ONE "end" per
   * restart -- exactly d3-force's semantics (`step()` stops the stepper
   * before firing "end", so one restart can never produce two ends).
   */
  settle(): void;
}

const { createFakeWorker, fakeWorkers } = vi.hoisted(() => {
  const fakeWorkers: FakeWorkerHandle[] = [];
  function createFakeWorker(): FakeWorkerHandle {
    const worker: FakeWorkerHandle = {
      terminated: false,
      messages: [],
      settledCount: 0,
      listener: null,
      addEventListener(_type, cb) {
        worker.listener = cb;
      },
      postMessage(message) {
        if (worker.terminated) return;
        worker.messages.push(message);
      },
      terminate() {
        worker.terminated = true;
      },
      initCount() {
        return worker.messages.filter((m) => m.type === "init" || m.type === "update").length;
      },
      settle() {
        if (worker.terminated) return;
        const pending = worker.initCount() - worker.settledCount;
        for (let i = 0; i < pending; i++) {
          worker.settledCount++;
          const initMessage = worker.messages.filter((m) => m.type === "init" || m.type === "update")[
            worker.settledCount - 1
          ] as Extract<ForceLayoutInMessage, { type: "init" | "update" }>;
          const ids = initMessage.nodes.map((n) => n.id);
          worker.listener?.({
            data: {
              type: "tick",
              positions: new Float32Array(ids.length * 3),
              ids,
              alpha: 0.3,
              revision: worker.settledCount,
            },
          });
          worker.listener?.({ data: { type: "end" } });
        }
      },
    };
    fakeWorkers.push(worker);
    return worker;
  }
  return { createFakeWorker, fakeWorkers };
});

vi.mock("../three/ForceLayoutClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../three/ForceLayoutClient")>();
  return { ...actual, createForceLayoutWorker: createFakeWorker };
});

function survivingWorker(): FakeWorkerHandle {
  const surviving = fakeWorkers.filter((w) => !w.terminated);
  expect(surviving).toHaveLength(1);
  return surviving[0];
}

interface HookProps {
  nodes: { id: string; community?: number; level?: number; centrality?: number }[];
  edges: { source: string; target: string }[];
  mode?: import("../types").GraphMode;
}

const BASE_NODES: HookProps["nodes"] = [
  { id: "a", community: 0, level: 0, centrality: 0.5 },
  { id: "b", community: 1, level: 0, centrality: 0.2 },
  { id: "c", community: 1, level: 1, centrality: 0.9 },
];
const BASE_EDGES: HookProps["edges"] = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
];

/** Content-identical, reference-fresh copies -- the exact churn shape the live diagnostic implicates. */
function freshCopies(): Pick<HookProps, "nodes" | "edges"> {
  return {
    nodes: BASE_NODES.map((n) => ({ ...n })),
    edges: BASE_EDGES.map((e) => ({ ...e })),
  };
}

describe("useForceLayoutWorker re-init stability (Terrain settle-loop escalation)", () => {
  let ends: number;

  beforeEach(() => {
    fakeWorkers.length = 0;
    ends = 0;
  });

  function mountHook(initialProps: HookProps) {
    return renderHook(
      ({ nodes, edges, mode }: HookProps) =>
        useForceLayoutWorker(nodes, edges, { onTick: () => {}, onEnd: () => void ends++ }, mode),
      { initialProps },
    );
  }

  it("re-renders with content-identical but reference-fresh nodes/edges (the live Terrain diagnostic's churn pattern) never re-init the worker -- one init, one settle, one end, no repeated camera-fit cycle", () => {
    const { rerender } = mountHook({ ...freshCopies(), mode: "terrain" });
    const worker = survivingWorker();
    act(() => worker.settle());
    expect(worker.initCount()).toBe(1);
    expect(ends).toBe(1);

    // Three churn re-renders, mirroring the diagnostic's three spurious
    // settle/fit cycles (nonces 2 -> 3 -> 4). Each settle() answers ONLY
    // messages actually sent -- so if no spurious init is sent, no spurious
    // "end" (and therefore no spurious camera fit) can ever fire.
    for (let i = 0; i < 3; i++) {
      rerender({ ...freshCopies(), mode: "terrain" });
      act(() => worker.settle());
    }

    expect(worker.initCount()).toBe(1);
    expect(ends).toBe(1);
  });

  it("a genuine node-data change (added node) still re-inits exactly once", () => {
    const { rerender } = mountHook({ ...freshCopies(), mode: "terrain" });
    const worker = survivingWorker();
    expect(worker.initCount()).toBe(1);

    rerender({
      nodes: [...BASE_NODES.map((n) => ({ ...n })), { id: "d", community: 0, level: 0, centrality: 0.1 }],
      edges: BASE_EDGES.map((e) => ({ ...e })),
      mode: "terrain",
    });
    expect(worker.initCount()).toBe(2);
  });

  it("a per-node force-input change (centrality only, same ids) still re-inits -- the worker's per-mode force configuration consumes it", () => {
    const { rerender } = mountHook({ ...freshCopies(), mode: "terrain" });
    const worker = survivingWorker();
    expect(worker.initCount()).toBe(1);

    const bumped = BASE_NODES.map((n, i) => ({ ...n, centrality: i === 0 ? 0.99 : n.centrality }));
    rerender({ nodes: bumped, edges: BASE_EDGES.map((e) => ({ ...e })), mode: "terrain" });
    expect(worker.initCount()).toBe(2);
  });

  it("an edge-content change (rewired endpoint, same lengths) still re-inits", () => {
    const { rerender } = mountHook({ ...freshCopies(), mode: "terrain" });
    const worker = survivingWorker();
    expect(worker.initCount()).toBe(1);

    rerender({
      nodes: BASE_NODES.map((n) => ({ ...n })),
      edges: [
        { source: "a", target: "c" },
        { source: "b", target: "c" },
      ],
      mode: "terrain",
    });
    expect(worker.initCount()).toBe(2);
  });

  it("a mode change still re-inits, and the new init message carries the new mode's force configuration", () => {
    const { rerender } = mountHook({ ...freshCopies(), mode: "cloud" });
    const worker = survivingWorker();
    expect(worker.initCount()).toBe(1);

    rerender({ ...freshCopies(), mode: "terrain" });
    expect(worker.initCount()).toBe(2);
    const inits = worker.messages.filter(
      (m): m is Extract<ForceLayoutInMessage, { type: "init" | "update" }> => m.type === "init" || m.type === "update",
    );
    expect(inits[0].mode).toBe("cloud");
    expect(inits[1].mode).toBe("terrain");
  });

  it("a full unmount/remount with identical content still inits the FRESH worker -- content-keying must never starve a brand-new worker of its dataset", () => {
    const first = mountHook({ ...freshCopies(), mode: "terrain" });
    expect(survivingWorker().initCount()).toBe(1);
    first.unmount();

    mountHook({ ...freshCopies(), mode: "terrain" });
    const second = survivingWorker();
    expect(second.initCount()).toBe(1);
  });

  it("StrictMode's dev-mode mount -> cleanup -> remount dance still leaves the surviving worker initialized (regression guard for the prior worker-lifecycle T2 fix)", () => {
    renderHook(
      ({ nodes, edges, mode }: HookProps) =>
        useForceLayoutWorker(nodes, edges, { onTick: () => {}, onEnd: () => void ends++ }, mode),
      { initialProps: { ...freshCopies(), mode: "terrain" as const }, wrapper: StrictMode },
    );
    const worker = survivingWorker();
    expect(worker.initCount()).toBeGreaterThanOrEqual(1);
    act(() => worker.settle());
    expect(ends).toBeGreaterThanOrEqual(1);
  });
});
