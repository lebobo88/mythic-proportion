// Custom InstancedMesh2 node layer (deliverable 1/2): one draw call for
// every node, BVH frustum-culling + BVH raycasting + hover/select handled
// entirely via instance-matrix/color mutation -- NEVER React state inside
// the per-frame path (`applyPositions` mutates the GPU-backed textures
// directly; the only React state this file's consumer holds is the
// discrete "selected id" / "hovered id" UI state -- see GraphView.tsx).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Color, IcosahedronGeometry, MeshStandardMaterial, PlaneGeometry } from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import type { GraphColors } from "../../../lib/graph-colors";
import { COMMUNITY_PATTERN_KINDS, communityPatternKind } from "../../../lib/communityGlyphs";
import type { VizNode } from "../types";
import { computeFitDistance, type GraphFitRequest } from "./CameraRig";
import { createNodeMaterialUniforms, patchNodeMaterial } from "./nodeMaterialShader";

export interface InstancedNodesHandle {
  /** Mutate instance positions from the latest worker tick -- called from Graph3DScene's single useFrame. */
  applyPositions(positions: Float32Array, ids: string[]): void;
}

export interface InstancedNodesProps {
  nodes: VizNode[];
  visibleIds: Set<string>;
  colors: GraphColors;
  selectedId: string | null;
  hoveredId: string | null;
  neighborIds: Set<string>;
  onHoverNode: (id: string | null) => void;
  onSelectNode: (id: string) => void;
  /**
   * Latest camera-fit request (same object Graph3DScene hands CameraRig on
   * every worker "end") -- used to rescale the LOD tier thresholds to the
   * distance the camera actually settles at. See `computeLodDistances`.
   */
  fit?: GraphFitRequest | null;
  /**
   * T2 remediation (bounded investigation, plan Section 6.5 closeout
   * finding): `true` while Graph3DScene has an active mode-switch transition
   * blend in flight. Suppresses the flat-quad LOD2 tier for that window (see
   * `computeLodDistances`'s `suppressFarTier` doc comment for the full
   * root-cause rationale) -- optional/defaults to `false` so every other
   * caller (tests, `ModeSpikeView`) is unaffected.
   */
  transitionActive?: boolean;
  /**
   * Deep-Field Observatory Phase 4 (plan Section 5.3 "Safe-tier
   * choreography" step 4 -- see `applySafeTierLod`'s doc comment above for
   * the full scope rationale). `true` while the safe-tier degradation
   * ladder (auto-driven by `PerformanceMonitor`, or a manual "Minimal"
   * effects-tier selection, both owned by Graph3DScene.tsx/GraphView.tsx)
   * has reached its LOD step -- forces every node to the cheapest flat-quad
   * tier. Optional/defaults to `false` so every other caller (tests,
   * `ModeSpikeView`) is unaffected, matching `transitionActive`'s own
   * convention exactly.
   */
  safeTier?: boolean;
}

// LOD tiers (reflexion critique item 1 / ADR-0501 fitness criteria): a real
// per-instance distance-driven detail reduction, not just "one geometry for
// everyone." LOD0 (near, ~42-vert icosahedron) is used for close-up /
// hovered / selected-range nodes; LOD1 drops to a 12-vert icosahedron past
// the lod1 threshold; LOD2 collapses to a single flat quad -- a cheap
// point-sprite-equivalent -- past the lod2 threshold, which is what makes
// ~50k nodes affordable once the camera is zoomed out. InstancedMesh2 buckets
// each *instance* into whichever tier its own camera distance falls into
// every frame (not a single mesh-wide LOD), so this scales with visible
// density, not total node count.
const GEOMETRY_NEAR = new IcosahedronGeometry(1, 1); // ~42 verts
const GEOMETRY_MID = new IcosahedronGeometry(1, 0); // 12 verts
const GEOMETRY_FAR = new PlaneGeometry(1.4, 1.4); // 4 verts, point-sprite-equivalent

// Pre-fit defaults AND permanent floors for the scaled thresholds below --
// tuned for the initial [0,0,60] camera, and exactly the values that were
// previously hardcoded as the ONLY thresholds.
export const DEFAULT_LOD1_DISTANCE = 90;
export const DEFAULT_LOD2_DISTANCE = 260;

export interface LodDistances {
  lod1: number;
  lod2: number;
}

/**
 * T2 remediation (bounded investigation, plan Section 6.5 closeout finding):
 * a sentinel `lod2` value used to fully suppress the flat-quad tier during an
 * active mode-transition blend -- see `computeLodDistances`'s `suppressFarTier`
 * param and `instancedNodesLod.test.ts`'s "LOD2 (flat-quad) tier can be
 * suppressed" describe block for the full root-cause evidence and rationale.
 * Chosen far beyond any plausible real-world graph radius (settled Cloud
 * radius is documented at ~596 at the 1500-node disclosure cap; this is
 * several orders of magnitude past that) so no node can select LOD2 while
 * suppressed, without using `Infinity` (kept a finite, directly-assertable
 * value for test/debug clarity).
 */
export const LOD_FAR_TIER_SUPPRESSED_DISTANCE = 1_000_000;

/**
 * T2 remediation (3D graph "collapse at ~8s" -- LOD-threshold root cause;
 * see instancedNodesLod.test.ts for the full live-capture evidence): the
 * LOD tier thresholds used to be FIXED absolute distances (90/260), while
 * camera-fit legitimately parks the camera at `computeFitDistance(radius,
 * fov)` -- ~2.2x the fit radius at the default fov of 75 -- so any real
 * graph with a settled radius past ~120 world units put EVERY node beyond
 * the flat-quad threshold the moment the fit completed: healthy, spread-out
 * 3D positions rendered as tiny unshaded flat quads that read as a
 * "collapsed dense clump" (the same symptom class as the original audit's
 * flattest-LOD-tier bug, which was fixed on the graph-radius side only).
 *
 * This scales the thresholds off the ACTUAL fit geometry instead:
 *  - `lod1` = the near edge of the visible node band (`fitDistance -
 *    fitRadius`): anything the user dollies closer than the settled graph's
 *    near edge gets the full 42-vert geometry.
 *  - `lod2` = 1.5x the FAR edge of the band (`fitDistance + fitRadius`):
 *    strictly beyond every visible node at the settled view, so the
 *    flat-quad tier only engages on a genuine manual zoom-out well past the
 *    fitted framing -- its actual purpose.
 * At the settled fit view the whole graph therefore renders as solid,
 * shaded geometry (mostly the 12-vert mid tier), never the flat tier. The
 * original constants remain as floors so small/close-up graphs (fit
 * distance in the old regime) behave exactly as before. `lod2 > lod1` holds
 * for every input (`lod2 >= 1.5*(D+R) > D >= lod1`), which
 * `updateAllLOD`'s strictly-increasing validation requires.
 *
 * `suppressFarTier` (T2 remediation, plan Section 6.5 closeout finding: a
 * transient "jagged black/teal" artifact observed in roughly 1/5 Orbital ->
 * Cloud mode-switch attempts): while `true`, pins `lod2` to
 * `LOD_FAR_TIER_SUPPRESSED_DISTANCE`, defeating the flat-quad tier entirely.
 * The regression test above proves NO real node ever selects LOD2 at a
 * settled/fit view -- it exists only for a genuine manual zoom-out well past
 * the fitted framing. During an in-flight mode-transition blend, `fit`
 * (hence these thresholds) is still the PREVIOUS mode's stale, already-
 * settled geometry, while positions are actively blending toward the new
 * mode's live (and, for some mode pairs -- e.g. Orbital's shell radius
 * versus Cloud's much larger settled radius -- substantially larger) target.
 * That stale-threshold/live-geometry mismatch is exactly the one window
 * where a real, currently-visible node CAN transiently cross into LOD2's
 * flat, non-billboarded `PlaneGeometry` (`GEOMETRY_FAR`), which -- unlike
 * LOD0/1's real icosahedra -- never rotates to face the camera
 * (`applyPositions` only ever mutates `.position`) and so can render
 * near-black at a grazing view/light angle under the scene's single
 * `directionalLight`. Suppressing LOD2 for the ~800ms blend window closes
 * that one window without changing steady-state (non-transitioning)
 * behavior at all: `lod1` (the real-geometry near/mid split) is untouched.
 */
export function computeLodDistances(
  fitDistance: number,
  fitRadius: number,
  suppressFarTier = false,
): LodDistances {
  const lod1 = Math.max(DEFAULT_LOD1_DISTANCE, fitDistance - fitRadius);
  const lod2 = suppressFarTier
    ? LOD_FAR_TIER_SUPPRESSED_DISTANCE
    : Math.max(DEFAULT_LOD2_DISTANCE, (fitDistance + fitRadius) * 1.5);
  return { lod1, lod2 };
}

/**
 * Deep-Field Observatory Phase 4 (plan Section 5.3 "Safe-tier choreography"
 * step 4 / Section 6 Phase 4: "(4) LOD drops to the safe tier"). SCOPE NOTE:
 * this is a deliberately narrow, additive touch to the pre-existing (P5-era,
 * pre-Phase-2) LOD-threshold computation path ONLY -- this job's non-goals
 * forbid touching Phase 2's node material/shader/badges/labels work
 * elsewhere in this file, and this function/prop changes none of it. See
 * `instancedNodesSafeTierLod.test.ts` for the full scope rationale.
 *
 * `computeLodDistances` above can only ever push thresholds OUT (its
 * `Math.max(DEFAULT_LOD*_DISTANCE, ...)` floors), so a caller cannot force a
 * MORE aggressive tier by feeding it a smaller fit -- this is the one
 * legitimate seam to do that: when `safeTier` is true, collapse both
 * thresholds to a near-zero pair (`lod1` 0, `lod2` a small positive
 * epsilon), so every node -- at any real camera distance -- immediately
 * selects the cheapest flat-quad tier, regardless of what the transition-
 * suppression path above computed. Safe-tier degradation always wins over
 * transition suppression when both are simultaneously requested (a rare
 * edge case: an auto-degrade firing mid-transition), since dropping detail
 * is strictly cheaper, never a correctness regression, in that overlap.
 */
export const SAFE_TIER_LOD_DISTANCE = 0.01;

export function applySafeTierLod(distances: LodDistances, safeTier: boolean): LodDistances {
  if (!safeTier) return distances;
  return { lod1: 0, lod2: SAFE_TIER_LOD_DISTANCE };
}

function colorForNode(node: VizNode, colors: GraphColors): Color {
  if (node.kind === "entity") {
    return colors.community[node.community % colors.community.length]?.color ?? colors.node.entity.color;
  }
  const key = node.type as keyof GraphColors["node"];
  return colors.node[key]?.color ?? colors.node.concept.color;
}

/**
 * Deep-Field Observatory Phase 2 (plan Section 5.6 item 1): the per-instance
 * pattern-id fed into the second small data texture (`nodeMaterialShader.ts`
 * / `initUniformsPerInstance` below) -- derived from `communityGlyphKind`
 * (`lib/communityGlyphs.ts`, the SAME single source `CommunityBadge.tsx`/
 * `GraphA11yTree.tsx`/the 2D fallback already use), so the in-canvas shader
 * pattern can never disagree with the badge/legend/2D-fallback/a11y-tree
 * non-color cue for the same community. Non-entity nodes (source/concept/
 * session -- colored by TYPE, not community) always get "solid" (index 0,
 * no luminance modulation in the shader) since they carry no community
 * membership to encode a pattern for.
 */
export function patternIndexForNode(node: VizNode): number {
  if (node.kind !== "entity") return 0;
  return COMMUNITY_PATTERN_KINDS.indexOf(communityPatternKind(node.community));
}

/**
 * Deep-Field Observatory Phase 2 (plan Section 5.2 "Components and states":
 * "idle (... emissive 0 ...) / hover (emissive 0.6) / selected (emissive
 * 1.0)"). Selected wins over hovered (a node can be both, e.g. re-hovering
 * the currently-selected node) -- matches `InstancedNodes`' existing
 * `isFocused`/dim-precedence convention below.
 */
export function computeEmissiveStrength(
  isSelected: boolean,
  isHovered: boolean,
  params: { emissiveIdle: number; emissiveHover: number; emissiveSelected: number },
): number {
  if (isSelected) return params.emissiveSelected;
  if (isHovered) return params.emissiveHover;
  return params.emissiveIdle;
}

/** Deep-Field Observatory Phase 2 (plan Section 5.3 "Selection": "... plus size ..."). Tunable per Section 5.7's permitted variation. */
export const SELECTED_NODE_SCALE_MULTIPLIER = 1.15;

export function computeNodeScale(baseSize: number, isSelected: boolean): number {
  return isSelected ? baseSize * SELECTED_NODE_SCALE_MULTIPLIER : baseSize;
}

export const InstancedNodes = forwardRef<InstancedNodesHandle, InstancedNodesProps>(function InstancedNodes(
  {
    nodes,
    visibleIds,
    colors,
    selectedId,
    hoveredId,
    neighborIds,
    onHoverNode,
    onSelectNode,
    fit = null,
    transitionActive = false,
    safeTier = false,
  },
  ref,
) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const idToIndex = useRef(new Map<string, number>());
  const lastMoveAt = useRef(0);

  // NOTE (Issue 1 fix / live-Chrome finding): InstancedMesh2 drives
  // per-instance color entirely through its own `colorsTexture` (patched
  // into the material's shader by the library itself the moment any
  // `entity.color = ...` is set below) -- it does NOT use three's normal
  // per-vertex `color` geometry attribute. Setting `vertexColors: true`
  // here additionally told three's own MeshStandardMaterial shader to
  // multiply in a geometry `color` attribute that GEOMETRY_NEAR/MID/FAR
  // never define, which resolves to black and was the actual cause of the
  // "nodes render as tiny dark squares" bug: every instance was fully
  // correct in `colorsTexture` but then multiplied by (0,0,0). Community/
  // type colors flow from `colorForNode` -> `entity.color` only.
  //
  // Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.6
  // item 1): `patchNodeMaterial` adds the fresnel rim/per-instance emissive/
  // non-luminance outline/pattern-luminance shader patch -- still driven
  // entirely by `colorsTexture` plus the second small `uniformsTexture`
  // data texture below, NEVER `vertexColors`, so this documented bug stays
  // fixed. `materialUniforms` is created ONCE (stable across re-renders) and
  // shared BY REFERENCE into every LOD tier's separately-compiled program
  // (see nodeMaterialShader.ts's file header) -- the effect further below
  // mutates its `.value` fields whenever `colors.nodeMaterial`/
  // `colors.pattern` change (a theme flip or a future token change), so a
  // shader recompile is never needed for that.
  const materialUniforms = useMemo(() => createNodeMaterialUniforms(), []);
  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ roughness: 0.5 });
    patchNodeMaterial(m, materialUniforms);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mesh = useMemo(() => {
    const capacity = Math.max(1, nodes.length);
    const m = new InstancedMesh2(GEOMETRY_NEAR, material, { capacity, createEntities: true, renderer: gl });
    // Real distance-driven LOD tiers -- see the GEOMETRY_* comment above.
    // Registered with the pre-fit default thresholds; rescaled to the actual
    // camera-fit geometry by the `updateAllLOD` effect below on every fit.
    m.addLOD(GEOMETRY_MID, material, DEFAULT_LOD1_DISTANCE);
    m.addLOD(GEOMETRY_FAR, material, DEFAULT_LOD2_DISTANCE);
    // Deep-Field Observatory Phase 2 (Section 5.6 item 1): the per-instance
    // pattern-id/emissive-drive data -- a SECOND small data texture in the
    // SAME `SquareDataTexture` mechanism family `colorsTexture` itself uses
    // (@three.ez/instanced-mesh's `uniformsTexture`), not a hand-rolled
    // duplicate -- fetched entirely in the fragment shader (both fields are
    // fragment-only, see nodeMaterialShader.ts), still ONE draw call. Must
    // run before any `entity.setUniform(...)` call below (the library throws
    // otherwise).
    m.initUniformsPerInstance({ fragment: { patternId: "float", emissiveStrength: "float" } });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, gl]);

  // Deep-Field Observatory Phase 2 (Section 5.7 permitted variation: "exact
  // numerics may be tuned ... provided they remain token-driven and
  // both-theme-gated"): mirrors a theme/mode flip into the SHARED uniform
  // objects above -- every already-compiled LOD program's live uniform
  // updates without a recompile (see the `material`/`materialUniforms`
  // comment above). Discrete (fires on `colors` identity change -- a theme
  // flip via `subscribeGraphColors`, or a community-count/mode change),
  // never per-frame.
  useEffect(() => {
    materialUniforms.uFresnelPower.value = colors.nodeMaterial.fresnelPower;
    materialUniforms.uFresnelIntensity.value = colors.nodeMaterial.fresnelIntensity;
    materialUniforms.uOutlineColor.value.copy(colors.nodeMaterial.outlineColor.color);
    materialUniforms.uOutlineWidth.value = colors.nodeMaterial.outlineWidth;
    materialUniforms.uPatternLuminanceDelta.value = colors.pattern.luminanceDelta;
    materialUniforms.uPatternScale.value = colors.pattern.scale;
  }, [materialUniforms, colors.nodeMaterial, colors.pattern]);

  useEffect(() => {
    return () => mesh.dispose();
  }, [mesh]);

  // Rescale the LOD tier thresholds to the distance the camera actually
  // settles at, on every fit (initial load, data reload, mode switch --
  // `fit.nonce` bumps each time, changing the object's identity). Discrete,
  // low-frequency, never part of the per-frame path. The fov read and
  // `computeFitDistance` call mirror CameraRig's fit handler exactly, so
  // these thresholds always describe the same view the camera ends up in.
  useEffect(() => {
    if (!fit) return;
    const perspective = camera as unknown as { fov?: number; isPerspectiveCamera?: boolean };
    const fovDeg = perspective.isPerspectiveCamera && perspective.fov ? perspective.fov : 50;
    const distance = computeFitDistance(fit.radius, fovDeg);
    const { lod1, lod2 } = applySafeTierLod(computeLodDistances(distance, fit.radius, transitionActive), safeTier);
    mesh.updateAllLOD([lod1, lod2]);
  }, [mesh, camera, fit, transitionActive, safeTier]);

  // Rebuild instances whenever the node set itself changes (data reload / filter
  // membership) -- NOT on every tick, and NOT via setState.
  useEffect(() => {
    mesh.clearInstances();
    const map = new Map<string, number>();
    mesh.addInstances(nodes.length, (entity, index) => {
      const node = nodes[index];
      map.set(node.id, index);
      entity.scale.setScalar(node.size);
      entity.color = colorForNode(node, colors);
      entity.visible = visibleIds.has(node.id);
      // Deep-Field Observatory Phase 2 (Section 5.6 item 1): pattern-id never
      // depends on hover/select, so it's fully correct here at build time --
      // the community <-> pattern mapping is fixed, shared with
      // badges/2D-fallback/a11y-tree via `patternIndexForNode`. Emissive/
      // scale start at their neutral defaults here (same division of labor
      // as `entity.color`/`entity.opacity` above -- the recolor effect below
      // runs immediately after, on the SAME `nodes` change, and corrects
      // both against the current hover/select state).
      entity.setUniform("patternId", patternIndexForNode(node));
      entity.updateMatrix();
    });
    idToIndex.current = map;
    mesh.computeBVH();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, nodes]);

  // Recolor/re-show on filter/hover/select changes without touching positions.
  useEffect(() => {
    for (const node of nodes) {
      const index = idToIndex.current.get(node.id);
      if (index === undefined || !mesh.instances) continue;
      const entity = mesh.instances[index];
      if (!entity) continue;
      entity.visible = visibleIds.has(node.id);
      const isSelected = selectedId === node.id;
      const isHovered = hoveredId === node.id;
      const isFocused = isSelected || isHovered;
      const isDimmed =
        (hoveredId !== null || selectedId !== null) &&
        !isFocused &&
        !neighborIds.has(node.id);
      entity.opacity = isDimmed ? 0.1 : 1;
      entity.color = colorForNode(node, colors);
      // Deep-Field Observatory Phase 2 (Section 5.2/5.3 J-FOCUS): the
      // per-instance emissive drive (idle/hover/selected) and the selected-
      // node size emphasis -- `computeNodeScale` is a cheap no-op comparison
      // for every non-(de)selecting node (see its own doc comment), so this
      // never adds a meaningful per-node cost to a loop that already runs on
      // every hover/select change.
      entity.setUniform("emissiveStrength", computeEmissiveStrength(isSelected, isHovered, colors.nodeMaterial));
      const targetScale = computeNodeScale(node.size, isSelected);
      if (entity.scale.x !== targetScale) {
        entity.scale.setScalar(targetScale);
        entity.updateMatrix();
      }
    }
  }, [mesh, nodes, colors, selectedId, hoveredId, neighborIds, visibleIds]);

  useImperativeHandle(
    ref,
    () => ({
      applyPositions(positions, ids) {
        if (!mesh.instances) return;
        for (let i = 0; i < ids.length; i++) {
          const index = idToIndex.current.get(ids[i]);
          if (index === undefined) continue;
          const entity = mesh.instances[index];
          if (!entity) continue;
          entity.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
          entity.updateMatrixPosition();
        }
      },
    }),
    [mesh],
  );

  function nodeIdFromInstanceId(instanceId: number | undefined): string | null {
    if (instanceId === undefined) return null;
    for (const [id, index] of idToIndex.current) if (index === instanceId) return id;
    return null;
  }

  return (
    <primitive
      object={mesh}
      onPointerMove={(event: { instanceId?: number; stopPropagation: () => void }) => {
        const now = performance.now();
        if (now - lastMoveAt.current < 48) return; // throttle: GPU/BVH pick, never per-frame raycast
        lastMoveAt.current = now;
        event.stopPropagation();
        onHoverNode(nodeIdFromInstanceId(event.instanceId));
      }}
      onPointerOut={() => onHoverNode(null)}
      onClick={(event: { instanceId?: number; stopPropagation: () => void }) => {
        event.stopPropagation();
        const id = nodeIdFromInstanceId(event.instanceId);
        if (id) onSelectNode(id);
      }}
    />
  );
});
