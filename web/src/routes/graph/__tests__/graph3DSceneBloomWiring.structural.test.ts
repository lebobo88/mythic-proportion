// Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section 5.9
// Decision B / Section 5.6 items 5-6 / Section 6 Phase 4). Same "structural
// wiring guard, source-regex, no real WebGL context" convention this
// directory already uses for the mode-transition/ACES wiring (see
// graph3DSceneModeWiring.structural.test.ts) -- jsdom cannot mount a real
// <Canvas>/EffectComposer, so the ACTUAL fade/ladder math is covered
// separately and fully by safeTier.test.ts's pure-function unit tests; this
// file only proves Graph3DScene.tsx actually WIRES that pure logic in,
// rather than reimplementing it inline or never calling it at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("Graph3DScene wires @react-three/postprocessing's EffectComposer/Bloom/Vignette (Decision B, structural)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("imports EffectComposer, Bloom, and Vignette from @react-three/postprocessing -- not a hand-rolled composer", () => {
    expect(source).toMatch(/import\s*\{[^}]*EffectComposer[^}]*\}\s*from\s*"@react-three\/postprocessing"/);
    expect(source).toMatch(/import\s*\{[^}]*Bloom[^}]*\}\s*from\s*"@react-three\/postprocessing"/);
    expect(source).toMatch(/import\s*\{[^}]*Vignette[^}]*\}\s*from\s*"@react-three\/postprocessing"/);
  });

  it("mounts <EffectComposer> containing <Bloom> and <Vignette> in the scene JSX", () => {
    expect(source).toMatch(/<EffectComposer[\s\S]*<Bloom[\s\S]*<Vignette[\s\S]*<\/EffectComposer>/);
  });

  it("reads the bloom threshold token into Bloom's luminanceThreshold prop -- token-thresholded per Section 5.6 item 6", () => {
    expect(source).toMatch(/luminanceThreshold=\{colors\.bloom\.threshold\}/);
  });

  it("wires half-resolution bloom via resolutionScale, with mipmapBlur explicitly disabled so resolutionScale actually applies (Section 5.6 item 6: \"half-resolution\")", () => {
    expect(source).toMatch(/mipmapBlur=\{false\}/);
    expect(source).toMatch(/resolutionScale=\{colors\.bloom\.resolutionScale\}/);
  });

  it("reads the vignette tokens into Vignette's offset/darkness props", () => {
    expect(source).toMatch(/offset=\{.*vignette\.offset\}/);
    expect(source).toMatch(/darkness=\{.*vignette\.darkness\}/);
  });

  it("holds a ref to the underlying BloomEffect instance (per-frame intensity mutation target, never a React prop re-render per frame)", () => {
    expect(source).toMatch(/<Bloom[\s\S]*ref=\{bloomEffectRef/);
  });
});

describe("Graph3DScene composes bloom suppression off the SAME `transitioning` signal (Section 5.6 item 5, structural)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("imports the pure bloom-fade/target functions from safeTier.ts -- not a reimplementation", () => {
    expect(source).toMatch(/from "\.\/safeTier"/);
    expect(source).toMatch(/bloomTargetIntensity/);
    expect(source).toMatch(/bloomFadeDurationMs/);
    expect(source).toMatch(/startBloomFade/);
    expect(source).toMatch(/currentBloomIntensity/);
  });

  it("computes the bloom target from the SAME `transitioning` state InstancedNodes' LOD suppression already reads (never a second, independent transition signal)", () => {
    expect(source).toMatch(/bloomTargetIntensity\(colors\.bloom\.intensity,\s*transitioning,/);
  });

  it("reads --graph-motion-bloom-suppress/-restore via readBloomMotionParams (not hardcoded 150/225 literals scattered inline)", () => {
    expect(source).toMatch(/readBloomMotionParams/);
  });

  it("mutates the live bloom intensity inside the existing per-frame useFrame hook (refs/uniforms only, never setState in useFrame)", () => {
    expect(source).toMatch(/useFrame\(\(\) => \{[\s\S]*currentBloomIntensity\([\s\S]*bloomEffectRef\.current[\s\S]*\}\);/);
  });

  it("never calls a React state setter inside the useFrame body (zero-allocation/no-setState-per-frame discipline, same convention as the tick handler above it)", () => {
    const useFrameMatch = /useFrame\(\(\) => \{([\s\S]*?)\n {2}\}\);/.exec(source);
    expect(useFrameMatch).toBeTruthy();
    expect(useFrameMatch![1]).not.toMatch(/set[A-Z]\w*\(/);
  });
});

describe("Graph3DScene drives the safe-tier ladder from PerformanceMonitor and threads it into the LOD/bloom flags (structural)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("wires PerformanceMonitor's onIncline/onDecline (not only the pre-existing onChange/onFpsSample) to step the internal auto-level state", () => {
    expect(source).toMatch(/onDecline=\{/);
    expect(source).toMatch(/onIncline=\{/);
    expect(source).toMatch(/stepSafeTierLevel\(level, "down"\)/);
    expect(source).toMatch(/stepSafeTierLevel\(level, "up"\)/);
  });

  it("resolves the effective level via effectiveSafeTierLevel (Auto/Full/Balanced/Minimal composed with the live auto level) and derives the ladder flags from it via safeTierFlags", () => {
    expect(source).toMatch(/effectiveSafeTierLevel\(effectsTier[^,]*,\s*autoSafeTierLevel\)/);
    expect(source).toMatch(/safeTierFlags\(safeTierLevel\)/);
  });

  it("reports the resolved level upward via onSafeTierLevelChange on every discrete change, never per frame (GraphView.tsx drives its own aria-live announcement from this)", () => {
    expect(source).toMatch(/onSafeTierLevelChange\?\.\(safeTierLevel\)/);
  });

  it("passes the LOD-drop flag into InstancedNodes' safeTier prop (the one narrow, disclosed touch to that file)", () => {
    expect(source).toMatch(/safeTier=\{.*\.lodDropped\}/);
  });
});
