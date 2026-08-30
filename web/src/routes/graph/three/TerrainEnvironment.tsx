// Phase 4e (plan Section 6.7): Terrain-only chrome-layer skybox/HDRI
// environment. Enhancement-only: renders nothing (no scene mutation at all)
// when `skyboxUrl` is absent or the file fails to load AND no `fallbackColor`
// is supplied, per this job's placeholder/fallback requirement -- Terrain
// must stay fully functional with zero generated assets.
//
// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-TERRAIN: "an HDRI sky ... Light theme uses a bright high-key sky paired
// with darkened graph elements"; Section 5.4 "Fallback": "A1/A2 absent ->
// procedural token sky plus default lights, environment unset" -- NO
// generated HDRI exists yet, Phase 6 territory, so this fallback path is
// what makes Terrain's "theme-paired sky" acceptance requirement (plan
// Section 8.3 item 6) actually reachable today): `fallbackColor` (typically
// `colors.terrainChrome.skyHorizon.color`, token-driven, both themes) is
// applied to `scene.background` ONLY while no real HDRI has loaded --
// an HDRI, once loaded, always wins over the flat procedural fallback.
// Optional/defaults to `undefined` so every pre-Phase-5 caller (tests,
// `ModeSpikeView`) keeps the exact prior byte-for-byte behavior (renders
// nothing at all when neither a skybox nor a fallback color is given).
// Deep-Field Observatory Phase 6 (plan Section 3.1 item 6 / Section 6 Phase
// 6: "Extend `TerrainEnvironment.tsx` to drive `scene.environment` IBL
// (PMREM) plus `scene.background`"): once a real HDRI has loaded, a
// `PMREMGenerator` prefilters it into a radiance environment map assigned to
// `scene.environment` (image-based lighting on the ground mesh's
// `meshStandardMaterial`/`meshMatcapMaterial`), scaled by the per-theme
// `--graph-env-intensity` token (`envIntensity`, read via
// `readEnvironmentParams` in `lib/graph-colors.ts` and threaded down by
// `TerrainSurface.tsx`). Per Section 5.4's Fallback contract ("A1/A2 absent
// -> procedural token sky plus default lights, environment unset"), with no
// HDRI loaded `scene.environment` is left alone entirely -- no synthesized
// procedural IBL map is built; `scene.background`'s existing token-driven
// `fallbackColor` path (unchanged below) is what carries the "procedural
// token sky" half of that fallback.
import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { PMREMGenerator, type Color, type Texture, type WebGLRenderTarget } from "three";
import { useOptionalEquirectTexture } from "./terrainAssetLoading";

export interface TerrainEnvironmentProps {
  skyboxUrl?: string;
  fallbackColor?: Color;
  /** Per-theme `--graph-env-intensity` (dark 1.0 / light 1.15, graph.css) -- scales `scene.environmentIntensity` once a real HDRI drives `scene.environment`. Defaults to 1 so every pre-Phase-6 caller (tests, ModeSpikeView) is byte-identical when omitted. */
  envIntensity?: number;
}

export function TerrainEnvironment({ skyboxUrl, fallbackColor, envIntensity = 1 }: TerrainEnvironmentProps) {
  const { scene, gl } = useThree();
  const { status, value: texture } = useOptionalEquirectTexture(skyboxUrl);

  // One PMREMGenerator per mounted TerrainEnvironment, reused across HDRI
  // swaps (theme flips never change `skyboxUrl` itself today, but a future
  // caller changing it should not construct a new WebGLRenderer-bound
  // generator per load) -- disposed on unmount below.
  const pmremGenerator = useMemo(() => new PMREMGenerator(gl), [gl]);
  useEffect(() => {
    return () => pmremGenerator.dispose();
  }, [pmremGenerator]);

  useEffect(() => {
    if (status !== "loaded" || !texture) {
      // Procedural token-sky fallback (Section 5.4 "Fallback"): no real HDRI
      // has loaded (absent, still loading, or failed) -- apply the flat,
      // theme-paired sky color instead of silently leaving whatever
      // background a previous mode/effect set. `scene.environment` is
      // deliberately left untouched here (Section 5.4: "environment unset").
      if (!fallbackColor) return undefined;
      const previousBackground = scene.background;
      scene.background = fallbackColor;
      return () => {
        if (scene.background === fallbackColor) {
          scene.background = previousBackground ?? null;
        }
      };
    }
    const previousBackground = scene.background;
    const previousEnvironment = scene.environment;
    const previousEnvironmentIntensity = scene.environmentIntensity;
    scene.background = texture;

    const pmremRenderTarget: WebGLRenderTarget = pmremGenerator.fromEquirectangular(texture);
    const environmentTexture: Texture = pmremRenderTarget.texture;
    scene.environment = environmentTexture;
    scene.environmentIntensity = envIntensity;

    return () => {
      // Only clear if we're still the one that set it -- avoids clobbering
      // a background/environment another mode/effect may have set in the
      // meantime (same discipline as the background-only Phase 5 path).
      if (scene.background === texture) {
        scene.background = previousBackground ?? null;
      }
      if (scene.environment === environmentTexture) {
        scene.environment = previousEnvironment ?? null;
        scene.environmentIntensity = previousEnvironmentIntensity;
      }
      pmremRenderTarget.dispose();
    };
  }, [scene, status, texture, fallbackColor, pmremGenerator, envIntensity]);

  // No visible primitive of its own -- this component's only job is the
  // `scene.background`/`scene.environment` side effects above (or, on
  // missing/failed asset with no fallback color, deliberately nothing).
  return null;
}
