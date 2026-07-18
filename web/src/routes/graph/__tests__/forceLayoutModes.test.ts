// Phase 4a de-risking spike (plan Section 6.3, bet 1): structural coverage
// for `forceLayout.worker.ts`'s per-mode force-configuration branching,
// following this directory's own established convention (see
// `graphPerf.synthetic.test.ts`'s "forceLayout worker: batched, worker-
// owned layout" describe block) of stubbing the global `postMessage` and
// driving the REAL worker module's `onmessage` handler directly -- jsdom
// has no real Worker/separate-thread boundary, so this is the worker's
// actual production code path, not a reimplementation of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSyntheticGraph } from "../synthetic";

function extractTickPositions(calls: unknown[][]): Float32Array | null {
  for (const [msg] of calls) {
    const m = msg as { type: string; positions?: Float32Array };
    if (m.type === "tick" && m.positions) return m.positions;
  }
  return null;
}

describe("forceLayout.worker.ts mode branching (Phase 4a spike)", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    vi.stubGlobal("postMessage", postMessageSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function runInit(mode: "cloud" | "orbital" | "strata" | "terrain" | undefined) {
    const graph = generateSyntheticGraph({ nodeCount: 60, avgDegree: 3, seed: 21 });
    postMessageSpy.mockClear();
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    handler!({
      data: {
        type: "init",
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          community: (n as { community?: number }).community,
          level: (n as { level?: number }).level,
          centrality: (n as { centrality?: number }).centrality,
        })),
        links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
        warmupTicks: 40,
        mode,
      },
    } as unknown as MessageEvent);
    const positions = extractTickPositions(postMessageSpy.mock.calls);
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);
    return positions;
  }

  it("omitting `mode` entirely behaves EXACTLY like explicit \"cloud\" -- zero behavior change for every pre-spike caller", async () => {
    const withoutMode = await runInit(undefined);
    vi.resetModules();
    postMessageSpy.mockClear();
    const withCloud = await runInit("cloud");
    expect(withoutMode).not.toBeNull();
    expect(withCloud).not.toBeNull();
    expect(Array.from(withoutMode!)).toEqual(Array.from(withCloud!));
  });

  it("orbital mode settles to genuinely different positions than cloud for the same fixture (a real, distinct physics target -- not a re-skinned cloud layout)", async () => {
    const cloud = await runInit("cloud");
    vi.resetModules();
    postMessageSpy.mockClear();
    const orbital = await runInit("orbital");
    expect(cloud).not.toBeNull();
    expect(orbital).not.toBeNull();
    expect(Array.from(orbital!)).not.toEqual(Array.from(cloud!));
  });

  it("strata mode settles to genuinely different positions than cloud", async () => {
    const cloud = await runInit("cloud");
    vi.resetModules();
    postMessageSpy.mockClear();
    const strata = await runInit("strata");
    expect(Array.from(strata!)).not.toEqual(Array.from(cloud!));
  });

  it("strata mode actually stacks nodes into distinct y-layers by level (not just 'different', but level-separated)", async () => {
    const graph = generateSyntheticGraph({ nodeCount: 60, avgDegree: 3, seed: 21 });
    postMessageSpy.mockClear();
    await import("../three/forceLayout.worker");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    const nodesWithLevel = graph.nodes as unknown as { id: string; level: number }[];
    handler!({
      data: {
        type: "init",
        nodes: nodesWithLevel.map((n) => ({ id: n.id, level: n.level })),
        links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
        warmupTicks: 60,
        mode: "strata",
      },
    } as unknown as MessageEvent);
    const positions = extractTickPositions(postMessageSpy.mock.calls);
    const tickMsg = postMessageSpy.mock.calls.map(([m]) => m as { type: string; ids?: string[] }).find(
      (m) => m.type === "tick",
    );
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);

    expect(positions).not.toBeNull();
    expect(tickMsg?.ids).toBeDefined();

    const idToLevel = new Map(nodesWithLevel.map((n) => [n.id, n.level]));
    const yByLevel = new Map<number, number[]>();
    tickMsg!.ids!.forEach((id, i) => {
      const level = idToLevel.get(id)!;
      const list = yByLevel.get(level) ?? [];
      list.push(positions![i * 3 + 1]);
      yByLevel.set(level, list);
    });
    // Every level's mean y should be distinct from every other level's --
    // the whole point of "strata" (bounded, deterministic separation, not
    // merely "not identical" noise).
    const means = Array.from(yByLevel.entries()).map(([level, ys]) => [
      level,
      ys.reduce((a, b) => a + b, 0) / ys.length,
    ]);
    for (let i = 0; i < means.length; i++) {
      for (let j = i + 1; j < means.length; j++) {
        expect(Math.abs(means[i][1] - means[j][1])).toBeGreaterThan(5);
      }
    }
  });

  it("terrain mode elevates nodes within the heightfield's own bounded [0, TERRAIN_MAX_HEIGHT] range -- proves the posted y is the elevation-adjusted display value, not raw (unbounded) physics drift", async () => {
    const terrain = await runInit("terrain");
    expect(terrain).not.toBeNull();
    const { TERRAIN_MAX_HEIGHT } = await import("../three/terrainElevation");

    let min = Infinity;
    let max = -Infinity;
    for (let i = 1; i < terrain!.length; i += 3) {
      if (terrain![i] < min) min = terrain![i];
      if (terrain![i] > max) max = terrain![i];
    }
    // Real (non-degenerate) elevation, but never outside the heightfield's
    // own normalized-and-scaled range -- raw physics y (see the "cloud"
    // fixture in the sibling test above) is under no such bound, so this
    // specifically confirms the elevation override, not incidental jitter.
    expect(max - min).toBeGreaterThan(0);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(TERRAIN_MAX_HEIGHT);
  });

  // T2 remediation (production Graph-tab regression, BLOCKER: browser
  // report of the default/"cloud" Graph tab visibly collapsing from a
  // correctly-spread layout into a tiny, static ball within 1-8 seconds of
  // load, reproduced on `?syntheticGraph=300`). This test drives the REAL
  // worker module through a genuine, un-mocked full alpha-decay settle (not
  // just the first tick, like the sibling tests above) -- the direct,
  // symptom-level regression check the packet's instruction 4 asks for.
  // Two independent assertions, deliberately not just one: (1) the radius
  // stays essentially stable from the first posted tick through the "end"
  // event (catches a bug that only manifests over TIME, i.e. a genuine
  // "collapses after N seconds" pattern); (2) the FINAL settled radius also
  // falls within a tight absolute band around this job's own independently
  // re-measured Phase-3 baseline (catches a bug that's wrong from the very
  // first tick -- e.g. a doubled/duplicately-applied containment force). RED
  // vs GREEN was verified directly, not assumed: with a temporarily
  // reintroduced second, distinctly-keyed 0.1-strength x/y/z containment
  // force stacked on top of the real one (simulating exactly the
  // "compounding due to mode branching" pattern this job's packet warned
  // about), assertion (1) alone did NOT reliably fail -- both the first and
  // last tick are already under the doubled force, so the ratio between
  // them stays inside tolerance (measured ~318 vs ~380 at N=300, ~495 vs
  // ~569 at N=1500) -- but assertion (2), anchored to the independently
  // measured absolute baseline, failed correctly at both N=300 and N=1500.
  // This is why both assertions are kept, not just the cheaper relative one.
  //
  // If this test needs to be updated because a real design decision (not a
  // regression) intentionally changes the cloud layout's scale, deliberately
  // re-derive the two bands below on the current fixture with a temporary
  // debug script rather than loosening the tolerance far enough to hide a
  // real compounding bug.
  describe("cloud mode's full settle does not collapse over time (direct symptom regression)", () => {
    async function settleRadii(nodeCount: number, avgDegree: number, seed: number) {
      const postMessageSpy = vi.fn();
      vi.stubGlobal("postMessage", postMessageSpy);
      vi.resetModules();
      const graph = generateSyntheticGraph({ nodeCount, avgDegree, seed });
      await import("../three/forceLayout.worker");
      const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
      handler!({
        data: {
          type: "init",
          nodes: graph.nodes.map((n) => ({ id: n.id, community: (n as { community?: number }).community })),
          links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
          warmupTicks: 60,
          mode: "cloud",
        },
      } as unknown as MessageEvent);
      // Drain real timers until the simulation's own "end" event fires
      // (onEngineStop) -- mirrors the live-Chrome repro window ("within 1-8
      // seconds of load"), not just the first tick.
      for (let i = 0; i < 800; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (postMessageSpy.mock.calls.some(([m]) => (m as { type: string }).type === "end")) break;
      }
      handler!({ data: { type: "stop" } } as unknown as MessageEvent);
      vi.unstubAllGlobals();

      function radiusOf(buf: Float32Array): number {
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < buf.length / 3; i++) {
          const x = buf[i * 3], y = buf[i * 3 + 1], z = buf[i * 3 + 2];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
      }

      const ticks = postMessageSpy.mock.calls
        .map(([m]) => m as { type: string; positions?: Float32Array })
        .filter((m) => m.type === "tick");
      const endFired = postMessageSpy.mock.calls.some(([m]) => (m as { type: string }).type === "end");
      return {
        endFired,
        first: radiusOf(ticks[0].positions!),
        last: radiusOf(ticks[ticks.length - 1].positions!),
      };
    }

    it("N=300 (the exact `?syntheticGraph=300` browser-report repro shape): radius stays within 25% of its first-posted-tick value all the way to settle, AND lands within a tight absolute band around the independently re-measured Phase-3 baseline (~380 units)", async () => {
      const { endFired, first, last } = await settleRadii(300, 4, 1);
      expect(endFired).toBe(true);
      expect(last).toBeGreaterThan(first * 0.75);
      expect(last).toBeLessThan(first * 1.25);
      expect(last).toBeGreaterThan(350);
      expect(last).toBeLessThan(410);
    }, 20000);

    it("N=1500 (the production progressive-disclosure default): radius stays within 25% of its first-posted-tick value all the way to settle, AND lands within a tight absolute band around the independently re-measured Phase-3 baseline (~569 units)", async () => {
      const { endFired, first, last } = await settleRadii(1500, 4, 1);
      expect(endFired).toBe(true);
      expect(last).toBeGreaterThan(first * 0.75);
      expect(last).toBeLessThan(first * 1.25);
      expect(last).toBeGreaterThan(530);
      expect(last).toBeLessThan(610);
    }, 20000);
  });

  it("every posted terrain-mode node position sits ON the same heightfield sampled at its own x/z (nodes 'ride the surface', not float above/through it)", async () => {
    const graph = generateSyntheticGraph({ nodeCount: 40, avgDegree: 3, seed: 5 });
    const nodesWithCentrality = graph.nodes as unknown as { id: string; centrality: number }[];
    postMessageSpy.mockClear();
    await import("../three/forceLayout.worker");
    const { buildElevationGrid, sampleElevation, TERRAIN_MAX_HEIGHT } = await import("../three/terrainElevation");
    const handler = (self as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage;
    handler!({
      data: {
        type: "init",
        nodes: nodesWithCentrality.map((n) => ({ id: n.id, centrality: n.centrality })),
        links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
        warmupTicks: 40,
        mode: "terrain",
      },
    } as unknown as MessageEvent);
    const tickMsg = postMessageSpy.mock.calls
      .map(([m]) => m as { type: string; positions?: Float32Array; ids?: string[] })
      .find((m) => m.type === "tick");
    handler!({ data: { type: "stop" } } as unknown as MessageEvent);

    expect(tickMsg?.positions).toBeDefined();
    const positions = tickMsg!.positions!;
    // Independently rebuild the SAME grid from the posted x/z + centrality
    // (mirroring applyTerrainElevation's own aggregation) and confirm every
    // node's posted y matches the sampled elevation at its own x/z.
    const points = nodesWithCentrality.map((n, i) => ({
      x: positions[i * 3],
      z: positions[i * 3 + 2],
      weight: n.centrality ?? 0.1,
    }));
    const grid = buildElevationGrid(points);
    for (let i = 0; i < nodesWithCentrality.length; i++) {
      const expectedY = sampleElevation(grid, positions[i * 3], positions[i * 3 + 2]) * TERRAIN_MAX_HEIGHT;
      expect(positions[i * 3 + 1]).toBeCloseTo(expectedY, 5);
    }
  });
});
