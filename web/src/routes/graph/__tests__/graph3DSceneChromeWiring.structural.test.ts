// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.3
// "Mode-transition cross-fade": chrome/fog ride the SAME 800ms
// `transitioning` envelope Phase 4 already wired bloom suppression to).
// Same "structural wiring guard, source-regex, no real WebGL context"
// convention as `graph3DSceneBloomWiring.structural.test.ts` and
// `graph3DSceneModeWiring.structural.test.ts` -- jsdom cannot mount a real
// <Canvas>, so the ACTUAL fade/lerp math is covered separately by
// `modeTransition.test.ts` (`resolveChromeCrossfadeAlpha`) and
// `graph-colors.test.ts` (`lerpAtmosphereFog`); this file only proves
// Graph3DScene.tsx actually WIRES that pure logic in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("Graph3DScene mounts per-mode chrome (structural, Phase 5)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("delegates to the shared renderModeChrome resolver (ModeChrome.tsx) -- not a reimplementation or four separate direct imports", () => {
    expect(source).toMatch(/from "\.\/ModeChrome"/);
    expect(source).toMatch(/renderModeChrome\(/);
  });

  it("passes colors into <TerrainSurface> -- the highest-risk-mode chrome (hillshade/contour/sky) is otherwise dead code", () => {
    expect(source).toMatch(/<TerrainSurface[\s\S]{0,120}colors=\{colors\}/);
  });

  it("renders each mode's chrome only for its own mode via a shared chrome-resolver, not four separate unconditional mounts", () => {
    expect(source).toMatch(/renderModeChrome/);
  });
});

describe("Graph3DScene composes the chrome cross-fade off the SAME transitioning signal bloom already reads (structural, Phase 5)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("imports resolveChromeCrossfadeAlpha from modeTransition.ts -- never a second, independent transition signal", () => {
    expect(source).toMatch(/resolveChromeCrossfadeAlpha/);
  });

  it("tracks the outgoing mode across a transition so its chrome can keep rendering (fading out) alongside the incoming mode's chrome (fading in)", () => {
    expect(source).toMatch(/outgoingModeRef/);
  });

  it("clears the outgoing-mode ref at the SAME discrete completion event the position blend/transitioning state already clear at (never a second, independent completion signal)", () => {
    expect(source).toMatch(/transitionRef\.current = null;[\s\S]{0,1200}outgoingModeRef\.current = null;/);
  });

  it("derives the chrome cross-fade weight from reactive state (chromeAlpha), updated on a coarse interval while transitioning -- never every frame inside the node-count-bound useFrame hot path", () => {
    expect(source).toMatch(/const \[chromeAlpha, setChromeAlpha\] = useState\(1\)/);
    expect(source).not.toMatch(/useFrame\(\(\) => \{[\s\S]*setChromeAlpha/);
  });

  it("resolves to alpha 1 (instant, no fade window) whenever `transitioning` is false -- covers both the settled-state and the reduced-motion path (which never sets `transitioning` true in the first place)", () => {
    expect(source).toMatch(/if \(!transitioning\) \{\s*setChromeAlpha\(1\)/);
  });

  it("only populates outgoingModeRef/outgoingFogRef (and, per Verifier remediation cycle 1 Fix a, the chromeAlpha fade-start value) for a REAL (non-instant) blend window -- reduced motion (durationMs 0) never sets them, so renderModeChrome/the fog lerp only ever see the new mode (an instant swap)", () => {
    expect(source).toMatch(
      /if \(started\.durationMs > 0\) \{\s*outgoingModeRef\.current = outgoingMode;\s*outgoingFogRef\.current = readAtmosphereFogParams\(document\.documentElement, outgoingMode\);[\s\S]{0,1200}\n {4}\}/,
    );
  });

  it("only renders the outgoing mode's chrome while BOTH transitioning is true AND an outgoing mode was actually recorded -- never a stale/leftover outgoing mount", () => {
    expect(source).toMatch(/transitioning && outgoingModeRef\.current/);
  });
});

// Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix a):
// `chromeAlpha` used to initialize/stay at its PRIOR value (often 1, fully
// opaque) until the first 50ms interval tick recomputed it -- a real
// reset-flash window (up to ~50ms at full incoming opacity, or a stale
// carried-over weight across an interrupted/rapid re-trigger, since the
// polling effect is keyed only on the `transitioning` BOOLEAN and never
// re-runs just because a SECOND transition starts while `transitioning` was
// already true). Fix: the mode-change effect itself sets `chromeAlpha`
// synchronously, in the SAME tick a real transition starts (or restarts on
// an interrupt), to the transition's actual fade-start progress -- never
// left waiting for the interval's first tick.
describe("Graph3DScene resolves chromeAlpha's fade-START value synchronously, never leaving a reset-flash window (structural, Verifier remediation cycle 1 Fix a)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("computes chromeAlpha from the transition it JUST started, inside the same mode-change effect that sets outgoingModeRef -- not deferred to the interval's first tick", () => {
    expect(source).toMatch(
      /outgoingFogRef\.current = readAtmosphereFogParams\(document\.documentElement, outgoingMode\);[\s\S]{0,1200}setChromeAlpha\(resolveChromeCrossfadeAlpha\(started, performance\.now\(\)\)\);/,
    );
  });

  it("this synchronous set is gated behind the SAME real-transition condition as outgoingModeRef (started.durationMs > 0) -- never firing for the reduced-motion instant path, which already resolves via the !transitioning branch", () => {
    expect(source).toMatch(
      /if \(started\.durationMs > 0\) \{[\s\S]*setChromeAlpha\(resolveChromeCrossfadeAlpha\(started, performance\.now\(\)\)\);[\s\S]*\}/,
    );
  });
});

// Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix b):
// Terrain used to be a hard `mode === "terrain" ? <TerrainSurface/> : null`
// mount/unmount boundary -- no opacity, no outgoing-render participation,
// unlike Cloud/Orbital/Strata (which all cross-fade via renderModeChrome).
// Fix: Terrain now participates in the exact same incoming/outgoing
// cross-fade lifecycle, via the pure, unit-tested `resolveTerrainCrossfade`
// resolver (ModeChrome.tsx) plus a new `opacity` prop threaded through
// TerrainSurface's ground-mesh materials.
describe("Graph3DScene gives Terrain the same incoming/outgoing cross-fade participation as the other three modes (structural, Verifier remediation cycle 1 Fix b)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("imports and uses the pure resolveTerrainCrossfade resolver -- never a reimplemented ad hoc boolean", () => {
    expect(source).toMatch(/resolveTerrainCrossfade/);
  });

  it("passes a resolved opacity into <TerrainSurface>, never mounting it at an implicit/unstated full opacity only", () => {
    expect(source).toMatch(/<TerrainSurface[\s\S]{0,200}opacity=\{/);
  });

  it("delays clearing terrainPoints while Terrain is still the recorded OUTGOING mode of an in-flight transition -- otherwise the fading-out ground mesh would collapse to an empty/flat heightfield instead of a graceful fade of its last real shape", () => {
    expect(source).toMatch(/outgoingModeRef\.current === "terrain"/);
  });
});

describe("Graph3DScene wires atmosphere fog cross-fade into the existing per-frame refs-only loop (structural, Phase 5)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("imports FogExp2 from three and lerpAtmosphereFog/readAtmosphereFogParams from graph-colors.ts", () => {
    expect(source).toMatch(/import\s*\{[^}]*FogExp2[^}]*\}\s*from\s*"three"/);
    expect(source).toMatch(/lerpAtmosphereFog/);
    expect(source).toMatch(/readAtmosphereFogParams/);
  });

  it("mutates the persisted FogExp2 instance's color/density directly inside the existing useFrame hook -- refs/uniforms only, never a new setState-per-frame path", () => {
    expect(source).toMatch(/useFrame\(\(\) => \{[\s\S]*sceneFogRef\.current[\s\S]*\.density[\s\S]*\}\);/);
  });

  it("assigns the fog instance to scene.fog once and restores the previous value on cleanup -- never leaking across a mode/theme change", () => {
    expect(source).toMatch(/scene\.fog = fog;/);
    expect(source).toMatch(/scene\.fog = null;|scene\.fog = previousFog/);
  });
});
