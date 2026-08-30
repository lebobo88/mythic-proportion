// Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.6 item
// 3 / Section 6 Phase 3; Section 12's named highest-risk CODE_REVIEW
// checkpoint alongside the node-material shader work; Section 11's risk row
// on fatline shader/resolution-uniform gotchas): the fat-line edge pass's
// `LineMaterial.onBeforeCompile` patch adding a PER-INSTANCE width
// multiplier -- three's own `LineMaterial` exposes `linewidth` as a single
// scalar uniform shared by the WHOLE material (see `LineMaterial.js`'s
// `UniformsLib.line`), with no per-instance width channel of its own (unlike
// `instanceColorStart`/`instanceColorEnd`, which the stock shader already
// varies per segment) -- confirmed by direct read of the installed
// `three@0.169` `examples/jsm/lines/{LineMaterial,LineSegmentsGeometry}.js`
// sources during implementation.
//
// jsdom cannot compile a real WebGL program, so -- following this
// directory's own established convention (see nodeMaterialShader.test.ts) --
// the shader STRING patch is a pure function, tested directly against
// three's own real `ShaderLib.line.vertexShader` (not a hand-written
// stand-in), plus a structural check that the wiring function attaches it
// via `onBeforeCompile` without discarding a prior handler.
import { describe, expect, it, vi } from "vitest";
import { ShaderLib, Vector2, type WebGLProgramParametersWithUniforms } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import {
  patchEdgeLineFragmentShader,
  patchEdgeLineMaterial,
  patchEdgeLineVertexShader,
} from "../three/edgeLineShader";

describe("patchEdgeLineVertexShader (pure shader-string patch)", () => {
  // `LineMaterial.js`'s module-level side effect registers `ShaderLib.line`
  // -- import the material class first (already done by the import above)
  // so `ShaderLib.line` is populated before this reads it.
  const source = ShaderLib.line.vertexShader;
  const patched = patchEdgeLineVertexShader(source);

  it("declares a new instanceWidth attribute (additive, never replacing instanceStart/instanceEnd/instanceColorStart/instanceColorEnd)", () => {
    expect(patched).toMatch(/attribute float instanceWidth;/);
    expect(patched).toMatch(/attribute vec3 instanceStart;/);
    expect(patched).toMatch(/attribute vec3 instanceEnd;/);
    expect(patched).toMatch(/attribute vec3 instanceColorStart;/);
    expect(patched).toMatch(/attribute vec3 instanceColorEnd;/);
  });

  it("preserves every original anchor line exactly once (additive patch, not a replacement)", () => {
    expect(patched.match(/attribute vec3 instanceColorEnd;/g)).toHaveLength(1);
    expect(patched.match(/offset \*= linewidth;/g)).toHaveLength(1);
  });

  it("multiplies the screen-space offset by instanceWidth immediately after the existing linewidth multiply, so per-edge width composes with (never replaces) the material-wide linewidth uniform", () => {
    const anchorIndex = patched.indexOf("offset *= linewidth;");
    const nextAnchorIndex = patched.indexOf("offset /= resolution.y;");
    expect(nextAnchorIndex).toBeGreaterThan(anchorIndex);
    const between = patched.slice(anchorIndex, nextAnchorIndex);
    expect(between).toMatch(/offset \*= instanceWidth;/);
  });

  it("never touches the WORLD_UNITS branch (this codebase only uses screen-space/pixel width, worldUnits: false)", () => {
    const worldUnitsAnchor = patched.indexOf("#ifdef WORLD_UNITS");
    const elseAnchor = patched.indexOf("#else", worldUnitsAnchor);
    const between = patched.slice(worldUnitsAnchor, elseAnchor);
    expect(between).not.toMatch(/instanceWidth/);
  });

  it("never introduces vertexColors or a NEW geometry color/position attribute (the edge layer already legitimately uses instanceColorStart/End -- Section 3.3/5.6 item 1's black-multiply guard is a NODE-layer-only invariant, not applicable to this file)", () => {
    const originalLines = new Set(source.split("\n"));
    const insertedLines = patched.split("\n").filter((line) => !originalLines.has(line));
    expect(insertedLines.length).toBeGreaterThan(0);
    expect(insertedLines.join("\n")).not.toMatch(/attribute vec3/); // only the new scalar `instanceWidth` attribute is added
  });
});

// VERIFICATION_NEEDS_FIX remediation (Fix 2, major -- T2 remediation cycle
// 1): plan Section 5.6 item 3 says weight drives width AND opacity
// INDEPENDENTLY. The original implementation faked "opacity" by blending the
// per-vertex color toward a hardcoded BLACK constant (see InstancedEdges.tsx
// git history) -- correct-looking in dark theme (`--graph-bg` is near-black)
// but INVERTED in light theme (`--graph-bg` is near-white in all four
// modes): a low-weight edge darkened toward black reads as MORE prominent
// against a light background, the opposite of the intended encoding. Genuine
// per-instance alpha (this patch) avoids background-color coupling entirely
// -- the more correct reading of the plan's literal "opacity" language, and
// the fix Verifier's finding explicitly preferred if not materially harder.
// Mirrors the `instanceWidth` pattern exactly: a new `instanceOpacity`
// attribute (one float per edge instance), carried to the fragment shader
// via a new `vOpacity` varying, multiplying the material's own `opacity`
// uniform -- so per-edge weight-opacity is REAL alpha compositing, correct
// against any background color/theme with zero background-token coupling.
describe("patchEdgeLineFragmentShader (pure shader-string patch -- genuine per-instance alpha, VERIFICATION_NEEDS_FIX Fix 2)", () => {
  const source = ShaderLib.line.fragmentShader;
  const patched = patchEdgeLineFragmentShader(source);

  it("declares a new vOpacity varying (additive, never replacing vLineDistance or any other existing varying)", () => {
    expect(patched).toMatch(/varying float vOpacity;/);
    expect(patched).toMatch(/varying float vLineDistance;/);
  });

  it("preserves every original anchor line exactly once (additive patch, not a replacement)", () => {
    expect(patched.match(/varying float vLineDistance;/g)).toHaveLength(1);
    expect(patched.match(/float alpha = opacity;/g)).toHaveLength(1);
  });

  it("multiplies the local `alpha` (which flows straight into gl_FragColor) by vOpacity immediately after its declaration, so per-edge weight-opacity is REAL alpha, never a color-blend proxy", () => {
    const anchorIndex = patched.indexOf("float alpha = opacity;");
    expect(anchorIndex).toBeGreaterThan(-1);
    const nextLines = patched.slice(anchorIndex, anchorIndex + 200);
    expect(nextLines).toMatch(/alpha \*= vOpacity;/);
    // The exact same `alpha` local variable three's own shader already uses
    // to build `gl_FragColor` -- confirms this isn't a disconnected value.
    expect(patched).toMatch(/gl_FragColor = vec4\( diffuseColor\.rgb, alpha \);/);
  });

  it("never introduces a hardcoded color constant or background-token read -- genuine alpha needs no background coupling at all", () => {
    const originalLines = new Set(source.split("\n"));
    const insertedLines = patched.split("\n").filter((line) => !originalLines.has(line));
    expect(insertedLines.length).toBeGreaterThan(0);
    expect(insertedLines.join("\n")).not.toMatch(/graph-bg|--color-bg|vec3\(\s*0/);
  });
});

describe("patchEdgeLineVertexShader also declares instanceOpacity + vOpacity and assigns vOpacity = instanceOpacity unconditionally (VERIFICATION_NEEDS_FIX Fix 2)", () => {
  const source = ShaderLib.line.vertexShader;
  const patched = patchEdgeLineVertexShader(source);

  it("declares instanceOpacity (attribute) and vOpacity (varying), alongside the existing instanceWidth attribute", () => {
    expect(patched).toMatch(/attribute float instanceOpacity;/);
    expect(patched).toMatch(/varying float vOpacity;/);
    expect(patched).toMatch(/attribute float instanceWidth;/);
  });

  it("assigns vOpacity = instanceOpacity unconditionally, before the WORLD_UNITS/non-WORLD_UNITS branch split inside main() (right after `aspect` is computed), so it is always set regardless of which width branch executes", () => {
    expect(patched).toMatch(/vOpacity = instanceOpacity;/);
    const assignIndex = patched.indexOf("vOpacity = instanceOpacity;");
    const aspectIndex = patched.indexOf("float aspect = resolution.x / resolution.y;");
    const glPositionIndex = patched.indexOf("gl_Position = clip;");
    expect(assignIndex).toBeGreaterThan(-1);
    expect(assignIndex).toBeLessThan(aspectIndex); // assigned immediately before the branch-split anchor
    expect(assignIndex).toBeLessThan(glPositionIndex); // well before main() ends
  });
});

describe("patchEdgeLineMaterial (wiring)", () => {
  it("sets onBeforeCompile so the fragment/vertex shader is patched", () => {
    const material = new LineMaterial();
    patchEdgeLineMaterial(material);

    expect(material.onBeforeCompile).toBeTypeOf("function");
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.line.vertexShader,
      fragmentShader: ShaderLib.line.fragmentShader,
    };
    material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as never);

    expect(shader.vertexShader).toMatch(/instanceWidth/);
    // VERIFICATION_NEEDS_FIX Fix 2: the fragment shader must ALSO be patched
    // now (genuine per-instance alpha), not just the vertex shader.
    expect(shader.fragmentShader).toMatch(/vOpacity/);
  });

  it("preserves and still calls a pre-existing onBeforeCompile handler (never silently drops a prior handler)", () => {
    const material = new LineMaterial();
    const previous = vi.fn();
    material.onBeforeCompile = previous;
    patchEdgeLineMaterial(material);

    const shader = { uniforms: {}, vertexShader: ShaderLib.line.vertexShader, fragmentShader: ShaderLib.line.fragmentShader };
    const renderer = {};
    material.onBeforeCompile(shader as never, renderer as never);

    expect(previous).toHaveBeenCalledWith(shader, renderer);
  });
});

// Section 11's named risk row: "a missing `resolution` uniform or similar
// fatline-specific gotcha is a plausible analogous failure mode" to Phase
// 2's live-Chrome shader defect. This is the general, practical static
// cross-check for THAT exact failure class (no GPU context needed): proves
// that using `LineSegments2` (rather than a bare `Mesh` + `LineMaterial`)
// gets the `resolution` uniform kept in sync with the live renderer viewport
// AUTOMATICALLY, on every render call, via three's own
// `LineSegments2.onBeforeRender` -- confirmed by direct read of the
// installed `three@0.169` `LineSegments2.js` source during implementation.
// This is a REAL regression guard: reverting to a bare `Mesh` (or any object
// whose `onBeforeRender` doesn't perform this sync) reproduces a RED failure
// here, because `material.uniforms.resolution.value` would stay at its
// construction-time default ([1, 1]) instead of tracking the live viewport.
describe("LineSegments2 auto-syncs the LineMaterial resolution uniform every render (Section 11's fatline resolution-uniform risk)", () => {
  it("onBeforeRender copies the live renderer viewport into material.uniforms.resolution -- no manual resize wiring required", () => {
    const material = new LineMaterial();
    const geometry = new LineSegmentsGeometry();
    const line2 = new LineSegments2(geometry, material);

    // `uniforms.resolution` already exists on every LineMaterial instance --
    // it's part of ShaderMaterial's own `uniforms` bag, populated at
    // construction from `UniformsLib.line` (see LineMaterial.js), not
    // something onBeforeCompile creates -- so this exercises the REAL object
    // `LineSegments2.onBeforeRender` reads/writes, not a stand-in.
    expect(material.uniforms.resolution.value).toBeInstanceOf(Vector2);
    expect(material.uniforms.resolution.value.x).toBe(1); // construction-time default, before any render
    expect(material.uniforms.resolution.value.y).toBe(1);

    const fakeRenderer = {
      getViewport: (target: { set: (x: number, y: number, z: number, w: number) => void }) => {
        target.set(0, 0, 1440, 900);
        return target;
      },
    };
    line2.onBeforeRender(fakeRenderer as never);

    expect(material.uniforms.resolution.value.x).toBe(1440);
    expect(material.uniforms.resolution.value.y).toBe(900);
  });

  it("re-syncs on every subsequent render call, so a resize between two frames is picked up without any explicit resize handler", () => {
    const material = new LineMaterial();
    const geometry = new LineSegmentsGeometry();
    const line2 = new LineSegments2(geometry, material);

    const renderer = { viewport: [0, 0, 1440, 900] as [number, number, number, number] };
    const fakeRenderer = {
      getViewport: (target: { set: (x: number, y: number, z: number, w: number) => void }) => {
        target.set(...renderer.viewport);
        return target;
      },
    };

    line2.onBeforeRender(fakeRenderer as never);
    expect(material.uniforms.resolution.value.x).toBe(1440);

    renderer.viewport = [0, 0, 800, 600]; // simulates a window resize between frames
    line2.onBeforeRender(fakeRenderer as never);
    expect(material.uniforms.resolution.value.x).toBe(800);
    expect(material.uniforms.resolution.value.y).toBe(600);
  });
});
