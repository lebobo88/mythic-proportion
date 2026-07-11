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
