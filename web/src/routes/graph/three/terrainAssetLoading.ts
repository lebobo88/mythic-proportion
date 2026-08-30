// Phase 4e (plan Section 6.7, Terrain shipped-asset capture): non-Suspense,
// non-throwing optional-asset loading for the Terrain chrome/environment
// layer (skybox/HDRI, matcap atlas, optional landmark GLBs).
//
// Deliberately NOT drei's `useTexture`/`useGLTF`, which suspend and THROW on
// a 404/decode failure. Graph3DScene.tsx wraps the whole Canvas in a single
// `WebglErrorBoundary` that drops the ENTIRE 3D scene to the 2D fallback on
// any child error -- exactly right for a real WebGL failure, but far too
// broad a blast radius for one missing/failed placeholder chrome asset. See
// this job's report: "the Terrain mode must remain fully functional with
// zero generated assets" (plan Section 6.7) -- every loader here resolves to
// an explicit `"error"` status instead of throwing, so a caller renders its
// existing procedural/token fallback and nothing else is affected.
//
// `loadOptional` is the pure, dependency-injected core (any object shaped
// like a three.js `Loader` works) so its graceful-fallback semantics are
// unit-testable without constructing a real `THREE.TextureLoader`/
// `GLTFLoader` or touching the filesystem/network -- see
// `terrainAssetLoading.test.ts`.
import { useEffect, useState } from "react";
import {
  EquirectangularReflectionMapping,
  Material,
  NoColorSpace,
  Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";

export type AssetLoadStatus = "idle" | "loading" | "loaded" | "error";

export interface OptionalAssetState<T> {
  status: AssetLoadStatus;
  value: T | null;
}

/** The minimal shape of a three.js `Loader` this module depends on -- lets tests inject a fake loader instead of touching the filesystem/network. */
export interface MinimalLoader<T> {
  load(url: string, onLoad: (value: T) => void, onProgress: undefined, onError: (error: unknown) => void): void;
}

/**
 * Resolves an asset via `loader`, NEVER rejects: resolves the loaded value
 * on success, or `null` on any load/decode failure. This is the entire
 * graceful-fallback contract this job's asset wiring depends on.
 */
export function loadOptional<T>(loader: MinimalLoader<T>, url: string): Promise<T | null> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (value) => resolve(value),
      undefined,
      () => resolve(null),
    );
  });
}

function useOptionalAsset<T>(
  url: string | undefined,
  loader: MinimalLoader<T>,
  onLoaded?: (value: T) => void,
  onDispose?: (value: T) => void,
): OptionalAssetState<T> {
  const [state, setState] = useState<OptionalAssetState<T>>({ status: url ? "loading" : "idle", value: null });

  useEffect(() => {
    let active = true;
    if (!url) {
      setState({ status: "idle", value: null });
      return;
    }
    setState({ status: "loading", value: null });
    loadOptional(loader, url).then((value) => {
      if (!active) return;
      if (value) {
        onLoaded?.(value);
        setState({ status: "loaded", value });
      } else {
        setState({ status: "error", value: null });
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, loader]);

  // GPU-resource disposal, mirroring this directory's established
  // convention (InstancedNodes.tsx's `mesh.dispose()`, NodeLabels.tsx's
  // `text.dispose()`, CommunityHulls.tsx's `hull.geometry.dispose()`):
  // fires when `state.value` is about to be replaced (a new url resolved)
  // or when the owning component unmounts (a mode switch away from
  // Terrain), so repeated placeholder-asset loads/mode switches never leak
  // GPU memory.
  useEffect(() => {
    const value = state.value;
    if (!value) return undefined;
    return () => onDispose?.(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.value]);

  return state;
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

/** Disposes every geometry/material (and any textures a material references) under `object`'s subtree -- used for a loaded landmark GLB's scene graph, which is not a single geometry/material like the ground mesh. */
export function disposeObject3D(object: Object3D): void {
  object.traverse((child) => {
    const mesh = child as unknown as { geometry?: { dispose(): void }; material?: Material | Material[] };
    mesh.geometry?.dispose();
    if (mesh.material) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        disposeMaterial(material);
      }
    }
  });
}

const defaultTextureLoader = new TextureLoader();
const defaultGltfLoader = new GLTFLoader();

/** Loads an equirectangular skybox/environment texture. Resolves `"error"` (never throws) on a missing file or decode failure. Disposed automatically on unmount/replacement. */
export function useOptionalEquirectTexture(
  url: string | undefined,
  loader: MinimalLoader<Texture> = defaultTextureLoader,
): OptionalAssetState<Texture> {
  return useOptionalAsset(
    url,
    loader,
    (texture) => {
      texture.mapping = EquirectangularReflectionMapping;
      texture.colorSpace = SRGBColorSpace;
    },
    (texture) => texture.dispose(),
  );
}

/** Loads a flat reference texture (e.g. a matcap atlas). Resolves `"error"` (never throws) on a missing file or decode failure. Disposed automatically on unmount/replacement. */
export function useOptionalTexture(
  url: string | undefined,
  loader: MinimalLoader<Texture> = defaultTextureLoader,
): OptionalAssetState<Texture> {
  return useOptionalAsset(
    url,
    loader,
    (texture) => {
      texture.colorSpace = SRGBColorSpace;
    },
    (texture) => texture.dispose(),
  );
}

/**
 * Terrain detail-normal tiling repeat factor (Deep-Field Observatory Phase 6,
 * plan Section 3.1 item 6 / Section 5.4 "A3 -- terrain detail/hillshade
 * texture"): the ground mesh's default `PlaneGeometry` UVs span [0, 1]
 * across the WHOLE mesh, so a single un-repeated sample would stretch the
 * 1024x1024 detail normal across the entire terrain footprint and read as
 * smooth, not as fine micro-relief. A flat planar (single-UV, top-down)
 * repeat is used rather than true multi-axis tri-planar blending because
 * this terrain is a near-flat heightfield (a fixed `TERRAIN_MAX_HEIGHT`
 * against a footprint in the hundreds -- see `TerrainSurface.tsx`), so
 * surface normals stay near-vertical everywhere and a top-down projection
 * does not visibly stretch on any slope actually present. A documented,
 * labeled simplification (Section 5.7's permitted variation), not a literal
 * tri-planar shader.
 */
const TERRAIN_DETAIL_NORMAL_REPEAT = 24;

/**
 * Loads the optional terrain detail/hillshade normal map (Deep-Field
 * Observatory Phase 6, plan Section 3.1 item 6 / Section 5.4 "A3"). Distinct
 * from `useOptionalTexture` in two ways a matcap/color texture must NOT have:
 * (1) `NoColorSpace`, never `SRGBColorSpace` -- a normal map is linear
 * per-channel XYZ data, and sRGB gamma-correcting it would invert/wash the
 * relief (Section 5.4: "LINEAR/`NoColorSpace` -- an sRGB flag would
 * invert/wash the relief"); (2) repeat-wrapped tiling (see
 * `TERRAIN_DETAIL_NORMAL_REPEAT` above) so the detail reads as fine surface
 * relief rather than one smooth stretch across the whole ground mesh.
 * Resolves `"error"` (never throws) on a missing file or decode failure,
 * same graceful-fallback contract as every other loader in this module --
 * absent, the ground mesh falls back to its existing `computeVertexNormals`
 * flat-normal plus vertex-color tier-banding path (Section 5.4 Fallback).
 */
export function useOptionalNormalTexture(
  url: string | undefined,
  loader: MinimalLoader<Texture> = defaultTextureLoader,
): OptionalAssetState<Texture> {
  return useOptionalAsset(
    url,
    loader,
    (texture) => {
      texture.colorSpace = NoColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.repeat.set(TERRAIN_DETAIL_NORMAL_REPEAT, TERRAIN_DETAIL_NORMAL_REPEAT);
    },
    (texture) => texture.dispose(),
  );
}

/** Loads an optional landmark GLB. Resolves `"error"` (never throws) on a missing file, network failure, or parse failure. Its scene graph is disposed automatically on unmount/replacement. */
export function useOptionalGLTF(
  url: string | undefined,
  loader: MinimalLoader<GLTF> = defaultGltfLoader,
): OptionalAssetState<GLTF> {
  return useOptionalAsset(url, loader, undefined, (gltf) => disposeObject3D(gltf.scene));
}
