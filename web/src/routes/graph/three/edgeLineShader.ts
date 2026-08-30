// Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.6 item
// 3 / Section 6 Phase 3; Section 12's named highest-risk CODE_REVIEW
// checkpoint alongside the node-material shader work): the fat-line edge
// pass's `LineMaterial.onBeforeCompile` patch adding a PER-INSTANCE width
// multiplier.
//
// Three's own `LineMaterial` (`three/examples/jsm/lines/LineMaterial.js`)
// exposes `linewidth` as a single scalar uniform shared by the WHOLE
// material -- confirmed by direct read of the installed `three@0.169`
// source: `LineSegmentsGeometry.setColors` gives every edge its own
// `instanceColorStart`/`instanceColorEnd` (per-segment color already
// varies), but there is no matching per-instance WIDTH channel. This file
// adds exactly that: an `instanceWidth` attribute (one float per edge
// instance) that multiplies the screen-space offset alongside the
// material's own `linewidth` uniform -- so a single batched `LineSegments2`
// draw call can still render every edge at its own weight-driven width
// (plan Section 5.6 item 3: "weight drives width plus opacity ...
// independently"), with `linewidth` staying a per-material base multiplier
// (this codebase leaves it at its default of 1).
//
// This codebase only uses SCREEN-SPACE (pixel) width (`material.worldUnits`
// stays at its default `false`) -- matching the plan's `--graph-edge-weight-
// width-*` token values (1..4), which read naturally as pixel widths, and
// matching the pre-Phase-3 `LineBasicMaterial` edge layer's implicit 1px
// behavior. The width patch below therefore only touches the non-WORLD_UNITS
// branch of the vertex shader; the WORLD_UNITS branch is left untouched.
//
// VERIFICATION_NEEDS_FIX remediation (Fix 2, major -- T2 remediation cycle
// 1): per-edge OPACITY is ALSO threaded through this shader patch now, as
// GENUINE per-instance alpha -- not the color-blend-toward-a-hardcoded-BLACK
// proxy the first implementation used. That proxy read correctly in dark
// theme (`--graph-bg` is near-black) but was INVERTED in light theme
// (`--graph-bg` is near-white in all four modes): darkening a low-weight
// edge toward black made it MORE prominent against a light background, the
// exact opposite of the intended encoding. Real alpha compositing is correct
// against ANY background color/theme with zero background-token coupling --
// the more correct reading of plan Section 5.6 item 3's literal "weight
// drives width plus opacity" language. Mechanism: a new `instanceOpacity`
// attribute (one float per edge instance, same convention as
// `instanceWidth`), carried to the fragment shader via a new `vOpacity`
// varying, multiplying the material's own `opacity` uniform in the fragment
// shader's `alpha` local (the exact value that flows into `gl_FragColor`).
// The PRE-EXISTING selection/hover dim-toward-black behavior
// (`InstancedEdges.tsx`'s `mixColor`, unchanged by this remediation, out of
// this fix's bounded scope) is untouched -- this shader patch only adds the
// weight-opacity channel, it does not touch color at all.
//
// jsdom cannot compile a real WebGL program, so -- following this
// directory's own established convention (see nodeMaterialShader.ts's
// paired test) -- both shader STRING patches are pure functions, tested
// directly against three's own real `ShaderLib.line.vertexShader`/
// `fragmentShader`.
import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from "three";

const INSTANCE_COLOR_END_ANCHOR = "attribute vec3 instanceColorEnd;";
const OFFSET_LINEWIDTH_ANCHOR = "offset *= linewidth;";
const ASPECT_ANCHOR = "float aspect = resolution.x / resolution.y;";

const VERTEX_INSTANCE_DECLARATIONS = /* glsl */ `
  attribute float instanceWidth;
  attribute float instanceOpacity;
  varying float vOpacity;
`;

const OFFSET_INSTANCE_WIDTH_MULTIPLY = /* glsl */ `
  offset *= instanceWidth;
`;

// Assigned unconditionally, BEFORE the WORLD_UNITS/non-WORLD_UNITS branch
// split (`aspect` is the first line after that split point) -- opacity must
// flow through regardless of which width branch executes, even though this
// codebase only exercises the non-WORLD_UNITS path today.
const VOPACITY_ASSIGN = /* glsl */ `
  vOpacity = instanceOpacity;
`;

/**
 * Pure shader-string patch, exported and directly unit-testable (jsdom
 * cannot compile a real WebGL program -- see this file's paired test for the
 * assertions run directly against three's own real `ShaderLib.line`
 * vertex source, following this directory's established pure-function-
 * extraction convention, e.g. `nodeMaterialShader.ts`'s
 * `patchNodeFragmentShader`).
 */
export function patchEdgeLineVertexShader(source: string): string {
  return source
    .replace(INSTANCE_COLOR_END_ANCHOR, `${INSTANCE_COLOR_END_ANCHOR}\n${VERTEX_INSTANCE_DECLARATIONS}`)
    .replace(OFFSET_LINEWIDTH_ANCHOR, `${OFFSET_LINEWIDTH_ANCHOR}\n${OFFSET_INSTANCE_WIDTH_MULTIPLY}`)
    .replace(ASPECT_ANCHOR, `${VOPACITY_ASSIGN}${ASPECT_ANCHOR}`);
}

const FRAGMENT_VLINEDISTANCE_ANCHOR = "varying float vLineDistance;";
const FRAGMENT_ALPHA_ANCHOR = "float alpha = opacity;";

const FRAGMENT_VOPACITY_DECLARATION = /* glsl */ `
  varying float vOpacity;
`;

// Multiplies the SAME local `alpha` three's own shader already carries
// straight into `gl_FragColor = vec4( diffuseColor.rgb, alpha );` -- genuine
// alpha, not a color-blend proxy, so per-edge weight-opacity composites
// correctly against any background regardless of theme.
const FRAGMENT_ALPHA_MULTIPLY = /* glsl */ `
  alpha *= vOpacity;
`;

/**
 * Pure shader-string patch for the fragment shader's genuine per-instance
 * alpha (VERIFICATION_NEEDS_FIX Fix 2) -- same testing convention as
 * `patchEdgeLineVertexShader` above, against three's own real
 * `ShaderLib.line.fragmentShader`.
 */
export function patchEdgeLineFragmentShader(source: string): string {
  return source
    .replace(FRAGMENT_VLINEDISTANCE_ANCHOR, `${FRAGMENT_VLINEDISTANCE_ANCHOR}\n${FRAGMENT_VOPACITY_DECLARATION}`)
    .replace(FRAGMENT_ALPHA_ANCHOR, `${FRAGMENT_ALPHA_ANCHOR}\n${FRAGMENT_ALPHA_MULTIPLY}`);
}

/**
 * Wires `patchEdgeLineVertexShader`/`patchEdgeLineFragmentShader` onto
 * `material.onBeforeCompile`, preserving (and still calling) any
 * pre-existing handler -- same preserve-the-chain convention
 * `patchNodeMaterial` (nodeMaterialShader.ts) uses.
 */
export function patchEdgeLineMaterial(material: Material): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
    previous?.call(material, shader, renderer);
    shader.vertexShader = patchEdgeLineVertexShader(shader.vertexShader);
    shader.fragmentShader = patchEdgeLineFragmentShader(shader.fragmentShader);
  };
}
