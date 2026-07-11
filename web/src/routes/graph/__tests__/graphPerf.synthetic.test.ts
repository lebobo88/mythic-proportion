// Synthetic-graph perf harness (per the §4.10 test plan): exercises the 3D
// scene's data + layout path at the ~10k/~50k-node target WITHOUT a large
// real vault (the real vault is tiny). Deliberately asserts STRUCTURAL
// budget only -- one batched worker "tick" message carrying every node's
// position (not one message per node/frame), and that the worker owns the
// simulation (not the main-thread client) -- NEVER a hard fps number
// (headless/CI fps is flaky and meaningless without a real GPU).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSyntheticGraph } from "../synthetic";

const THREE_DIR = join(__dirname, "..", "three");
function readSource(fileName: string): string {
  return readFileSync(join(THREE_DIR, fileName), "utf-8");
}

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
