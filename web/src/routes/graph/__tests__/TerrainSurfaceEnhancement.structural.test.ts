// Phase 4e (plan Section 6.7, Terrain shipped-asset capture): structural
// coverage for the placeholder chrome-layer enhancement wired into
// `TerrainSurface.tsx` (matcap material, skybox/HDRI environment, optional
// landmark meshes). Additive to, and deliberately separate from,
// `TerrainSurface.structural.test.ts` (the Phase 4a spike's original
// single-draw-call coverage) so that file's existing assertions are
// preserved byte-for-byte -- see this job's report. Same jsdom-has-no-WebGL
// convention as that file and the rest of this directory: R3F host elements
// (`<mesh>`, `<meshMatcapMaterial>`, `<primitive>`) cannot mount via plain
// `render()` outside a real `<Canvas>`, so these invariants are checked
// structurally against the source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readThreeSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("TerrainSurface: placeholder chrome-layer enhancement (matcap material)", () => {
  it("still contains exactly one <meshStandardMaterial> (the original spike's fallback, untouched) plus exactly one <meshMatcapMaterial> (the new enhancement) -- never a material swap that could break the single-draw-call ground mesh into two", () => {
    const source = readThreeSource("TerrainSurface.tsx");
    expect(source.match(/<meshStandardMaterial/g) ?? []).toHaveLength(1);
    expect(source.match(/<meshMatcapMaterial/g) ?? []).toHaveLength(1);
  });

  it("still constructs exactly one BufferGeometry per rebuild -- the matcap enhancement does not add a second ground mesh", () => {
    const source = readThreeSource("TerrainSurface.tsx");
    expect(source.match(/new BufferGeometry\(/g) ?? []).toHaveLength(1);
  });

  it("loads the matcap via the non-throwing optional-asset loader, never drei's suspense-based useTexture", () => {
    const source = readThreeSource("TerrainSurface.tsx");
    expect(source).toMatch(/useOptionalTexture/);
    expect(source).not.toMatch(/from "@react-three\/drei"/);
  });

  it("the matcap material path is additive: the vertexColors tier-banding fallback still renders unconditionally in source (both branches use it)", () => {
    const source = readThreeSource("TerrainSurface.tsx");
    const vertexColorsMatches = source.match(/vertexColors/g) ?? [];
    expect(vertexColorsMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("defaults `assets` to the shipped placeholder manifest but accepts an empty config to prove the zero-generated-asset path is reachable without any file present", () => {
    const source = readThreeSource("TerrainSurface.tsx");
    expect(source).toMatch(/assets = DEFAULT_TERRAIN_ASSETS/);
    const manifestSource = readThreeSource("terrainAssetManifest.ts");
    expect(manifestSource).toMatch(/NO_TERRAIN_ASSETS/);
  });

  it("the InstancedMesh2 node layer remains untouched by the enhancement (same invariant as the original spike, re-checked here)", () => {
    const source = readThreeSource("InstancedNodes.tsx");
    expect(source.match(/new InstancedMesh2\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/TerrainSurface|matcap|Trellis/i);
  });
});

describe("TerrainEnvironment: skybox/HDRI, enhancement-only", () => {
  it("only mutates scene.background when the texture has actually loaded -- renders nothing (no JSX primitive) otherwise", () => {
    const source = readThreeSource("TerrainEnvironment.tsx");
    expect(source).toMatch(/status !== "loaded"/);
    expect(source).toMatch(/return null/);
  });

  it("uses the non-throwing equirect loader, never a suspense-based hook", () => {
    const source = readThreeSource("TerrainEnvironment.tsx");
    expect(source).toMatch(/useOptionalEquirectTexture/);
  });

  it("restores the previous scene.background on cleanup instead of leaking the texture across mode switches", () => {
    const source = readThreeSource("TerrainEnvironment.tsx");
    expect(source).toMatch(/previousBackground/);
  });
});

describe("TerrainLandmarks: optional Trellis2 GLBs, per-landmark independent fallback", () => {
  it("each landmark loads independently and renders null (not the whole list) on a failed/missing GLB", () => {
    const source = readThreeSource("TerrainLandmarks.tsx");
    expect(source).toMatch(/useOptionalGLTF/);
    expect(source).toMatch(/status !== "loaded"/);
    expect(source).toMatch(/return null/);
  });

  it("places each landmark by sampling the SAME shared elevation grid TerrainSurface and the worker use, never an independently-computed heightfield", () => {
    const source = readThreeSource("TerrainLandmarks.tsx");
    expect(source).toMatch(/sampleElevation/);
    expect(source).toMatch(/from "\.\/terrainElevation"/);
  });

  it("never introduces a per-node primitive -- only per-landmark (O(1)-to-O(tens)), keeping the node/edge draw-call budget (plan Section 3.2) untouched", () => {
    const source = readThreeSource("TerrainLandmarks.tsx");
    expect(source).not.toMatch(/new InstancedMesh2\(/);
    expect(source).not.toMatch(/from "@three\.ez\/instanced-mesh"/);
  });
});
