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
import type { VizNode } from "../types";
import { computeFitDistance, type GraphFitRequest } from "./CameraRig";

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

function colorForNode(node: VizNode, colors: GraphColors): Color {
  if (node.kind === "entity") {
    return colors.community[node.community % colors.community.length]?.color ?? colors.node.entity.color;
  }
  const key = node.type as keyof GraphColors["node"];
  return colors.node[key]?.color ?? colors.node.concept.color;
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
  const material = useMemo(() => new MeshStandardMaterial({ roughness: 0.5 }), []);

  const mesh = useMemo(() => {
    const capacity = Math.max(1, nodes.length);
    const m = new InstancedMesh2(GEOMETRY_NEAR, material, { capacity, createEntities: true, renderer: gl });
    // Real distance-driven LOD tiers -- see the GEOMETRY_* comment above.
    // Registered with the pre-fit default thresholds; rescaled to the actual
    // camera-fit geometry by the `updateAllLOD` effect below on every fit.
    m.addLOD(GEOMETRY_MID, material, DEFAULT_LOD1_DISTANCE);
    m.addLOD(GEOMETRY_FAR, material, DEFAULT_LOD2_DISTANCE);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, gl]);

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
    const { lod1, lod2 } = computeLodDistances(distance, fit.radius, transitionActive);
    mesh.updateAllLOD([lod1, lod2]);
  }, [mesh, camera, fit, transitionActive]);

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
      const isFocused = selectedId === node.id || hoveredId === node.id;
      const isDimmed =
        (hoveredId !== null || selectedId !== null) &&
        !isFocused &&
        !neighborIds.has(node.id);
      entity.opacity = isDimmed ? 0.1 : 1;
      entity.color = colorForNode(node, colors);
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
