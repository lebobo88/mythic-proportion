// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-TERRAIN: "hillshade surface plus contour lines plus an HDRI sky ...
// Light theme uses a bright high-key sky paired with darkened graph
// elements"; Section 8.3 item 6: "Light-theme Terrain shows visible
// node-vs-sky separation"). Same "jsdom has no WebGL, check structurally
// against source" convention as `TerrainSurface.structural.test.ts` and
// `TerrainSurfaceEnhancement.structural.test.ts` -- additive to, and
// deliberately separate from, both of those so their existing assertions
// stay intact byte-for-byte.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readThreeSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("TerrainSurface: hillshade + contour chrome, still one ground mesh", () => {
  const source = readThreeSource("TerrainSurface.tsx");

  it("still constructs exactly one BufferGeometry and one meshStandardMaterial -- hillshade/contours modulate the SAME vertex-color buffer, never a second mesh", () => {
    expect(source.match(/new BufferGeometry\(/g) ?? []).toHaveLength(1);
    expect(source.match(/<meshStandardMaterial/g) ?? []).toHaveLength(1);
  });

  it("computes hillshade via the shared, pure terrainChrome.ts helper -- never a duplicated slope formula", () => {
    expect(source).toMatch(/from "\.\/terrainChrome"/);
    expect(source).toMatch(/computeHillshade/);
  });

  it("blends major AND minor contour bands via contourBandFactor -- two distinct bands, per Section 5.2's major/minor token pair", () => {
    expect(source).toMatch(/contourBandFactor/);
    expect(source).toMatch(/contourMajor/);
    expect(source).toMatch(/contourMinor/);
  });

  it("reads --graph-terrain-hillshade-strength via the graph-colors.ts token helper, never a hardcoded literal blend factor", () => {
    expect(source).toMatch(/hillshadeStrength/);
  });

  it("passes a token-driven fallback sky color into TerrainEnvironment -- the light-theme structural fix must actually be visible with zero generated HDRI assets", () => {
    expect(source).toMatch(/<TerrainEnvironment[\s\S]*fallbackColor=/);
  });

  // Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix b):
  // TerrainSurface now accepts an `opacity` prop so Graph3DScene can give
  // Terrain the same incoming/outgoing cross-fade participation the other
  // three modes already have, instead of a hard mount/unmount boundary.
  it("accepts an optional opacity prop, defaulting to 1 so every pre-remediation caller is byte-identical", () => {
    expect(source).toMatch(/opacity\?:\s*number/);
    expect(source).toMatch(/opacity = 1/);
  });

  it("threads opacity into BOTH ground-mesh material branches (matcap and standard), toggling transparent only when actually fading -- never leaving one branch stuck at full opacity", () => {
    expect(source).toMatch(/<meshMatcapMaterial[^>]*opacity=\{opacity\}/);
    expect(source).toMatch(/<meshStandardMaterial[^>]*opacity=\{opacity\}/);
    expect(source).toMatch(/transparent=\{opacity < 1\}/g);
  });
});

describe("TerrainEnvironment: theme-paired procedural sky fallback (Phase 5)", () => {
  const source = readThreeSource("TerrainEnvironment.tsx");

  it("accepts an optional fallbackColor prop, defaulting to undefined so every pre-Phase-5 caller is byte-identical", () => {
    expect(source).toMatch(/fallbackColor\?:\s*Color/);
  });

  it("applies the fallback color to scene.background only while no real HDRI has loaded -- an HDRI always wins once loaded", () => {
    expect(source).toMatch(/if \(!fallbackColor\) return undefined;/);
    expect(source).toMatch(/scene\.background = fallbackColor;/);
  });
});

describe("TerrainEnvironment: scene.environment IBL via PMREM (Phase 6, plan Section 3.1 item 6 / Section 6 Phase 6)", () => {
  const source = readThreeSource("TerrainEnvironment.tsx");

  it("accepts an optional envIntensity prop, defaulting to 1 (dark theme's --graph-env-intensity) so every pre-Phase-6 caller is byte-identical", () => {
    expect(source).toMatch(/envIntensity\?:\s*number/);
    expect(source).toMatch(/envIntensity\s*=\s*1/);
  });

  it("builds the environment map from the loaded HDRI via PMREMGenerator, never a duplicated/second color-conversion path", () => {
    expect(source).toMatch(/PMREMGenerator/);
    expect(source).toMatch(/\.fromEquirectangular\(/);
  });

  it("assigns scene.environment plus scene.environmentIntensity together -- intensity without a map, or a map without the token-driven intensity, would silently defeat Section 5.2's per-theme --graph-env-intensity spec", () => {
    expect(source).toMatch(/scene\.environment\s*=/);
    expect(source).toMatch(/scene\.environmentIntensity\s*=/);
  });

  it("disposes the PMREM render target and generator on cleanup/replacement, mirroring this directory's GPU-resource-disposal convention -- repeated Terrain mode switches must never leak GPU memory", () => {
    expect(source).toMatch(/pmremRenderTarget[\s\S]*\.dispose\(\)/);
    expect(source).toMatch(/pmremGenerator[\s\S]*\.dispose\(\)/);
  });

  it("leaves scene.environment unset when no HDRI has loaded -- Section 5.4 Fallback: 'A1/A2 absent -> procedural token sky plus default lights, environment unset', never a synthesized procedural IBL map", () => {
    expect(source).not.toMatch(/graph-env-sky/);
  });
});

describe("TerrainSurface: theme-gated skybox, so the Phase 5 finding (a fixed dark HDRI overriding light theme's sky) can never regress (Phase 6)", () => {
  const source = readThreeSource("TerrainSurface.tsx");

  it("only ever passes assets.skyboxUrl into <TerrainEnvironment> when the current theme is dark -- light theme keeps its already-gated procedural high-key sky", () => {
    expect(source).toMatch(/data-theme/);
    expect(source).toMatch(/<TerrainEnvironment[\s\S]*skyboxUrl=\{[\s\S]*?\}/);
  });

  it("threads colors.environment.intensity into TerrainEnvironment's envIntensity prop -- the per-theme --graph-env-intensity token actually reaches the IBL pass", () => {
    expect(source).toMatch(/<TerrainEnvironment[\s\S]*envIntensity=/);
  });

  it("loads the optional A3 detail normal via useOptionalNormalTexture (never the sRGB useOptionalTexture, which would gamma-correct linear normal data)", () => {
    expect(source).toMatch(/from "\.\/terrainAssetLoading"/);
    expect(source).toMatch(/useOptionalNormalTexture\(assets\.normalUrl\)/);
  });

  it("threads the loaded detail normal into BOTH ground-mesh material branches (matcap and standard) as normalMap -- never a third, duplicated hillshade path", () => {
    expect(source).toMatch(/<meshMatcapMaterial[^>]*normalMap=/);
    expect(source).toMatch(/<meshStandardMaterial[^>]*normalMap=/);
  });
});
