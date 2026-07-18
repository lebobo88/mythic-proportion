// Phase 4e (plan Section 6.7, Terrain shipped-asset capture): unit coverage
// for the non-Suspense, non-throwing optional-asset loading contract that
// `TerrainSurface.tsx`, `TerrainEnvironment.tsx`, and `TerrainLandmarks.tsx`
// all depend on. `loadOptional` is exercised directly against a fake
// `MinimalLoader` (no real THREE.TextureLoader/GLTFLoader, no filesystem or
// network access) so the graceful-fallback semantics -- resolve `null`,
// never reject/throw, on any failure -- are proven as real behavior, not
// just asserted structurally.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  disposeObject3D,
  loadOptional,
  useOptionalEquirectTexture,
  useOptionalGLTF,
  useOptionalTexture,
  type MinimalLoader,
} from "../three/terrainAssetLoading";

function fakeLoader<T>(behavior: "succeed" | "fail", value?: T): MinimalLoader<T> {
  return {
    load(_url, onLoad, _onProgress, onError) {
      // Simulate the loader's real async callback timing (three's loaders
      // never resolve synchronously) via a microtask.
      Promise.resolve().then(() => {
        if (behavior === "succeed") {
          onLoad(value as T);
        } else {
          onError(new Error("simulated load failure"));
        }
      });
    },
  };
}

describe("loadOptional", () => {
  it("resolves the loaded value on success", async () => {
    const loader = fakeLoader<{ name: string }>("succeed", { name: "texture" });
    const result = await loadOptional(loader, "https://example.test/asset.png");
    expect(result).toEqual({ name: "texture" });
  });

  it("resolves null (never rejects) on a load failure -- the entire graceful-fallback contract", async () => {
    const loader = fakeLoader("fail");
    await expect(loadOptional(loader, "https://example.test/missing.png")).resolves.toBeNull();
  });
});

describe("useOptionalTexture", () => {
  it("starts idle when no url is given", () => {
    const loader = fakeLoader<{ id: number }>("succeed", { id: 1 });
    const { result } = renderHook(() => useOptionalTexture(undefined, loader as MinimalLoader<never>));
    expect(result.current.status).toBe("idle");
    expect(result.current.value).toBeNull();
  });

  it("transitions loading -> loaded on success and applies the sRGB color-space post-load hook", async () => {
    const texture = { colorSpace: "", dispose: vi.fn() } as unknown as { colorSpace: string; dispose: () => void };
    const loader = fakeLoader("succeed", texture);
    const { result } = renderHook(() => useOptionalTexture("terrain/matcap-clay.png", loader as never));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.value).toBe(texture);
  });

  it("transitions loading -> error on failure -- never throws out of the hook", async () => {
    const loader = fakeLoader("fail");
    const { result } = renderHook(() => useOptionalTexture("terrain/missing.png", loader as never));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.value).toBeNull();
  });

  it("does not update state after unmount (no React act warning / no leak)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const loader = fakeLoader("succeed", { dispose: vi.fn() });
    const { unmount } = renderHook(() => useOptionalTexture("terrain/matcap-clay.png", loader as never));
    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("disposes the GPU texture on unmount, mirroring this directory's InstancedNodes/NodeLabels/CommunityHulls disposal convention -- so repeated Terrain mode switches never leak GPU memory", async () => {
    const dispose = vi.fn();
    const texture = { colorSpace: "", dispose };
    const loader = fakeLoader("succeed", texture);
    const { result, unmount } = renderHook(() => useOptionalTexture("terrain/matcap-clay.png", loader as never));
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(dispose).not.toHaveBeenCalled();
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the PREVIOUS texture (not the new one) when the url changes to a different asset", async () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const loaderA = fakeLoader("succeed", { colorSpace: "", dispose: disposeA });
    const loaderB = fakeLoader("succeed", { colorSpace: "", dispose: disposeB });
    const { result, rerender } = renderHook(
      ({ url, loader }: { url: string; loader: MinimalLoader<never> }) => useOptionalTexture(url, loader),
      { initialProps: { url: "terrain/matcap-clay.png", loader: loaderA as never } },
    );
    await waitFor(() => expect(result.current.status).toBe("loaded"));

    rerender({ url: "terrain/matcap-stone.png", loader: loaderB as never });
    await waitFor(() => expect(result.current.status).toBe("loaded"));

    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();
  });
});

describe("useOptionalEquirectTexture", () => {
  it("resolves error status (not a throw) for a missing skybox file", async () => {
    const loader = fakeLoader("fail");
    const { result } = renderHook(() => useOptionalEquirectTexture("terrain/skybox-dusk.png", loader as never));
    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});

describe("useOptionalGLTF", () => {
  it("resolves error status (not a throw) for a missing landmark GLB", async () => {
    const loader = fakeLoader("fail");
    const { result } = renderHook(() => useOptionalGLTF("terrain/landmarks/missing.glb", loader as never));
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("resolves loaded status with the parsed GLTF value on success", async () => {
    const gltf = { scene: { traverse: vi.fn() } };
    const loader = fakeLoader("succeed", gltf);
    const { result } = renderHook(() => useOptionalGLTF("terrain/landmarks/obelisk.glb", loader as never));
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.value).toBe(gltf);
  });

  it("disposes the landmark's scene graph (geometry + material per mesh) on unmount", async () => {
    const geometryDispose = vi.fn();
    const materialDispose = vi.fn();
    const meshChild = { geometry: { dispose: geometryDispose }, material: { dispose: materialDispose } };
    const scene = {
      traverse(visit: (child: unknown) => void) {
        visit(meshChild);
      },
    };
    const loader = fakeLoader("succeed", { scene });
    const { result, unmount } = renderHook(() => useOptionalGLTF("terrain/landmarks/obelisk.glb", loader as never));
    await waitFor(() => expect(result.current.status).toBe("loaded"));

    unmount();

    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });
});

describe("disposeObject3D", () => {
  it("disposes every child's geometry and material(s), including a multi-material mesh", () => {
    const geometryDisposeA = vi.fn();
    const geometryDisposeB = vi.fn();
    const materialDisposeA = vi.fn();
    const materialDisposeB = vi.fn();
    const childA = { geometry: { dispose: geometryDisposeA }, material: { dispose: materialDisposeA } };
    const childB = {
      geometry: { dispose: geometryDisposeB },
      material: [{ dispose: materialDisposeB }, { dispose: materialDisposeB }],
    };
    const object = {
      traverse(visit: (child: unknown) => void) {
        visit(childA);
        visit(childB);
      },
    };

    disposeObject3D(object as never);

    expect(geometryDisposeA).toHaveBeenCalledTimes(1);
    expect(geometryDisposeB).toHaveBeenCalledTimes(1);
    expect(materialDisposeA).toHaveBeenCalledTimes(1);
    expect(materialDisposeB).toHaveBeenCalledTimes(2);
  });

  it("tolerates a child with no geometry/material (e.g. a plain Group node)", () => {
    const object = {
      traverse(visit: (child: unknown) => void) {
        visit({});
      },
    };
    expect(() => disposeObject3D(object as never)).not.toThrow();
  });
});
