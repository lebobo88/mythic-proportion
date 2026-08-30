// T3-advised escalation remediation round 2 (plan Section 11 escalation
// track; plan Section 5.1 J-CONTEXT-LOSS). T3's Issue 2 finding (the
// structural recovery gap, must-fix regardless of Issue 1's effectiveness):
// the app's context-loss-to-2D recovery had exactly TWO triggers -- the DOM
// `webglcontextlost` event and a React error boundary -- and NEITHER can see
// the two failure shapes observed live: (a) a silent frameloop freeze (the
// GPU process hangs, rAF starves, no event ever fires -- frozen last frame,
// Terrain toggle still selected, no 2D fallback), and (b) a throw inside the
// R3F render loop, which runs via requestAnimationFrame OUTSIDE React's
// render/commit phase, so no React boundary can catch it (verified against
// the installed @react-three/fiber@8.17.10: `loop()` schedules the next rAF
// FIRST, so a per-frame throw doesn't even stop the loop -- it silently
// skips every later subscriber plus the render, frame after frame).
//
// Fixes under test:
//  - `useFrameloopWatchdog`: an interval OUTSIDE the render loop (the
//    documented setInterval convention, never setState-in-useFrame) that
//    fires the existing report()/onContextLost recovery path when the
//    frame stamp -- written refs-only inside the existing useFrame -- stops
//    advancing for FRAMELOOP_STALL_THRESHOLD_MS while the canvas is neither
//    `paused` (frameloop="never") nor in a hidden tab (rAF is legitimately
//    suspended in both; the stamp is DEFERRED there, which also prevents a
//    false trigger on the first check after returning to a
//    long-backgrounded tab).
//  - `wrapRenderWithRecovery`: wraps `gl.render` (patched once in
//    `onCreated`; R3F v8's `<Canvas>` has no onError prop) so a throw
//    crossing the renderer boundary -- whether from R3F's auto-render or
//    from any of the EffectComposer's internal per-pass renders -- reaches
//    the same recovery path, then rethrows so diagnostics stay visible.
//
// Both are exported pure/hook seams tested without a WebGL context (this
// directory's established convention); the R3F wiring is pinned structurally.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import {
  FRAMELOOP_STALL_THRESHOLD_MS,
  FRAMELOOP_WATCHDOG_POLL_MS,
  useFrameloopWatchdog,
  wrapRenderWithRecovery,
} from "../three/Graph3DScene";

function readSceneSource(): string {
  return readFileSync(join(__dirname, "..", "three", "Graph3DScene.tsx"), "utf-8");
}

describe("useFrameloopWatchdog: silent-freeze detection independent of webglcontextlost", () => {
  let hiddenValue = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hiddenValue = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hiddenValue,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hiddenValue ? "hidden" : "visible"),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as { hidden?: boolean }).hidden;
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  });

  function mount(paused: boolean) {
    const stampRef: MutableRefObject<number> = { current: 0 };
    const onStall = vi.fn();
    const hook = renderHook(
      ({ p }: { p: boolean }) => useFrameloopWatchdog(stampRef, p, onStall),
      { initialProps: { p: paused } },
    );
    return { stampRef, onStall, ...hook };
  }

  function stall(stampRef: MutableRefObject<number>) {
    stampRef.current = performance.now() - FRAMELOOP_STALL_THRESHOLD_MS - 1;
  }

  it("fires the recovery callback once the stamp stops advancing past the stall threshold -- the observed frozen-last-frame crash shape", () => {
    const { stampRef, onStall } = mount(false);
    stall(stampRef);
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS);
    });
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("never fires while frames keep committing (the stamp advances between checks)", () => {
    const { stampRef, onStall } = mount(false);
    for (let i = 0; i < 10; i++) {
      stampRef.current = performance.now();
      act(() => {
        vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS);
      });
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  it("never fires while paused (frameloop=\"never\" during a tab excursion) -- rAF is legitimately stopped, not crashed", () => {
    const { stampRef, onStall } = mount(true);
    stall(stampRef);
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS * 20);
    });
    expect(onStall).not.toHaveBeenCalled();
  });

  it("never fires while the tab is hidden (browsers suspend rAF for hidden tabs), and does NOT false-trigger on the first check after the tab becomes visible again", () => {
    const { stampRef, onStall } = mount(false);
    hiddenValue = true;
    stall(stampRef);
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS * 20);
    });
    expect(onStall).not.toHaveBeenCalled();

    // Tab returns: the hidden-window deferral must have kept the stamp
    // fresh, so a healthy resuming loop is given a full threshold window.
    hiddenValue = false;
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS);
    });
    expect(onStall).not.toHaveBeenCalled();
  });

  // T2 bounded remediation (Verifier finding): the interval's own
  // `document.hidden` deferral is NOT a reliable hidden-tab re-arm, because
  // real browsers throttle/suspend background-tab interval callbacks (e.g.
  // Chrome's Intensive Timer Throttling clamps to ~once per minute after 5
  // minutes hidden). These tests model that by running ZERO interval
  // callbacks across the entire hidden period -- `vi.advanceTimersByTime`
  // alone cannot express this, since it fires the poll on-schedule
  // regardless of hidden state. The reliable re-arm is the
  // `visibilitychange` lifecycle event, which browsers deliver even after
  // heavy throttling.
  it("does NOT false-trigger when the tab was backgrounded past the stall threshold with ZERO interim poll callbacks (real throttling): visibilitychange re-arms the stamp synchronously before the next poll can compare", () => {
    const { stampRef, onStall } = mount(false);
    // Tab goes hidden; throttling suppresses EVERY poll callback for the
    // whole hidden stretch -- no timers are advanced. The stamp is simply
    // older than the threshold by the time the tab returns.
    hiddenValue = true;
    stall(stampRef);
    // Tab becomes visible again: the browser reliably fires
    // visibilitychange. This must re-arm the stamp IMMEDIATELY (in the
    // handler itself), not on some later poll tick.
    hiddenValue = false;
    document.dispatchEvent(new Event("visibilitychange"));
    // The very next poll compares against the re-armed stamp.
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS);
    });
    expect(onStall).not.toHaveBeenCalled();
  });

  it("still detects a GENUINE stall after a visible transition -- the visibilitychange re-arm grants one fresh threshold window, it does not disarm the watchdog", () => {
    const { stampRef, onStall } = mount(false);
    hiddenValue = true;
    stall(stampRef);
    hiddenValue = false;
    document.dispatchEvent(new Event("visibilitychange"));
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS);
    });
    expect(onStall).not.toHaveBeenCalled();
    // Now the frameloop actually freezes while visible.
    stall(stampRef);
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS);
    });
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("removes the visibilitychange listener on unmount (a later visible transition no longer touches the stamp)", () => {
    const { stampRef, unmount } = mount(false);
    unmount();
    hiddenValue = true;
    stall(stampRef);
    const staleStamp = stampRef.current;
    hiddenValue = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stampRef.current).toBe(staleStamp);
  });

  it("re-arms after firing instead of hammering the callback every poll (production report() is latched anyway; this keeps the hook itself polite)", () => {
    const { stampRef, onStall } = mount(false);
    stall(stampRef);
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS * 3);
    });
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("stops polling entirely on unmount", () => {
    const { stampRef, onStall, unmount } = mount(false);
    unmount();
    stall(stampRef);
    act(() => {
      vi.advanceTimersByTime(FRAMELOOP_WATCHDOG_POLL_MS * 5);
    });
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe("wrapRenderWithRecovery: the render-loop error path React boundaries structurally cannot provide", () => {
  it("routes a render throw to the recovery callback and rethrows (diagnostics stay visible; recovery is latched upstream)", () => {
    const boom = new Error("shader recompile exploded");
    const onRenderError = vi.fn();
    const wrapped = wrapRenderWithRecovery(() => {
      throw boom;
    }, onRenderError);

    expect(() => wrapped()).toThrow(boom);
    expect(onRenderError).toHaveBeenCalledTimes(1);
  });

  it("is a transparent passthrough for a healthy render (same args in, same value out, no recovery call)", () => {
    const onRenderError = vi.fn();
    const render = vi.fn((a: number, b: number) => a + b);
    const wrapped = wrapRenderWithRecovery(render, onRenderError);

    expect(wrapped(2, 3)).toBe(5);
    expect(render).toHaveBeenCalledWith(2, 3);
    expect(onRenderError).not.toHaveBeenCalled();
  });
});

describe("structural wiring (jsdom cannot mount a real <Canvas> -- same convention as graph3DSceneModeWiring.structural.test.ts)", () => {
  const source = readSceneSource();

  it("the existing useFrame stamps the liveness ref FIRST, refs-only (never setState in useFrame)", () => {
    expect(source).toMatch(/useFrame\(\(\) => \{\s*(\/\/[^\n]*\n\s*)*frameStampRef\.current = performance\.now\(\);/);
  });

  it("the watchdog is wired at the Canvas-owning level with the pause signal and the existing report() recovery path", () => {
    expect(source).toMatch(/useFrameloopWatchdog\(frameStampRef,\s*paused === true,\s*report\)/);
  });

  it("gl.render is wrapped through wrapRenderWithRecovery inside onCreated, routing to the same report() path", () => {
    expect(source).toMatch(/state\.gl\.render = wrapRenderWithRecovery\(/);
    expect(source).toMatch(/wrapRenderWithRecovery\([\s\S]{0,200}report\)/);
  });

  it("a webglcontextrestored listener is registered alongside the existing webglcontextlost one (recovery-timing symmetry/diagnostics)", () => {
    expect(source).toMatch(/addEventListener\("webglcontextlost"/);
    expect(source).toMatch(/addEventListener\("webglcontextrestored"/);
  });
});
