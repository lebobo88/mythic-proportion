// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.6 item
// 1 / Section 6 Phase 2, Section 12's named highest-risk judge checkpoint):
// the node `MeshStandardMaterial.onBeforeCompile` patch adding a fresnel
// rim, per-instance emissive drive, a non-luminance focus outline, and
// per-instance pattern-id luminance modulation -- entirely inside the
// material's single compiled program (no second mesh, no `vertexColors`,
// see InstancedNodes.tsx's documented black-multiply-bug comment, which
// this patch takes explicit care not to reintroduce).
//
// jsdom cannot compile a real WebGL program, so -- following this
// directory's own established convention (see instancedNodesLod.test.ts's
// pure-function extraction) -- the shader STRING patch is a pure function,
// tested directly against three's own real `ShaderLib.standard` fragment
// source (not a hand-written stand-in), plus a structural check that the
// wiring function attaches it via `onBeforeCompile` without discarding a
// prior handler.
import { describe, expect, it, vi } from "vitest";
import { MeshStandardMaterial, ShaderLib, type WebGLProgramParametersWithUniforms } from "three";
import {
  createNodeMaterialUniforms,
  patchNodeFragmentShader,
  patchNodeMaterial,
} from "../three/nodeMaterialShader";

describe("patchNodeFragmentShader (pure shader-string patch)", () => {
  const source = ShaderLib.standard.fragmentShader;
  const patched = patchNodeFragmentShader(source);

  it("never introduces vertexColors or a new geometry attribute (black-multiply bug guard, Section 3.3/5.6 item 1)", () => {
    expect(patched).not.toMatch(/vertexColors/);
    // The patch is additive text spliced after two known anchors -- isolate
    // exactly what was inserted (everything the un-patched source did NOT
    // already contain) and assert it never declares a new vertex/geometry
    // `attribute` (the actual mechanism the documented black-multiply bug
    // depends on: an undefined per-vertex `color` attribute resolving to
    // black and multiplying out the correct `colorsTexture` value).
    const originalLines = new Set(source.split("\n"));
    const insertedLines = patched.split("\n").filter((line) => !originalLines.has(line));
    expect(insertedLines.length).toBeGreaterThan(0);
    expect(insertedLines.join("\n")).not.toMatch(/attribute /);
  });

  it("preserves every original anchor include exactly once (additive patch, not a replacement)", () => {
    expect(patched.match(/#include <normal_fragment_maps>/g)).toHaveLength(1);
    expect(
      patched.match(/vec3 outgoingLight = totalDiffuse \+ totalSpecular \+ totalEmissiveRadiance;/g),
    ).toHaveLength(1);
  });

  it("injects the pattern/fresnel/emissive block immediately after <normal_fragment_maps>, before the next real anchor (<clearcoat_normal_fragment_begin>)", () => {
    const anchorIndex = patched.indexOf("#include <normal_fragment_maps>");
    const nextAnchorIndex = patched.indexOf("#include <clearcoat_normal_fragment_begin>");
    expect(nextAnchorIndex).toBeGreaterThan(anchorIndex);
    const between = patched.slice(anchorIndex, nextAnchorIndex);
    expect(between).toMatch(/diffuseColor\.rgb \*=/); // pattern luminance modulation
    expect(between).toMatch(/totalEmissiveRadiance \+=/); // fresnel + per-instance emissive
    expect(between).toMatch(/patternId/);
    expect(between).toMatch(/emissiveStrength/);
  });

  it("injects the outline mix immediately after the outgoingLight composition line, so the outline is unaffected by lighting", () => {
    const anchorIndex = patched.indexOf(
      "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
    );
    const nextAnchorIndex = patched.indexOf("#include <opaque_fragment>");
    expect(nextAnchorIndex).toBeGreaterThan(anchorIndex);
    const between = patched.slice(anchorIndex, nextAnchorIndex);
    expect(between).toMatch(/outgoingLight = mix\( outgoingLight, uOutlineColor, dfoOutlineMask \)/);
  });

  it("the pattern/fresnel block textually precedes the outline-mix block (declaration-before-use for dfoOutlineMask)", () => {
    const patternIndex = patched.indexOf("dfoOutlineMask =");
    const mixIndex = patched.indexOf("outgoingLight = mix( outgoingLight, uOutlineColor, dfoOutlineMask )");
    expect(patternIndex).toBeGreaterThan(-1);
    expect(mixIndex).toBeGreaterThan(patternIndex);
  });

  it("references only the per-instance uniformsTexture-derived locals (patternId, emissiveStrength) and shared uniforms (uFresnelPower/uFresnelIntensity/uOutlineColor/uOutlineWidth/uPatternLuminanceDelta/uPatternScale) -- no new per-vertex attribute", () => {
    const delta = patched.replace(source, "");
    for (const token of [
      "patternId",
      "emissiveStrength",
      "uFresnelPower",
      "uFresnelIntensity",
      "uOutlineColor",
      "uOutlineWidth",
      "uPatternLuminanceDelta",
      "uPatternScale",
    ]) {
      expect(delta).toMatch(new RegExp(token));
    }
    expect(delta).not.toMatch(/attribute /);
  });
});

// Browser Validator remediation cycle 2 (BROWSER_NEEDS_FIX, blocker): real
// Chrome/WebGL compilation failed with "undeclared identifier" for every
// shared uniform (uFresnelPower/uFresnelIntensity/uOutlineColor/
// uOutlineWidth/uPatternLuminanceDelta/uPatternScale), because they were
// set on `shader.uniforms` (JS-side value binding) but never declared as
// `uniform <type> <name>;` in the GLSL source itself -- vitest/jsdom never
// performs a real GLSL compile, so the string-transform tests above (which
// only checked insertion order/anchors) could not catch this class of bug.
// This is a general, practical static cross-check (no GPU context needed):
// every identifier in the patched fragment shader that follows this file's
// own "u" + capital-letter uniform-naming convention (uFresnelPower,
// uOutlineColor, etc.) must have a matching `uniform <type> <name>;`
// declaration line SOMEWHERE in the same patched source, textually BEFORE
// its first use (GLSL requires global-scope declaration-before-use). This
// would have failed against the pre-fix code (verified manually during
// remediation: reverting `patchNodeFragmentShader`'s uniform-declaration
// injection reproduces a RED failure here) and stays green as a permanent
// regression guard for this exact defect class.
describe("GLSL uniform declaration/reference cross-check (Browser Validator remediation cycle 2 -- catches undeclared-identifier shader compile failures without a real GPU)", () => {
  const source = ShaderLib.standard.fragmentShader;
  const patched = patchNodeFragmentShader(source);

  it("every u[A-Z]-prefixed identifier referenced in the patched shader has a matching `uniform <type> <name>;` declaration, textually before its first use", () => {
    const declared = new Map<string, { type: string; index: number }>();
    const declarationPattern = /uniform\s+(\w+)\s+(u[A-Z]\w*)\s*;/g;
    let match: RegExpExecArray | null;
    while ((match = declarationPattern.exec(patched))) {
      declared.set(match[2], { type: match[1], index: match.index });
    }
    expect(declared.size).toBeGreaterThan(0); // sanity: the cross-check itself must find something to check

    const referenced = new Set(patched.match(/\bu[A-Z]\w*\b/g));
    expect(referenced.size).toBeGreaterThan(0);

    for (const identifier of referenced) {
      const entry = declared.get(identifier);
      expect(entry, `"${identifier}" is referenced but never declared with \`uniform <type> ${identifier};\``).toBeDefined();
      const firstUseIndex = patched.indexOf(identifier);
      expect(
        entry!.index <= firstUseIndex,
        `"${identifier}" is declared AFTER its first use (declared at ${entry!.index}, used at ${firstUseIndex})`,
      ).toBe(true);
    }
  });

  it("uOutlineColor is declared as vec3 (matching the THREE.Color value bound via shader.uniforms, and the vec3 mix() overload it's used with)", () => {
    expect(patched).toMatch(/uniform\s+vec3\s+uOutlineColor\s*;/);
  });

  it("every scalar shared uniform (fresnel/pattern/outline-width numerics) is declared as float, matching the plain-number values createNodeMaterialUniforms sets", () => {
    for (const name of [
      "uFresnelPower",
      "uFresnelIntensity",
      "uOutlineWidth",
      "uPatternLuminanceDelta",
      "uPatternScale",
    ]) {
      expect(patched).toMatch(new RegExp(`uniform\\s+float\\s+${name}\\s*;`));
    }
  });

  it("the outline mix() call has matching vector dimensions on both interpolated operands (outgoingLight: vec3, uOutlineColor: vec3) -- the exact type-mismatch the live compiler reported", () => {
    // outgoingLight's own declaration, textually present in the untouched original source.
    expect(source).toMatch(/vec3 outgoingLight/);
    expect(patched).toMatch(/uniform\s+vec3\s+uOutlineColor\s*;/);
    expect(patched).toMatch(/mix\(\s*outgoingLight,\s*uOutlineColor,\s*dfoOutlineMask\s*\)/);
  });
});

describe("createNodeMaterialUniforms", () => {
  it("returns fresh, independent uniform-holder objects with the documented Phase-1-token defaults", () => {
    const a = createNodeMaterialUniforms();
    const b = createNodeMaterialUniforms();
    expect(a).not.toBe(b);
    expect(a.uFresnelPower.value).toBeCloseTo(2.5, 5);
    expect(a.uFresnelIntensity.value).toBeCloseTo(0.6, 5);
    expect(a.uOutlineWidth.value).toBe(2);
    expect(a.uPatternLuminanceDelta.value).toBeCloseTo(0.18, 5);
    expect(a.uPatternScale.value).toBe(3);
  });
});

describe("patchNodeMaterial (wiring)", () => {
  it("sets onBeforeCompile so the shared uniform objects are merged into shader.uniforms and the fragment shader is patched", () => {
    const material = new MeshStandardMaterial({ roughness: 0.5 });
    const uniforms = createNodeMaterialUniforms();
    patchNodeMaterial(material, uniforms);

    expect(material.onBeforeCompile).toBeTypeOf("function");
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: "",
      fragmentShader: ShaderLib.standard.fragmentShader,
    };
    material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as never);

    expect(shader.uniforms.uFresnelPower).toBe(uniforms.uFresnelPower); // SAME reference -- see file header (shared across every LOD program compile)
    expect(shader.fragmentShader).toMatch(/dfoOutlineMask/);
  });

  it("preserves and still calls a pre-existing onBeforeCompile handler (never silently drops InstancedMesh2's own base-handler chain)", () => {
    const material = new MeshStandardMaterial({ roughness: 0.5 });
    const previous = vi.fn();
    material.onBeforeCompile = previous;
    const uniforms = createNodeMaterialUniforms();
    patchNodeMaterial(material, uniforms);

    const shader = { uniforms: {}, vertexShader: "", fragmentShader: ShaderLib.standard.fragmentShader };
    const renderer = {};
    material.onBeforeCompile(shader as never, renderer as never);

    expect(previous).toHaveBeenCalledWith(shader, renderer);
  });

  it("never sets material.vertexColors (black-multiply bug guard, Section 3.3/5.6 item 1)", () => {
    const material = new MeshStandardMaterial({ roughness: 0.5 });
    const uniforms = createNodeMaterialUniforms();
    patchNodeMaterial(material, uniforms);
    expect(material.vertexColors).toBe(false);
  });
});
