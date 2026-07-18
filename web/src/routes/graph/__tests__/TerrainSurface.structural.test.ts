// Phase 4a de-risking spike (plan Section 6.3, bet 2): structural coverage
// for `TerrainSurface.tsx`, mirroring this directory's own established
// convention for the other single-draw-call layers (see
// `graphPerf.synthetic.test.ts`'s "InstancedNodes: one InstancedMesh2..."
// and "InstancedEdges: one batched LineSegments..." describe blocks) --
// `<mesh>`/`<meshStandardMaterial>` are R3F reconciler-only host elements
// that cannot mount via `@testing-library/react`'s plain `render()` outside
// a real `<Canvas>` (jsdom has no WebGL context, same limit as every other
// R3F component in this directory), so the invariants below are checked
// structurally against the source, the same way `InstancedNodes.tsx`'s own
// single-draw-call guarantee is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("TerrainSurface: one ground mesh, never one primitive per node (preserves the InstancedMesh2 node-layer budget -- plan Section 6.3's explicit preservation requirement)", () => {
  it("constructs exactly one BufferGeometry per rebuild -- a single ground mesh, not per-cell/per-node geometry", () => {
    const source = readSource("TerrainSurface.tsx");
    const geometryConstructions = source.match(/new BufferGeometry\(/g) ?? [];
    expect(geometryConstructions).toHaveLength(1);
    expect(source).toMatch(/<mesh /);
  });

  it("uses vertex colors for tier banding (one draw call, colored per-vertex) rather than a material swap per tier", () => {
    const source = readSource("TerrainSurface.tsx");
    expect(source).toMatch(/vertexColors/);
    // Not one <meshStandardMaterial> per tier.
    const materialTags = source.match(/<meshStandardMaterial/g) ?? [];
    expect(materialTags).toHaveLength(1);
  });

  it("reads elevation from the SAME shared terrainElevation.ts module the worker uses -- never a second, independently-computed heightfield", () => {
    const source = readSource("TerrainSurface.tsx");
    expect(source).toMatch(/from "\.\/terrainElevation"/);
    const workerSource = readSource("forceLayout.worker.ts");
    expect(workerSource).toMatch(/from "\.\/terrainElevation"/);
  });

  it("the InstancedMesh2 node layer (InstancedNodes.tsx) is untouched by the terrain addition -- still exactly one constructor call site, no per-node primitive introduced for terrain", () => {
    const source = readSource("InstancedNodes.tsx");
    const constructorCalls = source.match(/new InstancedMesh2\(/g) ?? [];
    expect(constructorCalls).toHaveLength(1);
    expect(source).not.toMatch(/TerrainSurface/);
  });
});
