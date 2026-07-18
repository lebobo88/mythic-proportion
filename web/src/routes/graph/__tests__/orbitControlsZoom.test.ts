// T2 remediation (browser-audit item, restated at Section 6.1 item 1 and
// re-confirmed post-StrictMode-fix by Browser Validator): scroll-to-zoom on
// the 3D canvas produced zero camera-distance change in BOTH `mythic serve`
// (prod) and `npm run dev`, at both small and large scale, on fresh loads --
// i.e. before any user interaction, not a StrictMode remount race. Direct
// instrumentation confirmed genuine wheel events reached the canvas
// (`event.defaultPrevented` stayed `false` throughout propagation) while
// drag-rotate (a sibling pointer-event path wired by the exact same
// `OrbitControls.connect()` call) worked correctly.
//
// `Graph3DScene`/`<Canvas>` needs a real WebGL context jsdom can't provide
// (see `webglFallback.test.tsx`'s own note), so full wheel-gesture-to-
// camera-distance behavior is NOT unit-testable here -- that is a genuine,
// labeled limit, verifiable only live via Browser Validator. What IS
// testable, and gating, is the structural configuration this remediation
// changed: `<OrbitControls>` no longer relies on the implicit, mount-order-
// sensitive `domElement || events.connected || gl.domElement` fallback
// inside `@react-three/drei`'s wrapper (traced in
// `node_modules/@react-three/drei/core/OrbitControls.js` and
// `node_modules/three-stdlib/controls/OrbitControls.js`) -- it now pins
// `domElement` explicitly to the real render canvas (`state.gl.domElement`)
// so the wheel/pointer listener `OrbitControls.connect()` attaches is never
// ambiguous across R3F's own two-phase (layout-effect vs. regular-effect)
// event-connection timing. `enableZoom` is also asserted explicitly true
// (never disabled, implicitly or explicitly) and the `<Canvas>` element is
// asserted to carry no `eventSource`/`eventPrefix` override that could
// redirect R3F's own event wiring away from the canvas's real parent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const THREE_DIR = join(__dirname, "..", "three");
const GRAPH_DIR = join(__dirname, "..");

function readSource(dir: string, fileName: string): string {
  return readFileSync(join(dir, fileName), "utf-8");
}

describe("3D graph OrbitControls zoom configuration (structural -- no real WebGL context in jsdom)", () => {
  const sceneSource = readSource(THREE_DIR, "Graph3DScene.tsx");

  it("pins OrbitControls' domElement explicitly to the real render canvas, not the implicit events.connected/gl.domElement fallback", () => {
    // Explicit domElement removes the only genuinely timing-sensitive step
    // in the whole connect() chain: `@react-three/drei`'s
    // `domElement || events.connected || gl.domElement` resolution, which
    // otherwise depends on R3F's own layout-effect-vs-effect event-connect
    // ordering rather than a single deterministic reference.
    expect(sceneSource).toMatch(/<OrbitControls\b[^>]*\bdomElement=\{[^}]*gl\.domElement[^}]*\}/s);
  });

  it("never disables enableZoom, implicitly or explicitly", () => {
    expect(sceneSource).not.toMatch(/enableZoom\s*=\s*\{?\s*false\s*\}?/);
    expect(sceneSource).toMatch(/<OrbitControls\b[^>]*\benableZoom\b/s);
  });

  it("Canvas carries no eventSource/eventPrefix override that could misdirect R3F's own pointer/wheel event wiring away from the canvas's real DOM parent", () => {
    expect(sceneSource).not.toMatch(/eventSource=/);
    expect(sceneSource).not.toMatch(/eventPrefix=/);
  });

  it("SceneContents reads gl via useThree so OrbitControls' domElement is the actual live renderer canvas, not a stale/guessed ref", () => {
    expect(sceneSource).toMatch(/const gl = useThree\(\(state\) => state\.gl\);/);
    expect(sceneSource).toMatch(/import \{ Canvas, useFrame, useThree \} from "@react-three\/fiber";/);
  });
});

describe("3D graph canvas CSS never blocks wheel/pointer input", () => {
  const graphCss = readSource(GRAPH_DIR, "graph.css");

  it("the canvas wrap and canvas rule carry no pointer-events:none or touch-action:none override", () => {
    expect(graphCss).not.toMatch(/pointer-events:\s*none/);
    expect(graphCss).not.toMatch(/touch-action:\s*none/);
  });
});
