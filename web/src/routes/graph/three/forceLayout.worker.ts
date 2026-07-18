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
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Simulation3D,
} from "d3-force-3d";
import type { GraphMode } from "../types";
import {
  orbitalRadiusForNode,
  strataLayerY,
  linkDistanceForMode,
  TERRAIN_FLATTEN_STRENGTH,
  SHARED_CHARGE_STRENGTH,
  SHARED_CHARGE_DISTANCE_MAX,
  SHARED_COLLIDE_RADIUS,
  CLOUD_CONTAINMENT_STRENGTH,
} from "./modeForces";
import { buildElevationGrid, sampleElevation, TERRAIN_MAX_HEIGHT, type ElevationPoint } from "./terrainElevation";

export interface WorkerNode {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
  /** Phase 4a spike scaffolding (plan Section 6.3), optional and additive -- see `VizNode` in types.ts for the same fields' provenance. */
  community?: number;
  level?: number;
  centrality?: number;
}

export interface WorkerLink {
  source: string;
  target: string;
}

export type ForceLayoutInMessage =
  | {
      type: "init" | "update";
      nodes: WorkerNode[];
      links: WorkerLink[];
      warmupTicks?: number;
      /** Phase 4a spike addition (plan Section 6.3): selects the per-mode force configuration below. Omitted/undefined behaves EXACTLY as "cloud" did before this addition -- no behavior change for any existing caller. */
      mode?: GraphMode;
    }
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
// Phase 4a spike addition (plan Section 6.3): the active mode's force
// configuration, defaulting to "cloud" -- unchanged from this worker's
// pre-spike behavior for every caller that never sends `mode`.
let mode: GraphMode = "cloud";

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

/**
 * Phase 4a spike addition (bet 2 -- Knowledge Terrain feasibility): in
 * terrain mode, overwrite each posted position's y with the SAME
 * `terrainElevation.ts` heightfield `TerrainSurface.tsx` renders the ground
 * from, sampled at the node's own worker-computed x/z. This runs on the
 * REAL, currently-settling x/z output every tick (not a cached/precomputed
 * layout), so "nodes riding the surface" tracks the physics as it settles,
 * exactly like every other mode's position. The underlying per-node physics
 * state (`nodes[i].y`, driven toward 0 by the mode's own flatten force
 * below) is left untouched -- only the POSTED display buffer is elevated --
 * so simulation continuity across an `update`/reheat is unaffected.
 */
function applyTerrainElevation(buf: Float32Array): void {
  const points: ElevationPoint[] = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    points[i] = { x: buf[i * 3], z: buf[i * 3 + 2], weight: nodes[i].centrality ?? 0.1 };
  }
  const grid = buildElevationGrid(points);
  for (let i = 0; i < nodes.length; i++) {
    const elevation = sampleElevation(grid, buf[i * 3], buf[i * 3 + 2]);
    buf[i * 3 + 1] = elevation * TERRAIN_MAX_HEIGHT;
  }
}

function postTick() {
  if (!sim) return;
  const buf = takeBuffer(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    buf[i * 3] = nodes[i].x ?? 0;
    buf[i * 3 + 1] = nodes[i].y ?? 0;
    buf[i * 3 + 2] = nodes[i].z ?? 0;
  }
  if (mode === "terrain") applyTerrainElevation(buf);
  const message: ForceLayoutOutMessage = { type: "tick", positions: buf, ids, alpha: sim.alpha(), revision };
  (postMessage as (msg: unknown, transfer: Transferable[]) => void)(message, [buf.buffer]);
}

function buildSimulation(
  inNodes: WorkerNode[],
  inLinks: WorkerLink[],
  warmupTicks: number,
  nextMode: GraphMode = "cloud",
) {
  revision++;
  mode = nextMode;
  // Preserve existing positions across an `update` (data-change reheat), keyed
  // by id, so re-fetching graph data doesn't reset the whole layout.
  const previousById = new Map(nodes.map((n) => [n.id, n]));
  nodes = inNodes.map((n) => {
    const prev = previousById.get(n.id);
    return prev ? { ...n, x: prev.x, y: prev.y, z: prev.z } : { ...n };
  });
  ids = nodes.map((n) => n.id);

  const communityCount = 1 + nodes.reduce((max, n) => Math.max(max, n.community ?? 0), 0);
  const levelCount = 1 + nodes.reduce((max, n) => Math.max(max, n.level ?? 0), 0);

  sim?.stop();
  const simulation = forceSimulation<WorkerNode>(nodes, 3)
    // Browser-audit item 1 (BLOCKING, live-Chrome finding): `distanceMax`
    // tightened from 600 -> 250, and a weak per-axis containment force
    // (below) added. A fully isolated node (no `forceLink` pulling it back)
    // only ever feels `forceCenter` (which recenters the layout's
    // barycenter, not any individual node) and `forceManyBody` repulsion --
    // with nothing bounding how far it can drift, a sparse/mostly-
    // disconnected graph (demo-vault's real shape: 20 entities, 4
    // relationships) settled to a bounding-sphere radius of ~500 units
    // (reproduced numerically; see the T2 job report), which pushed the
    // camera-fit distance (Graph3DScene's onEnd handler) far enough back
    // that every node fell into InstancedNodes' most distant, flattest LOD
    // tier -- rendering as near-invisible pinpoints.
    .force("charge", forceManyBody().strength(SHARED_CHARGE_STRENGTH).distanceMax(SHARED_CHARGE_DISTANCE_MAX))
    .force(
      "link",
      forceLink<WorkerNode, WorkerLink & { source: WorkerNode; target: WorkerNode }>(
        inLinks as unknown as (WorkerLink & { source: WorkerNode; target: WorkerNode })[],
      )
        .id((n) => n.id)
        .distance(linkDistanceForMode(mode)),
    )
    .force("center", forceCenter())
    .force("collide", forceCollide(SHARED_COLLIDE_RADIUS))
    .alphaDecay(0.0228);

  // Phase 4a spike addition (bet 1 -- distinct per-mode physics targets so
  // the transition has something genuinely different to interpolate
  // toward): "cloud" keeps the EXACT pre-spike containment forces below,
  // unchanged. The other three modes replace the y/x/z containment with a
  // mode-specific target force; charge/link/center/collide above stay
  // shared across all four modes.
  if (mode === "orbital") {
    // Concentric shells by community, radiating in all 3 dimensions --
    // replaces the plain origin-containment forces entirely.
    simulation.force(
      "radial",
      forceRadial(
        (node: unknown) => orbitalRadiusForNode(node as WorkerNode, communityCount),
        0,
        0,
        0,
      ).strength(0.25),
    );
  } else if (mode === "strata") {
    // Strong y-layering by hierarchy level; x/z keep a gentle origin pull
    // so each layer stays a legible, centered disc rather than drifting.
    simulation
      .force("x", forceX(0).strength(0.1))
      .force("y", forceY((node: unknown) => strataLayerY(node as WorkerNode, levelCount)).strength(0.6))
      .force("z", forceZ(0).strength(0.1));
  } else if (mode === "terrain") {
    // Flatten toward y=0 during physics -- `postTick`'s `applyTerrainElevation`
    // is what actually places nodes onto the heightfield surface for display;
    // this force only keeps the PHYSICS state itself from drifting in y.
    simulation
      .force("x", forceX(0).strength(0.1))
      .force("y", forceY(0).strength(TERRAIN_FLATTEN_STRENGTH))
      .force("z", forceZ(0).strength(0.1));
  } else {
    // Gentle bounded containment toward the origin -- weak enough
    // (strength 0.1, versus forceLink's much stronger per-edge pull) that
    // it never distorts a connected cluster's own link-driven spacing, but
    // strong enough to keep an isolated node from drifting indefinitely.
    // Numerically verified to bound the demo-vault-shaped 20-node/4-edge
    // fixture to ~radius 146 (down from ~503) and the ~1500-node default
    // disclosure cap to ~radius 596 (down from ~1615).
    simulation
      .force("x", forceX(0).strength(CLOUD_CONTAINMENT_STRENGTH))
      .force("y", forceY(0).strength(CLOUD_CONTAINMENT_STRENGTH))
      .force("z", forceZ(0).strength(CLOUD_CONTAINMENT_STRENGTH));
  }

  sim = simulation.on("tick", postTick).on("end", () => {
    (postMessage as (msg: unknown) => void)({ type: "end" } satisfies ForceLayoutOutMessage);
  });

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
    buildSimulation(msg.nodes, msg.links, msg.warmupTicks ?? 60, msg.mode ?? "cloud");
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
