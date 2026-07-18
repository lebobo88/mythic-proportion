// Synthetic-graph perf harness (per the §4.10 test plan): exercises the 3D
// scene's data + layout path at the ~10k/~50k-node target WITHOUT a large
// real vault (the real vault is tiny). Deliberately asserts STRUCTURAL
// budget only -- one batched worker "tick" message carrying every node's
// position (not one message per node/frame), and that the worker owns the
// simulation (not the main-thread client) -- NEVER a hard fps number
// (headless/CI fps is flaky and meaningless without a real GPU).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { generateSyntheticGraph } from "../synthetic";
import { computeBoundingSphere, isGenuineContextLoss } from "../three/Graph3DScene";
import { computeFitDistance, FIT_PADDING, MAX_FIT_DISTANCE, MIN_FIT_DISTANCE } from "../three/CameraRig";
import { useForceLayoutWorker } from "../three/useForceLayoutWorker";

const THREE_DIR = join(__dirname, "..", "three");
function readSource(fileName: string): string {
  return readFileSync(join(THREE_DIR, fileName), "utf-8");
}

// Fake Worker plumbing for the REAL `useForceLayoutWorker` hook's StrictMode
// regression test below (see that describe block). Defined via `vi.hoisted`
// so it's available both inside the `vi.mock(...)` factory (which itself
// gets hoisted above imports by Vitest) and inside the test bodies that read
// back which fake workers were created. A minimal `WorkerLike` whose
// `postMessage`/`terminate` semantics mirror a REAL browser Worker:
// `postMessage()` after `terminate()` is a silent no-op, and `terminate()`
// discards whatever's still queued and unprocessed -- exactly the mechanism
// that orphaned the physics simulation under React 18 StrictMode's dev-mode
// double-invoke of effects (see the T2 job report).
interface FakeWorkerHandle {
  terminated: boolean;
  queue: { type: string }[];
  listener: ((event: { data: unknown }) => void) | null;
  addEventListener(type: "message", cb: (event: { data: unknown }) => void): void;
  postMessage(message: { type: string }): void;
  terminate(): void;
  /** Simulates the worker thread finally getting a turn -- strictly AFTER the synchronous React commit (including StrictMode's simulated mount->cleanup->remount dance) has fully settled. */
  flush(): void;
}

const { createFakeWorker, fakeWorkers } = vi.hoisted(() => {
  const fakeWorkers: FakeWorkerHandle[] = [];
  function createFakeWorker(): FakeWorkerHandle {
    const worker: FakeWorkerHandle = {
      terminated: false,
      queue: [],
      listener: null,
      addEventListener(_type, cb) {
        worker.listener = cb;
      },
      postMessage(message) {
        if (worker.terminated) return;
        worker.queue.push(message);
      },
      terminate() {
        worker.terminated = true;
        worker.queue = [];
      },
      flush() {
        if (worker.terminated) return;
        for (const message of worker.queue.splice(0)) {
          if (message.type === "init") {
            worker.listener?.({
              data: { type: "tick", positions: new Float32Array(3), ids: ["a"], alpha: 0.3, revision: 1 },
            });
            worker.listener?.({ data: { type: "end" } });
          }
        }
      },
    };
    fakeWorkers.push(worker);
    return worker;
  }
  return { createFakeWorker, fakeWorkers };
});

// The real `ForceLayoutClient` class stays UNMOCKED (it's what's under
// test); only the Worker FACTORY is swapped for the fake above, since jsdom
// has no real Worker/separate-thread semantics to drive this test against.
vi.mock("../three/ForceLayoutClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../three/ForceLayoutClient")>();
  return { ...actual, createForceLayoutWorker: createFakeWorker };
});

describe("synthetic graph fixtures (dev-only large-scale loader)", () => {
  it("generates a 10k-node fixture with the requested node count", () => {
    const graph = generateSyntheticGraph({ nodeCount: 10_000, avgDegree: 4, seed: 42 });
    expect(graph.nodes).toHaveLength(10_000);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it("generates a 50k-node fixture with the requested node count", () => {
    const graph = generateSyntheticGraph({ nodeCount: 50_000, avgDegree: 3, seed: 7 });
    expect(graph.nodes).toHaveLength(50_000);
    expect(graph.edges.length).toBeGreaterThan(0);
  }, 20_000);

  it("is fully deterministic for a given seed (stable fixtures across runs)", () => {
    const a = generateSyntheticGraph({ nodeCount: 1000, seed: 1 });
    const b = generateSyntheticGraph({ nodeCount: 1000, seed: 1 });
    expect(a).toEqual(b);
  });

  it("every node/edge id is well-formed and edges reference existing nodes", () => {
    const graph = generateSyntheticGraph({ nodeCount: 2000, seed: 5 });
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.size).toBe(graph.nodes.length); // no duplicate ids
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });
});

describe("forceLayout worker: batched, worker-owned layout (structural budget)", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    vi.stubGlobal("postMessage", postMessageSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("posts ONE batched tick carrying every node's position -- never one message per node", async () => {
    const graph = generateSyntheticGraph({ nodeCount: 800, avgDegree: 3, seed: 11 });
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    expect(handler).toBeTypeOf("function");

    postMessageSpy.mockClear();
    handler!({
      data: {
        type: "init",
        nodes: graph.nodes.map((n) => ({ id: n.id })),
        links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
        warmupTicks: 5,
      },
    } as unknown as MessageEvent);

    const tickMessages = postMessageSpy.mock.calls
      .map(([msg]) => msg)
      .filter((msg): msg is { type: "tick"; positions: Float32Array; ids: string[] } => msg.type === "tick");

    expect(tickMessages.length).toBeGreaterThanOrEqual(1);
    const [firstTick] = tickMessages;
    expect(firstTick.positions).toBeInstanceOf(Float32Array);
    // ONE message, all node positions -- not `graph.nodes.length` separate messages.
    expect(firstTick.positions.length).toBe(graph.nodes.length * 3);
    expect(firstTick.ids).toHaveLength(graph.nodes.length);

    // Stop the sim immediately so its d3-timer doesn't keep firing (and
    // calling the stubbed `postMessage`) after this test's globals unwind.
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);
  });
});

describe("ForceLayoutClient: main thread never runs the simulation itself", () => {
  it("only talks to the worker via postMessage -- no local d3-force-3d import/call", () => {
    const source = readSource("ForceLayoutClient.ts");
    expect(source).not.toMatch(/from ["']d3-force-3d["']/);
    expect(source).not.toMatch(/forceSimulation\(/);
    expect(source).toMatch(/postMessage/);
  });
});

describe("InstancedNodes: one InstancedMesh2 for the whole node set (not one mesh per node)", () => {
  it("constructs exactly one InstancedMesh2 per node-set change, never per-node meshes", () => {
    const source = readSource("InstancedNodes.tsx");
    // Exactly one `new InstancedMesh2(...)` call site in the whole module --
    // instances are added via `addInstances`, not by constructing a mesh per node.
    const constructorCalls = source.match(/new InstancedMesh2\(/g) ?? [];
    expect(constructorCalls).toHaveLength(1);
    expect(source).toMatch(/addInstances\(/);
    expect(source).not.toMatch(/new (Mesh|IcosahedronGeometry)\(.*\bnodes\.length\b/);
  });
});

describe("InstancedEdges: one batched LineSegments for the whole edge set", () => {
  it("uses a single BufferGeometry/LineSegments, not one line object per edge", () => {
    const source = readSource("InstancedEdges.tsx");
    const geometryConstructions = source.match(/new BufferGeometry\(/g) ?? [];
    expect(geometryConstructions).toHaveLength(1);
    expect(source).toMatch(/<lineSegments/);
  });
});

describe("perf hygiene: no setState calls inside useFrame in the 3D scene/instance layers", () => {
  it("Graph3DScene's useFrame body never calls a React state setter", () => {
    const source = readSource("Graph3DScene.tsx");
    const useFrameBodies = Array.from(source.matchAll(/useFrame\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \}\);/g)).map(
      (m) => m[1],
    );
    expect(useFrameBodies.length).toBeGreaterThan(0);
    for (const body of useFrameBodies) {
      expect(body).not.toMatch(/\bset[A-Z]\w*\(/);
    }
  });
});

// Reflexion critique item 1 (BLOCKING, ADR-0501 fitness): nodes must have a
// real distance-driven LOD tier, and hidden edges must be actually removed
// from what's submitted to the GPU each frame (a draw-range cull), not
// merely recolored toward the background.
describe("LOD + edge culling (reflexion critique item 1)", () => {
  it("InstancedNodes registers real distance-driven LOD tiers via InstancedMesh2.addLOD", () => {
    const source = readSource("InstancedNodes.tsx");
    const addLodCalls = source.match(/\.addLOD\(/g) ?? [];
    // At least two extra tiers beyond the base (near) geometry.
    expect(addLodCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("InstancedEdges clamps the draw range to the visible edge count -- an actual GPU-side cull", () => {
    const source = readSource("InstancedEdges.tsx");
    expect(source).toMatch(/setDrawRange\(/);
    // The cull must be based on the filtered/visible edge list, not the raw edge count.
    expect(source).toMatch(/visible\.length \* 2/);
  });

  it("InstancedEdges no longer merely recolors hidden edges toward black as its only visibility mechanism", () => {
    const source = readSource("InstancedEdges.tsx");
    // A `fadeT` computed purely from a boolean-visible flag (the old, rejected
    // approach) must not be the visibility story; visibility now happens via
    // `visibleIds.has(...)` filtering BEFORE any color/position work occurs.
    expect(source).toMatch(/edges\.filter\(\(edge\) => visibleIds\.has\(edge\.source\) && visibleIds\.has\(edge\.target\)\)/);
  });
});

// Reflexion critique item 2 (BLOCKING, perf/reliability): no per-tick
// allocation in the worker, and the main-thread edge-position loop scales
// with visible edges, not total edges.
describe("no per-tick allocation / no O(all edges) main-thread loop (reflexion critique item 2)", () => {
  it("forceLayout.worker.ts recycles a preallocated buffer pool instead of allocating a fresh Float32Array every tick", () => {
    const source = readSource("forceLayout.worker.ts");
    expect(source).toMatch(/freeBuffers/);
    expect(source).toMatch(/function takeBuffer/);
    // The hot path (postTick) must pull from the pool, not construct fresh.
    const postTickBody = /function postTick\(\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    expect(postTickBody).toMatch(/takeBuffer\(/);
    expect(postTickBody).not.toMatch(/new Float32Array\(/);
  });

  it("InstancedEdges.applyPositions never allocates a Map or iterates the full edge list per tick", () => {
    const source = readSource("InstancedEdges.tsx");
    const applyPositionsBody = /applyPositions\(positions, idIndexMap\) \{([\s\S]*?)\n {6}\},/.exec(source)?.[1] ?? "";
    expect(applyPositionsBody.length).toBeGreaterThan(0);
    expect(applyPositionsBody).not.toMatch(/new Map/);
    // Must iterate the precomputed visible-edge list, not `edges` (the full set).
    expect(applyPositionsBody).toMatch(/visibleEdgesRef\.current/);
    expect(applyPositionsBody).not.toMatch(/for \(let i = 0; i < edges\.length/);
  });

  it("ForceLayoutClient exposes a releaseBuffer call so consumed tick buffers are recycled, not garbage", () => {
    const source = readSource("ForceLayoutClient.ts");
    expect(source).toMatch(/releaseBuffer/);
  });
});

// Reflexion critique item 3 (BLOCKING, C4 silent-supersession): r3f-forcegraph
// must not be a phantom, never-imported dependency once its integration is
// formally superseded -- see ADR-0505.
describe("no phantom r3f-forcegraph dependency (reflexion critique item 3 / ADR-0505)", () => {
  it("package.json no longer lists r3f-forcegraph as a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "package.json"), "utf-8"));
    expect(pkg.dependencies?.["r3f-forcegraph"]).toBeUndefined();
  });

  it("no source file in the graph route imports r3f-forcegraph", () => {
    const files = ["ForceLayoutClient.ts", "forceLayout.worker.ts", "Graph3DScene.tsx", "InstancedNodes.tsx", "InstancedEdges.tsx"];
    for (const file of files) {
      expect(readSource(file)).not.toMatch(/from ["']r3f-forcegraph["']/);
    }
  });
});

// Codex finding (BLOCKING, live-Chrome hardening pass): Graph3DScene.tsx's
// tick subscriber (~old lines 98-101, `latestPositionsRef`) used to call
// `map.set(ids[i], [positions[i * 3], ...])` -- a fresh `[x, y, z]` array
// allocation PER NODE PER TICK. Fixed by reusing a single flat Float32Array
// bulk-copied via `.set(positions)` once per tick; per-id reads only happen
// on discrete, low-frequency triggers (selection change / layout "end" /
// the community-hull interval), never inside the tick callback itself.
describe("zero-allocation tick path (Codex finding)", () => {
  it("Graph3DScene's onTick handler never allocates a [x, y, z] tuple per node", () => {
    const source = readSource("Graph3DScene.tsx");
    // T2 remediation: the tick handler is now passed as the `onTick` handler
    // to `useForceLayoutWorker` (see the worker-lifecycle describe block
    // below) rather than calling `layout.onTick(...)` directly -- same body,
    // relocated call shape.
    const onTickBody =
      /onTick: \(positions, ids, _alpha, revision, layout\) => \{([\s\S]*?)\n {4}\},/.exec(source)?.[1] ?? "";
    expect(onTickBody.length).toBeGreaterThan(0);
    // The old, rejected pattern: a fresh array literal built per node.
    expect(onTickBody).not.toMatch(/\.set\(ids\[i\],\s*\[/);
    expect(onTickBody).not.toMatch(/new Map<string, \[number, number, number\]>\(\)/);
    // The new pattern: one bulk typed-array copy per tick, not per node.
    // Phase 4a de-risking spike (plan Section 6.3): the copy source is now
    // `applied` (the raw worker `positions`, OR -- only while a mode-switch
    // transition is in flight -- a blended buffer derived from it via a
    // single other bulk `.set`-free pass in modeTransition.ts's
    // `blendPositions`, itself covered by its own dedicated unit tests) --
    // still exactly one bulk typed-array `.set()` call per tick either way,
    // never a per-node allocation.
    expect(onTickBody).toMatch(/buf\.set\(applied\)/);
  });

  it("per-id position reads happen through an accessor, not by rebuilding a Map every tick", () => {
    const source = readSource("Graph3DScene.tsx");
    expect(source).toMatch(/positionsAccessorRef/);
    expect(source).toMatch(/latestPositionsBufferRef/);
  });
});

// Issue 2 (BLOCKING): most nodes started off-screen because nothing ever
// moved the camera to frame the graph after the layout settled.
describe("camera fit-to-graph on load (Issue 2)", () => {
  it("Graph3DScene computes a bounding-sphere fit request once the worker layout ends (onEngineStop)", () => {
    const sceneSource = readSource("Graph3DScene.tsx");
    // T2 remediation: Graph3DScene now supplies an `onEnd` handler to
    // `useForceLayoutWorker` (see the worker-lifecycle describe block below)
    // instead of calling `layout.onEnd(...)` directly; the hook itself is
    // what wires that handler to the real `layout.onEnd(...)` subscription.
    expect(sceneSource).toMatch(/useForceLayoutWorker\(/);
    expect(sceneSource).toMatch(/onEnd: \(\) => \{/);
    expect(sceneSource).toMatch(/setFitRequest\(/);
    const hookSource = readSource("useForceLayoutWorker.ts");
    expect(hookSource).toMatch(/layout\.onEnd\(/);
  });

  it("CameraRig accepts and animates toward a fitRequest bounding-sphere prop, independent of single-node focus", () => {
    const source = readSource("CameraRig.tsx");
    expect(source).toMatch(/fitRequest/);
    expect(source).toMatch(/GraphFitRequest/);
  });

  // Browser-audit item 1 (defense-in-depth): the fit distance must be
  // hard-clamped well under the Canvas's `far: 4000` clipping plane, so a
  // pathological bounding-sphere radius can never push the camera into the
  // near-far-plane z-fighting regime.
  it("CameraRig clamps the computed fit distance below the scene's far clipping plane", () => {
    const cameraSource = readSource("CameraRig.tsx");
    const sceneSource = readSource("Graph3DScene.tsx");
    const farMatch = /far:\s*(\d+)/.exec(sceneSource);
    expect(farMatch).not.toBeNull();
    const far = Number(farMatch![1]);

    const clampMatch = /MAX_FIT_DISTANCE = (\d+)/.exec(cameraSource);
    expect(clampMatch).not.toBeNull();
    const maxFitDistance = Number(clampMatch![1]);
    expect(maxFitDistance).toBeLessThan(far);
    expect(cameraSource).toMatch(/Math\.min\(\s*MAX_FIT_DISTANCE/);
  });
});

// Issue 3a (BLOCKING): progressive disclosure must be the DEFAULT, and it
// must actually bound what reaches the GPU (InstancedMesh2 capacity /
// buffer sizes), not merely toggle a per-instance `visible` flag on an
// otherwise full-size allocation.
describe("progressive disclosure is the default + actually bounds GPU push (Issue 3a)", () => {
  it("GraphView's disclosure cap sits in the requested ~1000-2000 top-degree-node range", () => {
    const source = readFileSync(join(__dirname, "..", "GraphView.tsx"), "utf-8");
    const match = /PROGRESSIVE_DISCLOSURE_CAP = (\d+)/.exec(source);
    expect(match).not.toBeNull();
    const cap = Number(match![1]);
    expect(cap).toBeGreaterThanOrEqual(1000);
    expect(cap).toBeLessThanOrEqual(2000);
  });

  it("selecting a node also expands its neighbors into view, not just the node itself", () => {
    const source = readFileSync(join(__dirname, "..", "GraphView.tsx"), "utf-8");
    expect(source).toMatch(/for \(const neighborId of neighborsOf\(rawData, id\)\) next\.add\(neighborId\)/);
  });

  it("Graph3DScene feeds InstancedNodes/InstancedEdges/NodeLabels a bounded, visibleIds-filtered node/edge set (not the full dataset)", () => {
    const source = readSource("Graph3DScene.tsx");
    expect(source).toMatch(/const renderedNodes = useMemo\(\(\) => nodes\.filter\(\(n\) => visibleIds\.has\(n\.id\)\)/);
    expect(source).toMatch(
      /const renderedEdges = useMemo\(\s*\(\) => edges\.filter\(\(e\) => visibleIds\.has\(e\.source\) && visibleIds\.has\(e\.target\)\)/,
    );
    expect(source).toMatch(/<InstancedNodes[\s\S]*?nodes=\{renderedNodes\}/);
    expect(source).toMatch(/<InstancedEdges[\s\S]*?edges=\{renderedEdges\}/);
  });
});

// Issue 3c (BLOCKING): troika-three-text labels must be hard-capped --
// never one Text mesh per node.
describe("troika node labels are capped, never one-per-node (Issue 3c)", () => {
  it("NodeLabels hard-caps the labeled set via a maxLabels budget, not one label per node", () => {
    const source = readSource("NodeLabels.tsx");
    expect(source).toMatch(/DEFAULT_MAX_LABELS = 40/);
    expect(source).toMatch(/labeledNodes/);
    expect(source).toMatch(/out\.slice\(0, maxLabels\)/);
    // No naive "one <Text> per node" render path.
    expect(source).not.toMatch(/nodes\.map\(\(node\) => <Text/);
  });

  it("labeled-node selection always includes the hovered/selected node ids when present", () => {
    const source = readSource("NodeLabels.tsx");
    expect(source).toMatch(/for \(const id of \[selectedId, hoveredId\]\)/);
  });
});

// Browser-audit item 1 (BLOCKING, live-Chrome finding): a sparse/mostly-
// disconnected graph (e.g. a small real vault with far more nodes than
// relationships -- 20 entities/4 relationships is the exact demo-vault
// shape) diverged under pure forceManyBody repulsion + a single global
// forceCenter, which recenters the barycenter but never pulls an
// individual isolated node back toward it. Unbounded isolated-node drift
// produced a large bounding-sphere radius, which pushed the camera-fit
// distance far enough back that every node fell into InstancedNodes' most
// distant, flattest LOD tier -- rendering as near-invisible pinpoints
// ("shrinks to invisible pinpoints within ~1-3s of load"). Reproduced
// numerically (see the T2 job report) both for a 20-node/4-edge sparse
// graph and for the ~1500-node default disclosure cap. Fixed with a weak
// per-axis containment force (forceX/forceY/forceZ toward the origin) plus
// a tighter forceManyBody `distanceMax`, bounding how far any node -- in
// particular a fully isolated one -- can drift from center.
describe("force layout stays bounded for sparse/disconnected graphs (browser-audit item 1)", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    vi.stubGlobal("postMessage", postMessageSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("a 20-node graph with only 4 edges (mostly isolated nodes) settles to a bounded radius, not an exploded one", async () => {
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    expect(handler).toBeTypeOf("function");

    const nodeCount = 20;
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}` }));
    // Mirrors demo-vault's real sparsity: 20 entities, 4 relationships --
    // most nodes have no link at all.
    const links = [
      { source: "n0", target: "n1" },
      { source: "n1", target: "n2" },
      { source: "n3", target: "n4" },
      { source: "n5", target: "n6" },
    ];

    postMessageSpy.mockClear();
    // A large synchronous `warmupTicks` drives the simulation to its
    // converged (near-"end") state deterministically, without depending on
    // d3-timer's async scheduler -- `buildSimulation` posts one "tick"
    // message right after the warmup loop, before the async restart.
    handler!({
      data: { type: "init", nodes, links, warmupTicks: 500 },
    } as unknown as MessageEvent);
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);

    const tickMessages = postMessageSpy.mock.calls
      .map(([msg]) => msg)
      .filter((msg): msg is { type: "tick"; positions: Float32Array; ids: string[] } => msg.type === "tick");
    expect(tickMessages.length).toBeGreaterThanOrEqual(1);
    const { positions } = tickMessages[tickMessages.length - 1];

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < nodeCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
    // Unbounded (pre-fix), this settles around radius ~500 for this exact
    // fixture (see the T2 job report's numeric reproduction) -- comfortably
    // large enough to push the camera-fit distance past every LOD tier
    // threshold. A bounded containment force keeps it well under 250.
    expect(radius).toBeLessThan(250);
  });

  it("forceLayout.worker.ts applies a bounded containment force (forceX/forceY/forceZ toward the origin)", () => {
    const source = readSource("forceLayout.worker.ts");
    expect(source).toMatch(/forceX/);
    expect(source).toMatch(/forceY/);
    expect(source).toMatch(/forceZ/);
  });
});

// T2 remediation (browser-audit item 1 recurrence, demo-vault reindexed to
// entities=18/relationships=6/pages=14): the SAME live-Chrome finding
// resurfaced on a DIFFERENT graph shape after the containment-force fix
// above landed -- not because the fit-distance formula was wrong for this
// shape (it wasn't; see below), but because of a separate, environment-
// dependent (React 18 StrictMode dev-mode double-invoke of effects) worker-
// lifecycle bug. The fix moved the worker lifecycle out of Graph3DScene.tsx
// into `useForceLayoutWorker.ts` specifically so it could be exercised
// directly here (via React Testing Library's `renderHook`) without needing
// a real R3F `<Canvas>`/WebGL context, which jsdom cannot provide -- see
// `GraphView.test.tsx`/`webglFallback.test.tsx`'s own established
// convention of stubbing `Graph3DScene` out entirely for that same reason;
// mounting the full component here is genuinely infeasible without adding a
// WebGL-shim dependency this job isn't authorized to add. Both defects are
// covered in this file: the lifecycle fix directly below, and the
// fit-distance formula's genuine shape-responsiveness (further down) as
// defense-in-depth against a *future* framing regression, per this job's
// explicit instruction not to just re-tune constants for one shape.
describe("worker lifecycle survives React 18 StrictMode's dev-mode double-invoke (T2 remediation root cause)", () => {
  beforeEach(() => {
    fakeWorkers.length = 0;
  });

  it("useForceLayoutWorker creates its ForceLayoutClient/Worker inside the SAME effect that disposes it, never via useMemo (structural guard)", () => {
    const source = readSource("useForceLayoutWorker.ts");
    // The old, rejected pattern: a Worker memoized once via `useMemo`
    // (survives StrictMode's simulated unmount) while disposal lived in a
    // SEPARATE effect -- StrictMode's simulated remount then called
    // `.init()` again against an already-`.terminate()`-d Worker, whose
    // `postMessage` silently no-ops forever after (see the T2 job report).
    expect(source).not.toMatch(/useMemo\(\(\)\s*=>\s*new ForceLayoutClient/);
    const effectMatch =
      /useEffect\(\(\) => \{\s*const layout = new ForceLayoutClient\(createForceLayoutWorker\(\)\);[\s\S]*?\n {2}\}, \[\]\);/.exec(
        source,
      );
    expect(effectMatch).not.toBeNull();
    const effectBody = effectMatch![0];
    expect(effectBody).toMatch(/layoutRef\.current = layout;/);
    expect(effectBody).toMatch(/layout\.onTick\(/);
    expect(effectBody).toMatch(/layout\.onEnd\(/);
    expect(effectBody).toMatch(/return \(\) => \{/);
    expect(effectBody).toMatch(/layout\.dispose\(\);/);
    expect(effectBody).toMatch(/layoutRef\.current = null;/);
  });

  it("useForceLayoutWorker's data-change init effect reads the CURRENT worker via layoutRef, never a stale/memoized client", () => {
    const source = readSource("useForceLayoutWorker.ts");
    expect(source).toMatch(/const layout = layoutRef\.current;/);
    expect(source).toMatch(/if \(!layout \|\| nodes\.length === 0\) return;/);
  });

  it("Graph3DScene delegates to the real useForceLayoutWorker hook -- not a duplicated inline effect -- and never memoizes the Worker itself", () => {
    const sceneSource = readSource("Graph3DScene.tsx");
    expect(sceneSource).toMatch(/import \{ useForceLayoutWorker \} from ".\/useForceLayoutWorker";/);
    expect(sceneSource).toMatch(/useForceLayoutWorker\(nodes, edges, \{/);
    expect(sceneSource).not.toMatch(/useMemo\(\(\)\s*=>\s*new ForceLayoutClient/);
    expect(sceneSource).not.toMatch(/new ForceLayoutClient\(createForceLayoutWorker\(\)\)/);
  });

  // REAL RED->GREEN regression evidence against the actual production code
  // path -- mounts the REAL `useForceLayoutWorker` hook (the exact function
  // `Graph3DScene.tsx` calls, imported here unmodified) via React Testing
  // Library's `renderHook`, wrapped in `<React.StrictMode>`, with only the
  // Worker FACTORY faked (`vi.mock` above; jsdom has no real Worker/
  // separate-thread semantics to drive this against). Verified locally, by
  // temporarily reintroducing the pre-fix `useMemo`-owned-Worker shape into
  // `useForceLayoutWorker.ts` and rerunning this exact test, that it goes
  // RED against that shape (0 ticks/0 ends -- the second, StrictMode-
  // remount `layout.init()` call silently no-ops against the already-
  // terminated first Worker) and GREEN against the current fix (1 tick/
  // 1 end) -- see the T2 job report for that verification transcript.
  it("tick/end fire on the real useForceLayoutWorker hook after React 18 StrictMode's dev-mode mount->cleanup->remount dance", () => {
    const nodes = [{ id: "a" }];
    const edges: { source: string; target: string }[] = [];
    let ticks = 0;
    let ends = 0;

    renderHook(
      () =>
        useForceLayoutWorker(nodes, edges, {
          onTick: () => {
            ticks++;
          },
          onEnd: () => {
            ends++;
          },
        }),
      { wrapper: StrictMode },
    );

    // StrictMode's mount -> cleanup -> remount dance for the initial commit
    // is synchronous and has already completed by the time `renderHook`
    // returns: exactly one fake Worker should have survived it (the first
    // was created, then torn down by the simulated unmount, before it ever
    // got a chance to process anything). Flush the survivor now, mirroring
    // a real Worker's own thread only getting a turn after the React commit
    // settles.
    const surviving = fakeWorkers.filter((w) => !w.terminated);
    expect(surviving).toHaveLength(1);
    surviving[0].flush();

    expect(ticks).toBe(1);
    expect(ends).toBe(1);
  });
});

// T2 remediation, round 2 (production Graph-tab regression, still failing an
// independent live-browser gate after round 1's constant-extraction fix).
// Live browser instrumentation (patched `window.Worker` constructor
// capturing call stacks) found THREE Worker constructions firing within
// milliseconds of a single page load: one real script-based worker from
// `forceLayout.worker-*.js`, plus two additional `blob:`-URL workers with
// two DISTINCT call stacks. This job investigated whether the two blob
// workers are a second/third live force-layout worker (which would mean
// multiple independent physics simulations writing into shared state,
// explaining a "converges to a tiny cluster" symptom no single-worker
// headless test could ever catch) -- verified NOT to be the case, by two
// independent means:
//
// 1. Source-level: `createForceLayoutWorker` (the ONLY function in this
//    codebase that constructs the force-layout `Worker`) has exactly ONE
//    call site (`useForceLayoutWorker.ts`), and `useForceLayoutWorker`
//    itself has exactly ONE call site (`Graph3DScene.tsx`'s `SceneContents`).
//    Asserted below so a future edit that adds a second construction path
//    (e.g. a fallback, an eagerly-created worker alongside the lazy one, or
//    a duplicated inline effect) fails this test immediately.
// 2. Behavioral: the exact blob content string reported by the live
//    instrumentation (`/** Worker Module Bootstrap: #default **/`) is a
//    byte-for-byte match for `troika-worker-utils`'s `getWorker()` function
//    (`node_modules/troika-worker-utils/src/WorkerModules.js`:
//    `` `/** Worker Module Bootstrap: ${workerId.replace(/\*/g, '')} **/...` ``
//    -- for the default `workerId` of `'#default'`, this produces that EXACT
//    string). `troika-three-text` (imported by `NodeLabels.tsx`, unchanged
//    by any Phase 4a work) defines several DISTINCT worker modules with
//    DIFFERENT `workerId`s (a default font/registration module plus a
//    separately-keyed `TroikaTextSDFGenerator_JS_*` glyph-rasterization
//    module) -- `troika-worker-utils` spawns one `Worker` PER distinct
//    `workerId`, lazily, the first time that module is invoked. Since
//    `NodeLabels.tsx` calls `text.sync()` for up to 40 labels immediately on
//    mount (see that file's mount effect), this produces exactly the
//    observed pattern: two DISTINCT blob workers with two DISTINCT call
//    stacks (different troika internal call sites), firing within
//    milliseconds of load, one of which (font/registration) can be idle-
//    timed-out and its blob URL revoked shortly after (matching the "0
//    bytes -- possibly already revoked" observation). This is pre-existing
//    behavior (`NodeLabels.tsx`/`troika-three-text` predate Phase 4a and are
//    untouched by it), not a duplicated force-layout worker.
//
// CONCLUSION (verified, not assumed): the reported 3-worker observation is
// fully accounted for by 1 real force-layout worker + 2 legitimate troika
// text-rendering workers. This does NOT explain the still-reported
// collapse/zoom-unresponsive symptom; see this job's report for the
// remaining, live-browser-only-verifiable gap.
describe("exactly one live force-layout Worker per Graph3DScene mount (T2 remediation round 2 -- ruling out a duplicate-worker cause)", () => {
  it("createForceLayoutWorker has exactly one call site in the whole graph route tree", () => {
    const clientSource = readSource("ForceLayoutClient.ts");
    // The factory itself: defined once, and its only internal call is the
    // one inside useForceLayoutWorker.ts (checked below) -- ForceLayoutClient.ts
    // does not also self-invoke it anywhere (e.g. a module-level singleton).
    expect(clientSource.match(/createForceLayoutWorker\(/g)?.length ?? 0).toBe(1); // the `export function` declaration itself
    const hookSource = readSource("useForceLayoutWorker.ts");
    expect(hookSource.match(/createForceLayoutWorker\(\)/g)?.length ?? 0).toBe(1);
    const sceneSource = readSource("Graph3DScene.tsx");
    expect(sceneSource).not.toMatch(/createForceLayoutWorker/);
    expect(sceneSource).not.toMatch(/new ForceLayoutClient/);
    expect(sceneSource).not.toMatch(/new Worker\(/);
  });

  it("useForceLayoutWorker itself has exactly one call site (Graph3DScene.tsx's SceneContents) -- no second consumer anywhere in the graph route tree", () => {
    const sceneSource = readSource("Graph3DScene.tsx");
    expect(sceneSource.match(/useForceLayoutWorker\(/g)?.length ?? 0).toBe(1);
  });

  it("a mount followed by a realistic data-change re-render (nodes/edges identity change, e.g. a reindex) never constructs a second live Worker -- only one worker is ever un-terminated at a time", () => {
    fakeWorkers.length = 0;
    const { rerender } = renderHook(
      ({ nodes }: { nodes: { id: string }[] }) =>
        useForceLayoutWorker(nodes, [], { onTick: () => {}, onEnd: () => {} }),
      { initialProps: { nodes: [{ id: "a" }] } },
    );
    rerender({ nodes: [{ id: "a" }, { id: "b" }] }); // simulates a data-change reinit, not a remount
    rerender({ nodes: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const surviving = fakeWorkers.filter((w) => !w.terminated);
    expect(surviving.length).toBeLessThanOrEqual(1);
  });
});

// T2 remediation, item 3: the fit-distance computation must be genuinely
// responsive to the graph's ACTUAL computed bounding radius at "end" time --
// not a fixed target re-tuned for one shape -- so this class of regression
// (working for one demo-vault shape, breaking on the next reindex) is caught
// going forward. Exercises the REAL worker (not a hand-derived formula)
// against three meaningfully different shapes: sparse/few-edges, the exact
// demo-vault-equivalent shape (entities=18/relationships=6/pages=14,
// mode=both -- the shape that surfaced this remediation job), and a denser,
// larger shape.
describe("camera fit distance is responsive to the actual bounding radius across differently-shaped graphs (T2 remediation item 3)", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    vi.stubGlobal("postMessage", postMessageSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function settledFit(nodes: { id: string }[], links: { source: string; target: string }[]) {
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    postMessageSpy.mockClear();
    // A large synchronous warmupTicks drives the simulation to its converged
    // ("end"-equivalent) state deterministically, without depending on
    // d3-timer's async scheduler (same technique as the sparse-graph test
    // above).
    handler!({ data: { type: "init", nodes, links, warmupTicks: 500 } } as unknown as MessageEvent);
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);

    const tickMessages = postMessageSpy.mock.calls
      .map(([msg]) => msg)
      .filter(
        (msg): msg is { type: "tick"; positions: Float32Array; ids: string[] } => msg.type === "tick",
      );
    expect(tickMessages.length).toBeGreaterThanOrEqual(1);
    const { positions, ids } = tickMessages[tickMessages.length - 1];

    const indexMap = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) indexMap.set(ids[i], i);
    const visibleIds = new Set(nodes.map((n) => n.id));

    const fit = computeBoundingSphere(indexMap, positions, visibleIds);
    expect(fit).not.toBeNull();
    const distance = computeFitDistance(fit!.radius, 50);
    return { radius: fit!.radius, distance };
  }

  it("sparse graph (20 nodes, 4 edges): fit distance stays within bounds and is proportional to the settled radius", async () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` }));
    const links = [
      { source: "n0", target: "n1" },
      { source: "n1", target: "n2" },
      { source: "n3", target: "n4" },
      { source: "n5", target: "n6" },
    ];
    const { radius, distance } = await settledFit(nodes, links);
    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
    expect(distance).toBeLessThanOrEqual(MAX_FIT_DISTANCE);
    // Genuinely responsive to radius, not a fixed target: distance/radius
    // must sit at the theoretical padding/sin(fov/2) ratio (within floating-
    // point tolerance) whenever neither clamp is active.
    expect(distance / radius).toBeCloseTo(FIT_PADDING / Math.sin((25 * Math.PI) / 180), 3);
  });

  it("demo-vault-equivalent graph (32 nodes: 14 pages/5 wikilinks + 18 entities/6 relationships, mode=both -- the exact shape that surfaced this job): fit distance stays legible, not a tiny fraction of the frame", async () => {
    // Mirrors the real fixture from `GET /api/graph?mode=both` against the
    // reindexed demo-vault (entities=18/relationships=6/pages=14) -- fetched
    // and verified live against a running `mythic serve` instance during
    // this job's investigation.
    const pageIds = [
      "wiki/sources/acme-robotics-project-notes.md",
      "wiki/sources/orbital-dynamics-background.md",
      "wiki/entities/acme-robotics.md",
      "wiki/entities/falcon-arm.md",
      "wiki/entities/halcyon-thruster.md",
      "wiki/entities/meridian-logistics.md",
      "wiki/entities/orbital-dynamics.md",
      "wiki/entities/redacted-person-1.md",
      "wiki/entities/redacted-person-2.md",
      "wiki/entities/redacted-person-3.md",
      "wiki/entities/redacted-person-4.md",
      "wiki/entities/redacted-person-5.md",
      "wiki/entities/redacted-person-6.md",
      "wiki/entities/redacted-person-7.md",
    ];
    const pageLinks = [
      ["wiki/sources/orbital-dynamics-background.md", "wiki/entities/acme-robotics.md"],
      ["wiki/entities/acme-robotics.md", "wiki/entities/orbital-dynamics.md"],
      ["wiki/entities/falcon-arm.md", "wiki/entities/acme-robotics.md"],
      ["wiki/entities/halcyon-thruster.md", "wiki/entities/orbital-dynamics.md"],
      ["wiki/entities/orbital-dynamics.md", "wiki/entities/acme-robotics.md"],
    ];
    const entityIds = [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 42, 43, 44, 45, 46].map(
      (n) => `entity:${n}`,
    );
    const entityLinks = [
      [26, 33],
      [30, 34],
      [32, 42],
      [32, 43],
      [42, 43],
      [32, 26],
    ].map(([s, t]) => [`entity:${s}`, `entity:${t}`]);

    const nodes = [...pageIds, ...entityIds].map((id) => ({ id }));
    const links = [...pageLinks, ...entityLinks].map(([source, target]) => ({ source, target }));

    const { radius, distance } = await settledFit(nodes, links);
    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
    expect(distance).toBeLessThanOrEqual(MAX_FIT_DISTANCE);
    // The regression this job fixes: the graph must NOT be framed as a tiny
    // fraction of the viewport (which is what a stale/never-fired fit, or a
    // fit computed from a wrong/mismatched radius, would look like).
    // radius/distance is the on-screen-size proxy this job's report used
    // ("~100x100px patch in an ~1450x550px canvas" -- roughly 0.07-0.18 of
    // the frame -- is well below this floor).
    expect(radius / distance).toBeGreaterThan(0.2);
    expect(distance / radius).toBeCloseTo(FIT_PADDING / Math.sin((25 * Math.PI) / 180), 3);
  });

  it("denser/larger graph (300 nodes, avg degree 6): fit distance scales up with the larger settled radius -- never a fixed target", async () => {
    const graph = generateSyntheticGraph({ nodeCount: 300, avgDegree: 6, seed: 99 });
    const nodes = graph.nodes.map((n) => ({ id: n.id }));
    const links = graph.edges.map((e) => ({ source: e.source, target: e.target }));
    const { radius, distance } = await settledFit(nodes, links);
    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
    expect(distance).toBeLessThanOrEqual(MAX_FIT_DISTANCE);
    expect(distance / radius).toBeCloseTo(FIT_PADDING / Math.sin((25 * Math.PI) / 180), 3);
  });

  it("fit distance increases monotonically with the settled bounding radius across all three shapes above (genuinely responsive, not re-tuned per shape)", async () => {
    const sparse = await settledFit(
      Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` })),
      [
        { source: "n0", target: "n1" },
        { source: "n1", target: "n2" },
        { source: "n3", target: "n4" },
        { source: "n5", target: "n6" },
      ],
    );
    const denserGraph = generateSyntheticGraph({ nodeCount: 300, avgDegree: 6, seed: 99 });
    const denser = await settledFit(
      denserGraph.nodes.map((n) => ({ id: n.id })),
      denserGraph.edges.map((e) => ({ source: e.source, target: e.target })),
    );
    expect(denser.radius).toBeGreaterThan(sparse.radius);
    expect(denser.distance).toBeGreaterThan(sparse.distance);
  });
});

// T2 remediation, Finding 1 (live-Chrome finding): selecting ANY node
// zoomed the camera in far beyond any legible framing -- the selected node
// and its neighbors ended up entirely out of frame, leaving only a giant,
// overlapping, illegible label sprite on screen. ROOT CAUSE: the selection
// effect used to hand CameraRig a raw node position framed with a FIXED
// `z + 6` offset, ignoring the graph's actual scale entirely (see
// `CameraRig.tsx`'s `computeFitDistance`, whose own `MIN_FIT_DISTANCE` is
// already 20 world units -- more than 3x that fixed offset -- for even a
// near-zero-radius graph). Fix: selection now issues a `fitRequest` --
// exactly the SAME bounding-sphere-plus-`computeFitDistance` machinery the
// whole-graph fit-to-load path already uses -- scoped to the selected node
// plus its immediate neighbors, so it inherits the SAME MIN/MAX/padding
// invariants already exercised above for the whole-graph case. This can
// only be exercised directly against the pure math here (jsdom cannot
// mount a real R3F `<Canvas>`/WebGL context, this directory's established
// limit -- see this file's own StrictMode describe block's doc comment);
// the fully rendered, wheel-to-camera behavior on an actual selection
// remains a genuine, labeled limit, verifiable only live via Browser
// Validator, same honesty standard as the round-2/round-3 remediations
// above.
describe("selection-focus camera fit reuses the SAME bounding-sphere/fit-distance invariants as the whole-graph fit (T2 remediation, Finding 1)", () => {
  it("a tight 2-node selection (selected node + one close neighbor) produces a bounded, legible fit distance -- never a fixed few-world-units offset", () => {
    const indexMap = new Map([
      ["selected", 0],
      ["neighbor", 1],
    ]);
    // Positions 10 world units apart -- comfortably larger than the OLD
    // fixed `z + 6` offset this job replaces, but still a "tight" cluster
    // relative to a real settled layout.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0]);
    const focusIds = new Set(["selected", "neighbor"]);

    const fit = computeBoundingSphere(indexMap, positions, focusIds);
    expect(fit).not.toBeNull();
    const distance = computeFitDistance(fit!.radius, 50);

    // Never a fixed ~6-unit distance (the old, rejected behavior) --
    // computeFitDistance's own floor already guarantees this, but assert
    // it explicitly here as the regression this job fixes.
    expect(distance).toBeGreaterThan(6);
    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
    expect(distance).toBeLessThanOrEqual(MAX_FIT_DISTANCE);
  });

  it("a widely spread selection (selected node + far-flung neighbors) scales the fit distance up, not a fixed constant -- the exact defect class this job fixes", () => {
    const indexMap = new Map([
      ["selected", 0],
      ["n1", 1],
      ["n2", 2],
      ["n3", 3],
    ]);
    // A selected node with neighbors spread ~200 world units away --
    // representative of a real settled force-directed layout, and the
    // shape that most starkly exposed the old fixed-offset defect (the
    // node and its neighbors were entirely out of frame at a `z + 6`
    // distance from a graph this size).
    const positions = new Float32Array([0, 0, 0, 200, 0, 0, -200, 0, 0, 0, 200, 0]);
    const focusIds = new Set(["selected", "n1", "n2", "n3"]);

    const fit = computeBoundingSphere(indexMap, positions, focusIds);
    expect(fit).not.toBeNull();
    const distance = computeFitDistance(fit!.radius, 50);

    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
    expect(distance).toBeLessThanOrEqual(MAX_FIT_DISTANCE);
    // Genuinely responsive to the selection's own spread, exactly like the
    // whole-graph fit tested above -- proportional to radius wherever
    // neither clamp is active.
    expect(distance / fit!.radius).toBeCloseTo(FIT_PADDING / Math.sin((25 * Math.PI) / 180), 3);
  });

  it("an isolated selected node with no neighbors still gets a sane, non-degenerate fit distance (radius floor), never a near-zero/inside-the-node distance", () => {
    const indexMap = new Map([["selected", 0]]);
    const positions = new Float32Array([5, 5, 5]);
    const focusIds = new Set(["selected"]);

    const fit = computeBoundingSphere(indexMap, positions, focusIds);
    expect(fit).not.toBeNull();
    const distance = computeFitDistance(fit!.radius, 50);

    expect(distance).toBeGreaterThanOrEqual(MIN_FIT_DISTANCE);
  });

  it("Graph3DScene's selection effect computes a bounding-sphere fit request over the selected node's neighborhood, not a raw focusTarget offset (structural)", () => {
    const source = readSource("Graph3DScene.tsx");
    // T3-advisory H2/H3 refactor note: the neighborhood-scoped bounding-
    // sphere computation now lives in the shared pure helper
    // `computeSelectionFit` (so the settle handler can issue the identical
    // fit); the effect routes through it. Original intent unchanged: the
    // selection fit is the selected node's 1-hop neighborhood through the
    // SAME `computeBoundingSphere`/`setFitRequest` path as the whole-graph
    // fit -- never a raw fixed-offset focusTarget.
    const helperMatch = /export function computeSelectionFit\(([\s\S]*?)\n\}/.exec(source);
    expect(helperMatch).not.toBeNull();
    expect(helperMatch![1]).toMatch(/neighborsOf\(/);
    expect(helperMatch![1]).toMatch(/computeBoundingSphere\(/);
    const effectMatch = /useEffect\(\(\) => \{\s*if \(!selectedId\) return;([\s\S]*?)\n {2}\}, \[selectedId\]\);/.exec(
      source,
    );
    expect(effectMatch).not.toBeNull();
    const body = effectMatch![1];
    expect(body).toMatch(/computeSelectionFit\(/);
    expect(body).toMatch(/setFitRequest\(/);
    // The old, rejected pattern this job removes: handing CameraRig a raw
    // position via `setFocusTarget`.
    expect(body).not.toMatch(/setFocusTarget\(/);
    expect(source).not.toMatch(/const \[focusTarget, setFocusTarget\]/);
  });

  it("CameraRig is fed a null focusTarget from Graph3DScene -- selection no longer routes through the fixed-offset focus path (structural)", () => {
    const source = readSource("Graph3DScene.tsx");
    expect(source).toMatch(/<CameraRig focusTarget=\{null\} fitRequest=\{fitRequest\} \/>/);
  });
});

// T2 remediation, Finding 2a (live-Chrome finding): clicking the "Switch to
// 2D"/"Switch to 3D" toggle -- a deliberate, WORKING user action -- fired
// the SAME code path as a genuine WebGL context-loss failure, showing the
// "3D rendering became unavailable" message on a normal manual toggle.
// ROOT CAUSE: unmounting `Graph3DScene` (exactly what the manual toggle
// does) tears down the R3F `<Canvas>`; three.js's `WebGLRenderer.dispose()`
// (invoked internally during that teardown) calls its own
// `forceContextLoss()`, which deliberately fires the SAME `webglcontextlost`
// event a real driver crash/GPU reset would. See `isGenuineContextLoss`'s
// own doc comment in Graph3DScene.tsx for the full ordering argument (the
// browser dispatches that event asynchronously, strictly after this
// component's own synchronous unmount-cleanup effects have already run,
// which is what makes the `unmounting` flag below a reliable signal).
describe("genuine WebGL context loss is distinguished from an intentional component unmount (T2 remediation, Finding 2a)", () => {
  it("isGenuineContextLoss is false while unmounting, regardless of whether it was already reported", () => {
    expect(isGenuineContextLoss(false, true)).toBe(false);
    expect(isGenuineContextLoss(true, true)).toBe(false);
  });

  it("isGenuineContextLoss is true on the FIRST report while mounted (a real context-loss event)", () => {
    expect(isGenuineContextLoss(false, false)).toBe(true);
  });

  it("isGenuineContextLoss is false once already reported, even while still mounted (no duplicate reports)", () => {
    expect(isGenuineContextLoss(true, false)).toBe(false);
  });

  it("Graph3DScene wires an unmount-tracking ref into its webglcontextlost report path, and checks it via isGenuineContextLoss before reporting (structural)", () => {
    const source = readSource("Graph3DScene.tsx");
    const wrapperMatch = /export function Graph3DScene\(props: Graph3DSceneProps\) \{([\s\S]*?)\n\}\n\nexport function SceneContents/.exec(
      source,
    );
    // Fall back to matching to end-of-file if SceneContents isn't defined
    // after the wrapper (it isn't -- SceneContents is defined earlier in
    // this file -- so match to the closing brace of Graph3DScene itself).
    const body = wrapperMatch
      ? wrapperMatch[1]
      : /export function Graph3DScene\(props: Graph3DSceneProps\) \{([\s\S]*)/.exec(source)![1];
    expect(body).toMatch(/const unmountingRef = useRef\(false\);/);
    expect(body).toMatch(/unmountingRef\.current = true;/);
    expect(body).toMatch(/isGenuineContextLoss\(reported\.current, unmountingRef\.current\)/);
  });

  it("Graph3DScene fires onReady from the same onCreated handler that wires the webglcontextlost listener, so a caller can clear a stale failure message once 3D actually re-renders (Finding 2c, structural)", () => {
    const source = readSource("Graph3DScene.tsx");
    const onCreatedMatch = /onCreated=\{\(state\) => \{([\s\S]*?)\n {8}\}\}/.exec(source);
    expect(onCreatedMatch).not.toBeNull();
    expect(onCreatedMatch![1]).toMatch(/onReady\?\.\(\);/);
  });
});
