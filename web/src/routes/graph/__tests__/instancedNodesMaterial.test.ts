// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.6 item
// 1 / Section 6 Phase 2): InstancedNodes' node-material wiring --
// per-instance pattern-id (community pattern, shared with badges/2D-
// fallback/a11y-tree via `communityPatternKind`, never a second color path),
// per-instance emissive drive (idle/hover/selected), and the selected-node
// size emphasis (Section 5.3: "Selection: ... plus size ..."). jsdom cannot
// exercise a real InstancedMesh2/WebGL draw call, so -- following this
// directory's established convention (instancedNodesLod.test.ts) -- the pure
// decision functions are unit-tested directly, and the material/texture
// wiring itself is confirmed via a structural source check.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeEmissiveStrength,
  computeNodeScale,
  patternIndexForNode,
  SELECTED_NODE_SCALE_MULTIPLIER,
} from "../three/InstancedNodes";
import { COMMUNITY_PATTERN_KINDS } from "../../../lib/communityGlyphs";
import type { VizNode } from "../types";

const THREE_DIR = join(__dirname, "..", "three");
function readSource(fileName: string): string {
  return readFileSync(join(THREE_DIR, fileName), "utf-8");
}

function entityNode(overrides: Partial<VizNode> & { id: string; community: number }): VizNode {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    type: overrides.type ?? "entity",
    kind: overrides.kind ?? "entity",
    degree: overrides.degree ?? 0,
    community: overrides.community,
    communityApproximate: overrides.communityApproximate ?? false,
    size: overrides.size ?? 1,
    level: overrides.level,
    centrality: overrides.centrality,
    parentCommunity: overrides.parentCommunity,
  };
}

describe("patternIndexForNode (shared community pattern-id source, Section 5.6 item 1)", () => {
  it("returns the same numeric index as COMMUNITY_PATTERN_KINDS.indexOf(communityPatternKind(community)) for entity nodes", () => {
    // community 0 -> pattern "solid" (index 0); community 8 -> "dots" (index 1); see communityGlyphs.ts's cycle math.
    expect(patternIndexForNode(entityNode({ id: "a", community: 0 }))).toBe(0);
    expect(patternIndexForNode(entityNode({ id: "b", community: 8 }))).toBe(
      COMMUNITY_PATTERN_KINDS.indexOf("dots"),
    );
    expect(patternIndexForNode(entityNode({ id: "c", community: 16 }))).toBe(
      COMMUNITY_PATTERN_KINDS.indexOf("stripes"),
    );
    expect(patternIndexForNode(entityNode({ id: "d", community: 24 }))).toBe(
      COMMUNITY_PATTERN_KINDS.indexOf("cross-hatch"),
    );
  });

  it("non-entity nodes (source/concept/session -- not community-colored) always get the neutral 'solid' pattern (index 0)", () => {
    const node = entityNode({ id: "s", community: 3, kind: "page", type: "source" });
    expect(patternIndexForNode(node)).toBe(0);
  });
});

describe("computeEmissiveStrength (idle/hover/selected drive, Section 5.2)", () => {
  const params = { emissiveIdle: 0, emissiveHover: 0.6, emissiveSelected: 1 };

  it("selected wins over hovered when a node is somehow both", () => {
    expect(computeEmissiveStrength(true, true, params)).toBe(1);
  });

  it("hovered (not selected) reads the hover token", () => {
    expect(computeEmissiveStrength(false, true, params)).toBeCloseTo(0.6, 5);
  });

  it("idle (neither) reads the idle token", () => {
    expect(computeEmissiveStrength(false, false, params)).toBe(0);
  });
});

describe("computeNodeScale (selection size emphasis, Section 5.3)", () => {
  it("selected nodes scale up by the documented multiplier", () => {
    expect(computeNodeScale(2, true)).toBeCloseTo(2 * SELECTED_NODE_SCALE_MULTIPLIER, 5);
  });

  it("non-selected nodes keep their base size exactly", () => {
    expect(computeNodeScale(2, false)).toBe(2);
  });
});

describe("InstancedNodes material wiring (structural, same convention as instancedNodesLod.test.ts)", () => {
  const source = readSource("InstancedNodes.tsx");

  it("patches the node material via patchNodeMaterial before the mesh is constructed (never vertexColors, Section 5.6 item 1)", () => {
    expect(source).toMatch(/patchNodeMaterial\(/);
    // Strip comments/JSDoc before checking for a live `vertexColors: true`
    // assignment -- the file's own doc comments legitimately discuss (in
    // prose) the historical bug this guards against, by name.
    const codeOnly = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toMatch(/vertexColors:\s*true/);
  });

  it("registers the second small data texture for pattern-id/emissive via InstancedMesh2's own uniformsTexture mechanism (same family as colorsTexture, still one draw call)", () => {
    expect(source).toMatch(/initUniformsPerInstance\(/);
    expect(source).toMatch(/patternId/);
    expect(source).toMatch(/emissiveStrength/);
  });

  it("sets per-instance pattern-id when instances are (re)built and per-instance emissive on hover/select changes", () => {
    expect(source).toMatch(/setUniform\(\s*["']patternId["']/);
    expect(source).toMatch(/setUniform\(\s*["']emissiveStrength["']/);
  });

  it("re-reads the shared uniform values from colors.nodeMaterial/colors.pattern (theme/token changes update every LOD tier without a recompile)", () => {
    expect(source).toMatch(/colors\.nodeMaterial/);
    expect(source).toMatch(/colors\.pattern/);
  });
});
