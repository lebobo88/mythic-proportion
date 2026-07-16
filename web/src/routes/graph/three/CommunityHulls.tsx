// Translucent convex-hull volumes per community (deliverable 4) -- low
// alpha, few (one mesh per non-trivial community, not per node), colored
// from `--graph-hull-fill`. Recomputed only when positions settle enough to
// be worth the ConvexHull cost (throttled to a low-frequency interval, not
// every frame -- hulls are a coarse "where is this community roughly"
// indicator, not a live-following shrink-wrap).
import { useEffect, useState, type MutableRefObject } from "react";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { Vector3 } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import type { VizNode } from "../types";
import { COMMUNITY_COUNT } from "../graphMath";

export function CommunityHulls({
  nodes,
  visibleIds,
  colors,
  positionsRef,
}: {
  nodes: VizNode[];
  visibleIds: Set<string>;
  colors: GraphColors;
  /**
   * Latest {id -> [x,y,z]} position accessor, backed by the parent scene's
   * single reused tick buffer (see Graph3DScene's `positionsAccessorRef` --
   * Codex zero-allocation finding): a `Map`-like `.get(id)` surface, not
   * necessarily a real `Map`.
   */
  positionsRef: MutableRefObject<{ get(id: string): [number, number, number] | undefined }>;
}) {
  const [hulls, setHulls] = useState<{ community: number; geometry: ConvexGeometry }[]>([]);

  // Recomputed on a plain interval, NOT inside `useFrame` (per the "never
  // setState in useFrame" perf rule) -- hulls are a coarse, low-frequency
  // indicator, so decoupling their recompute cadence from the render loop
  // entirely (rather than throttling inside it) is both simpler and
  // strictly compliant.
  useEffect(() => {
    const id = window.setInterval(() => {
      const byCommunity = new Map<number, Vector3[]>();
      for (const node of nodes) {
        if (!visibleIds.has(node.id)) continue;
        const pos = positionsRef.current.get(node.id);
        if (!pos) continue;
        const list = byCommunity.get(node.community) ?? [];
        list.push(new Vector3(pos[0], pos[1], pos[2]));
        byCommunity.set(node.community, list);
      }

      const next: { community: number; geometry: ConvexGeometry }[] = [];
      for (const [community, points] of byCommunity) {
        if (points.length < 4) continue; // need >=4 non-coplanar points for a volume
        try {
          next.push({ community, geometry: new ConvexGeometry(points) });
        } catch {
          // Degenerate (coplanar) point sets throw inside ConvexHull -- skip that community this pass.
        }
      }
      setHulls(next);
    }, 800);
    return () => window.clearInterval(id);
  }, [nodes, visibleIds, positionsRef]);

  useEffect(() => {
    return () => {
      for (const hull of hulls) hull.geometry.dispose();
    };
  }, [hulls]);

  return (
    <group>
      {hulls.map(({ community, geometry }) => (
        <mesh key={community} geometry={geometry}>
          <meshBasicMaterial
            color={colors.community[community % COMMUNITY_COUNT]?.color ?? colors.hullFill.color}
            transparent
            opacity={colors.hullFill.alpha}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

