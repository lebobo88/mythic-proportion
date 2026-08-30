// T3-advised escalation remediation round 2 (plan Section 11 escalation
// track -- residual Terrain-mode WebGL context loss; plan Section 5.6 item 6
// "bloom safe-tier degradation"). T3's Issue 1 finding: the Phase-4
// `<EffectComposer>` was mounted UNCONDITIONALLY in every mode, permanently
// allocating its full-resolution input/output render targets (plus the bloom
// effect's own half-res targets) even while the safe-tier ladder had bloom
// fully disabled -- exactly the standing GPU pressure that, combined with
// Terrain's settle-window churn, best explains the residual crashes.
//
// The fix under test: Graph3DScene now mounts the composer ONLY while the
// safe-tier ladder has bloom enabled (`flags.bloomEnabled`), with two
// carefully-bounded subtleties, each directly exercised here:
//  - `useComposerGate`: the unmount is DELAYED by the ladder's own bloom
//    fade duration, so the existing 150ms fade-to-zero completes before the
//    composer disappears (no mid-fade pop); remount on recovery is
//    immediate, so the fade-in has a composer to render through. A mode
//    TRANSITION's transient bloom suppression deliberately does NOT unmount
//    the composer -- tearing down/reallocating render targets every 800ms
//    transition would recreate the exact churn this job removes.
//  - `useDisposeOnDetach`: @react-three/postprocessing@2.19.1's own
//    EffectComposer never disposes the underlying `postprocessing` composer
//    on unmount (verified against the installed dist -- its unmount cleanup
//    only removes passes and restores tone mapping), so unmounting alone
//    would strand the full-res buffers until nondeterministic GC. The gate
//    therefore disposes the instance through the forwarded ref -- DEFERRED
//    by one microtask with same-instance-reattach cancellation, because
//    React 18 StrictMode's dev-mode effect double-invoke detaches and
//    synchronously reattaches the SAME memo-preserved composer instance,
//    and disposing it in that window would empty its internal pass list
//    (the lib's `useMemo`-owned RenderPass is never re-added) and break dev
//    rendering.
//
// Coverage follows this suite's established split: real commit-driven hook
// behavior via `renderHook` (no WebGL needed -- neither hook touches
// R3F/Three APIs), plus a structural source scan for the R3F wiring jsdom
// cannot render (same convention as graph3DSceneBloomWiring.structural.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerGate, useDisposeOnDetach } from "../three/Graph3DScene";

function readSceneSource(): string {
  return readFileSync(join(__dirname, "..", "three", "Graph3DScene.tsx"), "utf-8");
}

const FADE_MS = 150;

describe("useComposerGate: composer mounts only while safe-tier bloom is enabled, unmounting after the fade completes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mountGate(initialBloomEnabled: boolean) {
    return renderHook(
      ({ bloomEnabled }: { bloomEnabled: boolean }) => useComposerGate(bloomEnabled, () => FADE_MS),
      { initialProps: { bloomEnabled: initialBloomEnabled } },
    );
  }

  it("NEVER mounts the composer when bloom starts disabled (e.g. Minimal selected before 3D even mounts) -- zero render-target allocation, not allocate-then-free", () => {
    const { result } = mountGate(false);
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(FADE_MS * 10);
    });
    expect(result.current).toBe(false);
  });

  it("keeps the composer mounted through the bloom fade-out window, then unmounts once the fade duration has elapsed (no mid-fade pop)", () => {
    const { result, rerender } = mountGate(true);
    expect(result.current).toBe(true);

    // Safe-tier ladder disables bloom (level >= 1, including Balanced and
    // Minimal): the 150ms fade to zero must finish on-screen first.
    rerender({ bloomEnabled: false });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(FADE_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("remounts IMMEDIATELY when bloom re-enables (safe-tier recovery), so the fade-in has a composer to render through", () => {
    const { result, rerender } = mountGate(true);
    rerender({ bloomEnabled: false });
    act(() => {
      vi.advanceTimersByTime(FADE_MS);
    });
    expect(result.current).toBe(false);

    rerender({ bloomEnabled: true });
    expect(result.current).toBe(true);
  });

  it("cancels a pending unmount when bloom re-enables before the fade window elapses -- a rapid down/up ladder flap never tears the composer down", () => {
    const { result, rerender } = mountGate(true);
    rerender({ bloomEnabled: false });
    rerender({ bloomEnabled: true });
    act(() => {
      vi.advanceTimersByTime(FADE_MS * 10);
    });
    expect(result.current).toBe(true);
  });
});

describe("useDisposeOnDetach: deferred, StrictMode-safe disposal of the detached composer instance", () => {
  function flushMicrotasks(): Promise<void> {
    return Promise.resolve().then(() => undefined);
  }

  function makeDisposable() {
    return { dispose: vi.fn() };
  }

  it("disposes the instance after a REAL detach (composer unmounted by the gate) -- the lib itself never frees its render targets", async () => {
    const { result } = renderHook(() => useDisposeOnDetach<{ dispose(): void }>());
    const composer = makeDisposable();

    act(() => {
      result.current(composer);
      result.current(null);
    });
    await act(flushMicrotasks);
    expect(composer.dispose).toHaveBeenCalledTimes(1);
  });

  it("does NOT dispose across a StrictMode-shaped detach/reattach of the SAME instance -- disposing there would empty the lib composer's memo-owned pass list for good", async () => {
    const { result } = renderHook(() => useDisposeOnDetach<{ dispose(): void }>());
    const composer = makeDisposable();

    act(() => {
      // Exactly the callback-ref sequence React 18 StrictMode produces on
      // initial dev mount: attach, synchronous detach, synchronous reattach
      // of the same memo-preserved instance.
      result.current(composer);
      result.current(null);
      result.current(composer);
    });
    await act(flushMicrotasks);
    expect(composer.dispose).not.toHaveBeenCalled();

    // ...and a real detach AFTER the StrictMode dance still disposes.
    act(() => {
      result.current(null);
    });
    await act(flushMicrotasks);
    expect(composer.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a REPLACED instance even when a fresh one attaches immediately (gate off/on remount cycle)", async () => {
    const { result } = renderHook(() => useDisposeOnDetach<{ dispose(): void }>());
    const first = makeDisposable();
    const second = makeDisposable();

    act(() => {
      result.current(first);
      result.current(null);
      result.current(second);
    });
    await act(flushMicrotasks);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });
});

describe("structural wiring (jsdom has no WebGL -- same convention as graph3DSceneBloomWiring.structural.test.ts)", () => {
  const source = readSceneSource();

  it("the composer JSX is gated on the hook's mounted signal -- no longer unconditional", () => {
    expect(source).toMatch(/\{composerMounted \? \(\s*<EffectComposer/);
  });

  it("the gate is driven by the safe-tier ladder's OWN bloom flag (flags.bloomEnabled), never by the transient mode-transition suppression", () => {
    expect(source).toMatch(/useComposerGate\(flags\.bloomEnabled,/);
    expect(source).not.toMatch(/useComposerGate\([^)]*transitioning/);
  });

  it("the unmount delay reuses the ladder's own token-driven bloom fade duration (readBloomMotionParams().suppressMs), not an independent constant", () => {
    expect(source).toMatch(/useComposerGate\(flags\.bloomEnabled,\s*\(\) => readBloomMotionParams\(\)\.suppressMs\)/);
  });

  it("the composer's forwarded ref routes through useDisposeOnDetach so the postprocessing instance's render targets are genuinely freed on unmount", () => {
    expect(source).toMatch(/useDisposeOnDetach/);
    expect(source).toMatch(/<EffectComposer[^>]*ref=\{handleComposerDetach\}/);
  });
});
