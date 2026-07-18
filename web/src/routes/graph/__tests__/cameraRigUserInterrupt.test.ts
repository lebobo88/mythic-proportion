// T2 remediation, second/final attempt on the zoom-direction defect (see the
// T2 job report for the full evidence trail). Root cause: `CameraRig`'s own
// `useFrame` runs at R3F's DEFAULT priority (0), while
// `@react-three/drei`'s `<OrbitControls>` wrapper registers its own
// `controls.update()` call at priority -1 (`node_modules/@react-three/drei
// /core/OrbitControls.js`, line 29-31) -- R3F sorts subscribers ascending,
// so OrbitControls' own update() always runs FIRST on every frame. That is
// fine on its own. The bug is that CameraRig's `useFrame`, which runs
// SECOND, unconditionally overwrites `camera.position`/`orbit.target` via
// direct `lerpVectors` assignment for as long as `animRef.current` is set
// (~400-600ms per fit/focus animation) -- discarding whatever dolly scale
// the user's own wheel input applied earlier that exact frame (three-stdlib
// applies wheel input SYNCHRONOUSLY inside its own `wheel` DOM listener --
// see `handleMouseWheel`/`onMouseWheel` in `node_modules/three-stdlib/
// controls/OrbitControls.js` -- so it lands before either `useFrame`
// subscriber runs, but gets stomped on afterward by CameraRig's own
// override).
//
// This race is exactly what the Browser Validator's own readiness
// definition (plan Section 9.4: "the worker's 'end' event has been
// reached") guarantees gets hit on every fresh-load repro: the SAME "end"
// event that signals readiness is what triggers the initial camera-fit
// animation in Graph3DScene's `onEnd` handler. Any wheel input dispatched
// at or shortly after readiness lands inside that fit animation's ~500ms
// window, where the animation is unconditionally moving the camera FARTHER
// than its `[0,0,60]` start position (real graphs almost always need a fit
// distance > 60 world units) -- which is why BOTH scroll directions net as
// "dolly out" at every magnitude tested: the scripted animation wins every
// single frame of that window, and it only ever moves outward on first
// load.
//
// The fix: cancel any in-flight scripted animation the instant the user
// begins a REAL OrbitControls interaction. three-stdlib's OrbitControls
// dispatches its own "start" event synchronously for every drag-rotate,
// drag-pan, AND wheel-dolly gesture (`onMouseDown`/`onMouseWheel`, same
// file) -- independent of R3F's frame loop -- so subscribing to it is a
// reliable, zero-latency hand-off signal. This is also what the passed
// design handoff requires: the motion spec (plan Section 5.1, M1) calls the
// camera transition "interruptible".
//
// `attachUserInterruptListener` is the small pure piece of that fix
// genuinely testable without a real WebGL/Canvas context (which jsdom can't
// provide -- see this directory's other tests' own established
// convention): it only needs an object shaped like three-stdlib's
// `EventDispatcher` (`addEventListener`/`removeEventListener`), which is
// exactly what `OrbitControls` (and the real `controls` R3F's `useThree`
// exposes) already is. What is NOT unit-testable here is the full,
// rendered, wheel-event-to-camera-distance behavior in a live `<Canvas>` --
// that remains a genuine, labeled limit, verifiable only live via Browser
// Validator, same honesty standard as the StrictMode and first-fix job
// reports.
import { describe, expect, it, vi } from "vitest";
import { attachUserInterruptListener } from "../three/CameraRig";

/** Minimal fake mirroring three-stdlib's `EventDispatcher` surface (the
 *  actual base class `OrbitControls` extends) -- captures listeners exactly
 *  the way the real class does, with no three.js/R3F/DOM dependency. */
function makeFakeEventDispatcher() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    hasListener(type: string, listener: () => void) {
      return listeners.get(type)?.has(listener) ?? false;
    },
  };
}

describe("attachUserInterruptListener (CameraRig user-interrupt wiring)", () => {
  it("invokes the callback when the controls dispatch their own 'start' event -- the exact synchronous signal three-stdlib fires for drag-rotate, drag-pan, AND wheel-dolly alike", () => {
    const controls = makeFakeEventDispatcher();
    const onUserStart = vi.fn();

    attachUserInterruptListener(controls, onUserStart);
    expect(onUserStart).not.toHaveBeenCalled();

    controls.dispatchEvent("start");
    expect(onUserStart).toHaveBeenCalledTimes(1);

    // A second real gesture (e.g. a second wheel tick) must interrupt again --
    // this is not a one-shot subscription.
    controls.dispatchEvent("start");
    expect(onUserStart).toHaveBeenCalledTimes(2);
  });

  it("composes with a ref-clearing callback to actually cancel an in-flight scripted animation the instant real user input arrives -- the exact composition CameraRig wires up", () => {
    const controls = makeFakeEventDispatcher();
    const animRef = { current: { toPos: "somewhere-far-away" } as unknown };

    attachUserInterruptListener(controls, () => {
      animRef.current = null;
    });

    // Scripted fit/focus animation is mid-flight...
    expect(animRef.current).not.toBeNull();
    // ...until the user actually touches the controls (any gesture, including
    // a wheel-dolly), which must win immediately, same frame.
    controls.dispatchEvent("start");
    expect(animRef.current).toBeNull();
  });

  it("returns a cleanup function that removes the listener (no leaked subscription across CameraRig remounts/controls swaps)", () => {
    const controls = makeFakeEventDispatcher();
    const onUserStart = vi.fn();

    const cleanup = attachUserInterruptListener(controls, onUserStart);
    cleanup();

    controls.dispatchEvent("start");
    expect(onUserStart).not.toHaveBeenCalled();
  });

  it("is a no-op (never throws) when controls is undefined -- CameraRig's `useThree` selector can transiently report no controls yet", () => {
    const onUserStart = vi.fn();
    expect(() => attachUserInterruptListener(undefined, onUserStart)).not.toThrow();
    const cleanup = attachUserInterruptListener(undefined, onUserStart);
    expect(() => cleanup()).not.toThrow();
  });
});

describe("CameraRig source wires the interrupt listener into its OrbitControls effect (structural -- confirms the exported pure function above is actually connected, not merely defined)", () => {
  it("subscribes to `controls` via attachUserInterruptListener and clears animRef.current from the callback", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "three", "CameraRig.tsx"), "utf-8");

    expect(source).toMatch(/attachUserInterruptListener\(\s*[\s\S]*?,\s*\(\)\s*=>\s*\{\s*animRef\.current\s*=\s*null;?/);
  });
});
