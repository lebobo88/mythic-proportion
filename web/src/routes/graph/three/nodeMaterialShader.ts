// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.6 item
// 1 / Section 6 Phase 2; Section 12's named highest-risk `CODE_REVIEW`
// checkpoint given the documented black-multiply regression history): the
// node `MeshStandardMaterial.onBeforeCompile` patch adding a fresnel rim,
// per-instance emissive drive (idle/hover/selected), a non-luminance focus
// outline, and per-instance pattern-id luminance modulation.
//
// CRITICAL invariant (Section 3.3, Section 5.6 item 1): this file NEVER sets
// `material.vertexColors = true` and NEVER reads the geometry's per-vertex
// `color` attribute. `InstancedNodes.tsx` documents the exact bug this
// guards against -- `vertexColors: true` tells three's own
// `color_fragment`/`color_vertex` chunks to multiply in a geometry `color`
// attribute that GEOMETRY_NEAR/MID/FAR never define, which resolves to
// black and zeroes out the correct `colorsTexture` value. The per-instance
// base color continues to flow ONLY through `colorsTexture`/`vColor`
// (@three.ez/instanced-mesh's own indirect-instancing path), exactly as
// before this patch -- this file only ADDS emissive/outline/pattern
// contributions on top of `diffuseColor`, it never touches how
// `diffuseColor` itself is populated.
//
// Per-instance data (`patternId`, `emissiveStrength`) flows through
// `InstancedMesh2.initUniformsPerInstance` -- the SAME `SquareDataTexture`
// mechanism family `colorsTexture` itself uses (see
// @three.ez/instanced-mesh's `uniformsTexture`), not a duplicate hand-rolled
// texture -- so the pattern-id/emissive-drive data is a second small data
// texture in that one mechanism family (Section 5.6 item 1: "the pattern-id
// ships as a SECOND small data texture in the same mechanism family as
// colorsTexture -- still ONE draw call"), and the node layer stays exactly
// one draw call: this is shader/texture data, never a second mesh.
//
// Shared (non-per-instance) numerics -- fresnel power/intensity, outline
// color/width, pattern luminance delta/scale -- are plain THREE.js uniforms,
// created ONCE by `createNodeMaterialUniforms` and merged into every
// compiled program's `shader.uniforms` by reference (see `patchNodeMaterial`
// below). InstancedMesh2 registers this same material against THREE separate
// LOD geometries (near/mid/far), and three.js compiles a SEPARATE program
// per LOD tier (each gets its own fresh `shader.uniforms` object at compile
// time) -- sharing the SAME uniform-holder object across every compile means
// mutating `.value` later (a theme/token change, wired by InstancedNodes.tsx)
// updates every LOD tier's live uniform simultaneously, without forcing a
// shader recompile.
import { Color, type IUniform, type Material, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from "three";

/** solid / dots / stripes / cross-hatch -- must stay in the exact order of `COMMUNITY_PATTERN_KINDS` in `lib/communityGlyphs.ts`, the single source for the shape/pattern <-> index mapping shared with badges/2D-fallback/a11y-tree. */
export const NODE_PATTERN_KIND_COUNT = 4;

export interface NodeMaterialUniformRefs {
  uFresnelPower: IUniform<number>;
  uFresnelIntensity: IUniform<number>;
  uOutlineColor: IUniform<Color>;
  uOutlineWidth: IUniform<number>;
  uPatternLuminanceDelta: IUniform<number>;
  uPatternScale: IUniform<number>;
}

/** Fresh, independent uniform-holder objects, pre-populated with the documented Phase 1 token defaults (see `lib/graph-colors.ts`'s `readNodeMaterialParams`/`readPatternParams`) -- callers mutate `.value` later as tokens/theme change; see the file header for why these must be shared BY REFERENCE across every LOD program compile. */
export function createNodeMaterialUniforms(): NodeMaterialUniformRefs {
  return {
    uFresnelPower: { value: 2.5 },
    uFresnelIntensity: { value: 0.6 },
    uOutlineColor: { value: new Color(0xffffff) },
    uOutlineWidth: { value: 2 },
    uPatternLuminanceDelta: { value: 0.18 },
    uPatternScale: { value: 3 },
  };
}

// Browser Validator remediation cycle 2 (BROWSER_NEEDS_FIX, blocker): every
// uniform referenced below (`uFresnelPower`/`uFresnelIntensity`/
// `uOutlineColor`/`uOutlineWidth`/`uPatternLuminanceDelta`/`uPatternScale`)
// was previously set ONLY on the JS-side `shader.uniforms` object (see
// `patchNodeMaterial`'s `Object.assign` below) -- correct and necessary for
// three.js to bind values into the compiled program, but NOT sufficient on
// its own. A GLSL fragment shader also requires a matching `uniform <type>
// <name>;` DECLARATION in the shader source itself, or the identifier is
// undeclared and the shader fails to compile/link (exactly the live-Chrome
// failure: "undeclared identifier" for every uniform above, plus a
// consequent `mix()` overload-resolution failure at the outline blend once
// the compiler had no known type for `uOutlineColor`). Injected once, right
// after `#include <common>` -- a stable, single-occurrence, very-early
// anchor in the fragment shader, well before any of these identifiers are
// used (Section 5.6 item 1 / Section 11's named shader-patch risk: this is
// exactly the class of regression that risk row calls out).
const FRAGMENT_UNIFORM_DECLARATIONS = /* glsl */ `
  uniform float uFresnelPower;
  uniform float uFresnelIntensity;
  uniform vec3 uOutlineColor;
  uniform float uOutlineWidth;
  uniform float uPatternLuminanceDelta;
  uniform float uPatternScale;
`;

const COMMON_ANCHOR = "#include <common>";

// Injected immediately after `#include <normal_fragment_maps>`, where both
// `normal` (post normal-map perturbation) and `diffuseColor` (post
// `#include <color_fragment>`, i.e. already carrying the per-instance
// `colorsTexture` color -- see the file header) are available, and BEFORE
// `#include <emissivemap_fragment>`/the lighting accumulation that consumes
// `totalEmissiveRadiance`/`diffuseColor`. `patternId`/`emissiveStrength` are
// plain local floats declared by InstancedMesh2's own uniformsTexture-fetch
// injection at the top of `main()` (see `patchNodeMaterial`'s doc comment) --
// available here regardless of onBeforeCompile call order, because both
// edits target disjoint text regions of the same final shader string.
const FRAGMENT_PATTERN_AND_GLOW = /* glsl */ `
  // Deep-Field Observatory Phase 2: per-fragment community pattern-id
  // luminance modulation (never hue alone, Section 5.6 item 1), a fresnel
  // rim ("material life", idle/hover/selected alike), and the per-instance
  // emissive glow (idle 0 / hover 0.6 / selected 1.0, Section 5.2).
  float dfoTheta = atan( normal.z, normal.x );
  float dfoPhi = acos( clamp( normal.y, -1.0, 1.0 ) );
  float dfoPattern = 0.0;
  if ( patternId > 0.5 && patternId < 1.5 ) {
    // dots
    dfoPattern = sin( dfoTheta * uPatternScale ) * sin( dfoPhi * uPatternScale * 2.0 );
  } else if ( patternId > 1.5 && patternId < 2.5 ) {
    // stripes
    dfoPattern = sin( dfoPhi * uPatternScale * 2.0 );
  } else if ( patternId > 2.5 ) {
    // cross-hatch
    dfoPattern = max( abs( sin( dfoTheta * uPatternScale ) ), abs( sin( dfoPhi * uPatternScale * 2.0 ) ) );
  }
  // patternId <= 0.5 ("solid") leaves dfoPattern at 0.0 -- no modulation.
  diffuseColor.rgb *= ( 1.0 + dfoPattern * uPatternLuminanceDelta );

  float dfoRim = 1.0 - clamp( abs( dot( normalize( vViewPosition ), normal ) ), 0.0, 1.0 );
  float dfoFresnel = pow( dfoRim, uFresnelPower ) * uFresnelIntensity;
  totalEmissiveRadiance += diffuseColor.rgb * ( dfoFresnel + emissiveStrength );

  // Non-luminance focus outline (Section 5.2: "a non-luminance outline...
  // always carry [state]"): a ring at the grazing-angle rim, tinted with the
  // dedicated outline token color (never the node's own hue), active only
  // while emissiveStrength > 0 (hover/selected) -- idle nodes get the
  // fresnel/pattern life above but no ring. Selected nodes (emissiveStrength
  // 1.0) get a proportionally heavier band than hover (0.6), matching
  // Section 5.3's "persistent heavier outline" on selection. smoothstep
  // (rather than a hard step) gives the ring a one-fragment-ish
  // anti-aliased edge instead of a jagged boundary -- a cosmetic-only
  // change; the mask is still fully off at idle and the band math above is
  // untouched.
  float dfoOutlineBand = clamp( uOutlineWidth * 0.04, 0.02, 0.35 ) * ( 0.7 + 0.3 * emissiveStrength );
  float dfoOutlineMask = smoothstep( 1.0 - dfoOutlineBand - 0.015, 1.0 - dfoOutlineBand, dfoRim ) * step( 0.001, emissiveStrength );
`;

// Injected immediately after the literal `outgoingLight` composition line --
// AFTER lighting accumulation, so the outline ring is a flat, unlit accent
// (never re-shaded by the scene's directional/ambient lights), and BEFORE
// tonemapping/colorspace/fog (`#include <opaque_fragment>` etc.), so ACES
// tone mapping (Phase 1, Section 5.6 item 6's "no bloom, but ACES lives at
// the Canvas") still applies to the outline exactly like everything else.
const FRAGMENT_OUTLINE_MIX = /* glsl */ `
  outgoingLight = mix( outgoingLight, uOutlineColor, dfoOutlineMask );
`;

const NORMAL_FRAGMENT_MAPS_ANCHOR = "#include <normal_fragment_maps>";
const OUTGOING_LIGHT_ANCHOR = "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;";

/**
 * Pure shader-string patch, exported and directly unit-testable (jsdom
 * cannot compile a real WebGL program -- see this file's paired test for the
 * assertions run directly against three's own real
 * `ShaderLib.standard.fragmentShader`, following this directory's
 * established pure-function-extraction convention, e.g.
 * `InstancedNodes.tsx`'s `computeLodDistances`).
 */
export function patchNodeFragmentShader(source: string): string {
  return source
    .replace(COMMON_ANCHOR, `${COMMON_ANCHOR}\n${FRAGMENT_UNIFORM_DECLARATIONS}`)
    .replace(NORMAL_FRAGMENT_MAPS_ANCHOR, `${NORMAL_FRAGMENT_MAPS_ANCHOR}\n${FRAGMENT_PATTERN_AND_GLOW}`)
    .replace(OUTGOING_LIGHT_ANCHOR, `${OUTGOING_LIGHT_ANCHOR}\n${FRAGMENT_OUTLINE_MIX}`);
}

/**
 * Wires `patchNodeFragmentShader` plus the shared uniform objects onto
 * `material.onBeforeCompile`, preserving (and still calling) any
 * pre-existing handler -- `InstancedMesh2.patchMaterial` itself saves
 * whatever `onBeforeCompile` is set at the moment it takes over the material
 * (as `_onBeforeCompileBase`) and calls it FIRST, before applying its own
 * indirect-instancing patches (defines, `matricesTexture`/`colorsTexture`/
 * `uniformsTexture` uniforms, the `void main() {`-anchored uniformsTexture
 * fetch injection) -- so this function must be called BEFORE the material is
 * ever handed to `new InstancedMesh2(...)`, and must never silently replace
 * a caller-supplied prior handler.
 */
export function patchNodeMaterial(material: Material, uniforms: NodeMaterialUniformRefs): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = patchNodeFragmentShader(shader.fragmentShader);
  };
}
