// Phase 4a de-risking spike (plan Section 6.3): structural confirmation
// that Graph3DScene.tsx actually WIRES the pure `modeTransition.ts` engine
// and `prefersReducedMotion()` into its mode-change effect -- not merely
// that the pure functions exist and behave correctly in isolation (covered
// by `modeTransition.test.ts`). Same "structural wiring guard" convention
// this directory already uses for CameraRig (see
// `cameraRigUserInterrupt.test.ts`'s own final describe block).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe("Graph3DScene wires the mode-transition engine into its mode-change effect (structural)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("imports the pure transition engine and terrain surface -- not a reimplementation", () => {
    expect(source).toMatch(/from "\.\/modeTransition"/);
    expect(source).toMatch(/from "\.\/TerrainSurface"/);
  });

  it("checks prefersReducedMotion() before starting a mode-switch transition, and passes a 0 duration when it applies (M1/deliverable 10: instant/cross-fade, no position interpolation)", () => {
    expect(source).toMatch(/prefersReducedMotion\(\)/);
    expect(source).toMatch(/durationMs = prefersReducedMotion\(\) \? 0 : undefined/);
  });

  it("starts a transition only on an ACTUAL mode change (compares against a previous-mode ref), never on every render", () => {
    expect(source).toMatch(/prevModeRef\.current === mode/);
  });

  it("blends in the tick handler only while the transition is active, and clears it once it completes", () => {
    expect(source).toMatch(/isTransitionActive\(transition, now\)/);
    expect(source).toMatch(/transitionRef\.current = null;/);
  });

  // T2 remediation (bounded investigation, Section 6.5 closeout finding --
  // transient "jagged black/teal" artifact during a mode-switch blend, see
  // instancedNodesLod.test.ts for the full root-cause evidence and mitigation
  // under test): a REACTIVE (state, not ref-only) transitioning signal is
  // required here specifically because InstancedNodes' LOD-rescale effect
  // only re-runs on a prop-identity change -- a ref mutation alone
  // (`transitionRef.current`) would never re-trigger it.
  it("tracks transitioning as REACTIVE state (not ref-only), set true only for a real, non-instant transition", () => {
    expect(source).toMatch(/const \[transitioning, setTransitioning\] = useState\(false\)/);
    expect(source).toMatch(/setTransitioning\(.*\.durationMs > 0\)/);
  });

  it("clears transitioning exactly where the blend itself is cleared (same discrete completion event, not per-tick)", () => {
    expect(source).toMatch(/transitionRef\.current = null;[\s\S]{0,400}setTransitioning\(false\);/);
  });

  it("conditionally renders <TerrainSurface> only in terrain mode -- never mounted for the other three modes", () => {
    expect(source).toMatch(/mode === "terrain" \? <TerrainSurface/);
  });

  it("passes `mode` through to the real useForceLayoutWorker hook (not a second, parallel worker wiring)", () => {
    expect(source).toMatch(/\}, mode\);/);
  });
});

// Phase 4c graph state-lifecycle fix (plan Section 3.3/6.5, Section 11's
// risk-table mitigation): a hidden (mounted-hidden) GraphView must not keep
// burning GPU frames. Structural guard, same convention as above -- direct
// component-level coverage of `visible` -> `paused` lives in
// GraphView.test.tsx and App.test.tsx, since jsdom cannot mount a real
// <Canvas>/WebGL context to observe R3F's frameloop directly.
describe("Graph3DScene pauses its render loop while hidden (structural)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("threads a `paused` prop into <Canvas>'s frameloop, resuming to \"always\" the instant it clears", () => {
    expect(source).toMatch(/frameloop=\{paused \? "never" : "always"\}/);
  });
});

// Deep-Field Observatory Phase 1 (plan Section 3.1 item 1 / Section 6 Phase
// 1 / Section 5.6 item invariant "ACES at the Canvas"): the scene must
// EXPLICITLY configure ACES filmic tone mapping at the `<Canvas>` `gl` prop
// rather than relying on @react-three/fiber's implicit default (which
// applies the same tone mapping only as long as no future `gl`/`flat` config
// change on this mount silently opts out of it) -- same "structural wiring
// guard, source-regex, no real WebGL context" convention as the describe
// blocks above.
describe("Graph3DScene configures ACES filmic tone mapping at the Canvas (structural, plan Section 6 Phase 1)", () => {
  const source = readSource("Graph3DScene.tsx");

  it("imports ACESFilmicToneMapping from three", () => {
    expect(source).toMatch(/import\s*\{[^}]*ACESFilmicToneMapping[^}]*\}\s*from\s*"three"/);
  });

  it("passes toneMapping: ACESFilmicToneMapping via the Canvas gl prop", () => {
    expect(source).toMatch(/gl=\{\{[^}]*toneMapping:\s*ACESFilmicToneMapping/);
  });
});
