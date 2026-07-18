// Phase 4e (plan Section 6.7): Terrain-only chrome-layer skybox/HDRI
// environment. Enhancement-only: renders nothing (no scene mutation at all)
// when `skyboxUrl` is absent or the file fails to load, per this job's
// placeholder/fallback requirement -- Terrain must stay fully functional
// with zero generated assets.
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { useOptionalEquirectTexture } from "./terrainAssetLoading";

export interface TerrainEnvironmentProps {
  skyboxUrl?: string;
}

export function TerrainEnvironment({ skyboxUrl }: TerrainEnvironmentProps) {
  const { scene } = useThree();
  const { status, value: texture } = useOptionalEquirectTexture(skyboxUrl);

  useEffect(() => {
    if (status !== "loaded" || !texture) return;
    const previousBackground = scene.background;
    scene.background = texture;
    return () => {
      // Only clear if we're still the one that set it -- avoids clobbering
      // a background another mode/effect may have set in the meantime.
      if (scene.background === texture) {
        scene.background = previousBackground ?? null;
      }
    };
  }, [scene, status, texture]);

  // No visible primitive of its own -- this component's only job is the
  // `scene.background` side effect above (or, on missing/failed asset,
  // deliberately nothing).
  return null;
}
