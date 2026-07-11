// Custom InstancedMesh2 node layer (deliverable 1/2): one draw call for
// every node, BVH frustum-culling + BVH raycasting + hover/select handled
// entirely via instance-matrix/color mutation -- NEVER React state inside
// the per-frame path (`applyPositions` mutates the GPU-backed textures
// directly; the only React state this file's consumer holds is the
// discrete "selected id" / "hovered id" UI state -- see GraphView.tsx).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Color, IcosahedronGeometry, MeshStandardMaterial } from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import type { GraphColors } from "../../../lib/graph-colors";
import type { VizNode } from "../types";

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
}

const GEOMETRY = new IcosahedronGeometry(1, 1);

function colorForNode(node: VizNode, colors: GraphColors): Color {
  if (node.kind === "entity") {
    return colors.community[node.community % colors.community.length]?.color ?? colors.node.entity.color;
  }
  const key = node.type as keyof GraphColors["node"];
  return colors.node[key]?.color ?? colors.node.concept.color;
}

export const InstancedNodes = forwardRef<InstancedNodesHandle, InstancedNodesProps>(function InstancedNodes(
  { nodes, visibleIds, colors, selectedId, hoveredId, neighborIds, onHoverNode, onSelectNode },
  ref,
) {
  const gl = useThree((state) => state.gl);
  const idToIndex = useRef(new Map<string, number>());
  const lastMoveAt = useRef(0);

  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), []);

  const mesh = useMemo(() => {
    const capacity = Math.max(1, nodes.length);
    return new InstancedMesh2(GEOMETRY, material, { capacity, createEntities: true, renderer: gl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, gl]);

  useEffect(() => {
    return () => mesh.dispose();
  }, [mesh]);

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
