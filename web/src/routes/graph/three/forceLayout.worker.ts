// Web Worker: owns the d3-force-3d simulation entirely off the main thread
// (deliverable 5 -- "LAYOUT in a Web Worker; warmupTicks -> freeze on
// onEngineStop; re-heat ONLY on data change or user drag; never block
// input"). Positions are posted back as a transferable, RECYCLED
// Float32Array (see `freeBuffers`/`takeBuffer` below -- no per-tick
// allocation) with id order == the `nodes` array passed in `init`/`update`,
// so the main thread only ever copies numbers into InstancedMesh2 matrices
// inside `useFrame` -- it never runs any force math itself.
//
// This module does NOT import `r3f-forcegraph` -- see ADR-0505
// (`.fable/20260711-183729-p5-3d-graph-frontend/artifacts/4.6-adr-0505-supersedes-0501-worker-only-layout.md`),
// which formally supersedes ADR-0501's mandate to drive `r3f-forcegraph`'s
// `tickFrame()` from `useFrame`: that pattern is inherently main-thread and
// cannot coexist with ADR-0502's worker-boundary requirement at the
// ~50k-node/60fps target. `WorkerNode`/`WorkerLink` below mirror
// `r3f-forcegraph`'s own `NodeObject`/`LinkObject` field shape by
// convention (id, x/y/z, fx/fy/fz) but the package itself is not a
// dependency of this codebase -- see ForceLayoutClient.ts for the
// main-thread half of this boundary.
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation3D,
} from "d3-force-3d";

export interface WorkerNode {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
}

export interface WorkerLink {
  source: string;
  target: string;
}

export type ForceLayoutInMessage =
  | { type: "init" | "update"; nodes: WorkerNode[]; links: WorkerLink[]; warmupTicks?: number }
  | { type: "reheat" }
  | { type: "drag"; id: string; x: number; y: number; z: number }
  | { type: "dragend"; id: string }
  | { type: "stop" }
  /** Main thread hands a consumed tick's transferable buffer back once it's
   *  done reading it, so the worker can recycle it instead of allocating a
   *  fresh Float32Array next tick (reflexion critique item 2). */
  | { type: "releaseBuffer"; buffer: ArrayBuffer };

export type ForceLayoutOutMessage =
  /** `revision` increments on every `init`/`update` -- the main thread uses
   *  it to know when it's safe to keep reusing a cached id->position-index
   *  map across ticks instead of rebuilding one per tick (also critique
   *  item 2: eliminates the main-thread per-tick Map allocation). */
  | { type: "tick"; positions: Float32Array; ids: string[]; alpha: number; revision: number }
  | { type: "end" };

let sim: Simulation3D<WorkerNode> | null = null;
let nodes: WorkerNode[] = [];
let ids: string[] = [];
let revision = 0;

// Preallocated-buffer pool (reflexion critique item 2): the same handful of
// Float32Arrays get transferred out to the main thread and back again --
// `postTick` never calls `new Float32Array` once the pool is warm. Buffers
// are keyed only by size; a stale-size buffer (from before a node-count
// change) is simply dropped rather than reused.
const freeBuffers: Float32Array[] = [];

function takeBuffer(size: number): Float32Array {
  for (let i = freeBuffers.length - 1; i >= 0; i--) {
    if (freeBuffers[i].length === size) return freeBuffers.splice(i, 1)[0];
  }
  return new Float32Array(size);
}

function postTick() {
  if (!sim) return;
  const buf = takeBuffer(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    buf[i * 3] = nodes[i].x ?? 0;
    buf[i * 3 + 1] = nodes[i].y ?? 0;
    buf[i * 3 + 2] = nodes[i].z ?? 0;
  }
  const message: ForceLayoutOutMessage = { type: "tick", positions: buf, ids, alpha: sim.alpha(), revision };
  (postMessage as (msg: unknown, transfer: Transferable[]) => void)(message, [buf.buffer]);
}

function buildSimulation(inNodes: WorkerNode[], inLinks: WorkerLink[], warmupTicks: number) {
  revision++;
  // Preserve existing positions across an `update` (data-change reheat), keyed
  // by id, so re-fetching graph data doesn't reset the whole layout.
  const previousById = new Map(nodes.map((n) => [n.id, n]));
  nodes = inNodes.map((n) => {
    const prev = previousById.get(n.id);
    return prev ? { ...n, x: prev.x, y: prev.y, z: prev.z } : { ...n };
  });
  ids = nodes.map((n) => n.id);

  sim?.stop();
  sim = forceSimulation<WorkerNode>(nodes, 3)
    .force("charge", forceManyBody().strength(-80).distanceMax(600))
    .force(
      "link",
      forceLink<WorkerNode, WorkerLink & { source: WorkerNode; target: WorkerNode }>(
        inLinks as unknown as (WorkerLink & { source: WorkerNode; target: WorkerNode })[],
      )
        .id((n) => n.id)
        .distance(40),
    )
    .force("center", forceCenter())
    .force("collide", forceCollide(3))
    .alphaDecay(0.0228)
    .on("tick", postTick)
    .on("end", () => (postMessage as (msg: unknown) => void)({ type: "end" } satisfies ForceLayoutOutMessage));

  // Warm up synchronously (no visual jank from a cold start), THEN let the
  // timer-driven ticks (and their normal alpha decay) take over and freeze
  // themselves via the "end" event -- this IS the "onEngineStop" freeze.
  sim.stop();
  for (let i = 0; i < warmupTicks; i++) sim.tick();
  postTick();
  sim.alpha(0.3).restart();
}

self.onmessage = (event: MessageEvent<ForceLayoutInMessage>) => {
  const msg = event.data;
  if (msg.type === "init" || msg.type === "update") {
    buildSimulation(msg.nodes, msg.links, msg.warmupTicks ?? 60);
  } else if (msg.type === "reheat") {
    sim?.alpha(0.6).restart();
  } else if (msg.type === "drag") {
    const node = nodes.find((n) => n.id === msg.id);
    if (node && sim) {
      node.fx = msg.x;
      node.fy = msg.y;
      node.fz = msg.z;
      sim.alphaTarget(0.3).restart();
    }
  } else if (msg.type === "dragend") {
    const node = nodes.find((n) => n.id === msg.id);
    if (node) {
      node.fx = null;
      node.fy = null;
      node.fz = null;
    }
    sim?.alphaTarget(0);
  } else if (msg.type === "stop") {
    sim?.stop();
  } else if (msg.type === "releaseBuffer") {
    // Recycle the main thread's consumed tick buffer -- see `takeBuffer`.
    freeBuffers.push(new Float32Array(msg.buffer));
  }
};
