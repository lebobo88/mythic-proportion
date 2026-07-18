// Phase 4e (plan Section 6.7): optional Trellis2-generated placeholder
// landmark meshes. Purely decorative Terrain chrome -- NEVER part of the
// InstancedMesh2 node/edge draw-call budget (Section 3.2's rendering hard
// boundary: the O(1.5k-10k) node/edge layer stays fully procedural). Each
// landmark independently renders nothing if its GLB is absent or fails to
// load, so a missing/broken landmark file never affects the ground mesh,
// the other landmarks, or the node/edge layer.
import { memo } from "react";
import { sampleElevation, TERRAIN_MAX_HEIGHT, type ElevationGrid } from "./terrainElevation";
import { useOptionalGLTF } from "./terrainAssetLoading";
import type { TerrainLandmarkAsset } from "./terrainAssetManifest";

export interface TerrainLandmarksProps {
  grid: ElevationGrid;
  landmarks: TerrainLandmarkAsset[];
}

export function TerrainLandmarks({ grid, landmarks }: TerrainLandmarksProps) {
  return (
    <>
      {landmarks.map((landmark) => (
        <TerrainLandmark key={landmark.url} grid={grid} landmark={landmark} />
      ))}
    </>
  );
}

interface TerrainLandmarkProps {
  grid: ElevationGrid;
  landmark: TerrainLandmarkAsset;
}

/** `gridFraction` -> world position, sampling the SAME shared elevation grid `TerrainSurface.tsx` builds, so a landmark sits on the surface rather than floating or clipping through it (mirrors the worker/`TerrainSurface` shared-elevation convention from the Phase 4a spike). */
export function terrainLandmarkWorldPosition(grid: ElevationGrid, landmark: TerrainLandmarkAsset): [number, number, number] {
  const span = grid.cellSize * grid.size;
  const worldX = grid.minX + ((landmark.gridFraction[0] + 1) / 2) * span;
  const worldZ = grid.minZ + ((landmark.gridFraction[1] + 1) / 2) * span;
  const worldY = sampleElevation(grid, worldX, worldZ) * TERRAIN_MAX_HEIGHT;
  return [worldX, worldY, worldZ];
}

const TerrainLandmark = memo(function TerrainLandmark({ grid, landmark }: TerrainLandmarkProps) {
  const { status, value: gltf } = useOptionalGLTF(landmark.url);
  if (status !== "loaded" || !gltf) return null;

  const position = terrainLandmarkWorldPosition(grid, landmark);

  return <primitive object={gltf.scene} position={position} scale={landmark.scale ?? 1} />;
});
