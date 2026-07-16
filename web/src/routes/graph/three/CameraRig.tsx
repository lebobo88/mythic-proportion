// Eased camera moves (deliverable 7 + Issue 2 fix): damped lerp toward a
// focus target OR a graph-fit request over ~400-600ms using the shared
// `--ease-emphasized` motion token (see lib/motion.ts) -- collapses to an
// instant snap when `prefers-reduced-motion` is set, per deliverable 10.
//
// Two independent trigger props share one animation engine:
//  - `focusTarget`: a single node's position (Cmd+K jump / selection) --
//    unchanged deliverable-7 behavior, fixed +6 z offset.
//  - `fitRequest`: the whole-graph (or whole-disclosed-subset) bounding
//    sphere, computed once the worker layout settles (`onEngineStop`) --
//    Issue 2 (BLOCKING): most nodes started off-screen because nothing ever
//    moved the camera to frame the graph. `nonce` forces a re-fit even when
//    the computed center/radius happen to be unchanged (re-heat on data
//    change always bumps it).
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { getDuration, prefersReducedMotion } from "../../../lib/motion";

export interface GraphFitRequest {
  center: [number, number, number];
  radius: number;
  /** Bumped on every fit request so effect deps fire even if center/radius repeat. */
  nonce: number;
}

export interface CameraRigProps {
  /** World-space point to focus on, or null to leave the camera alone. */
  focusTarget: [number, number, number] | null;
  /** Bounding-sphere fit request (camera fit-to-graph on load / dataset change), or null. */
  fitRequest: GraphFitRequest | null;
}

interface OrbitControlsLike {
  target?: Vector3;
  update?: () => void;
}

export function CameraRig({ focusTarget, fitRequest }: CameraRigProps) {
  const { camera, controls } = useThree((state) => ({ camera: state.camera, controls: state.controls }));
  const animRef = useRef<{
    fromPos: Vector3;
    toPos: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
    start: number;
    durationMs: number;
  } | null>(null);

  function startAnim(toPos: Vector3, toTarget: Vector3) {
    const orbit = controls as OrbitControlsLike | undefined;
    const reduced = prefersReducedMotion();
    const fromTarget = orbit?.target?.clone() ?? toTarget.clone();
    if (reduced) {
      camera.position.copy(toPos);
      orbit?.target?.copy(toTarget);
      camera.lookAt(toTarget);
      orbit?.update?.();
      animRef.current = null;
      return;
    }
    animRef.current = {
      fromPos: camera.position.clone(),
      toPos,
      fromTarget,
      toTarget,
      start: performance.now(),
      durationMs: Math.max(400, getDuration("slow") || 500),
    };
  }

  // Selection / Cmd+K focus (deliverable 7): unchanged fixed-offset behavior.
  useEffect(() => {
    if (!focusTarget) return;
    const to = new Vector3(...focusTarget);
    startAnim(new Vector3(to.x, to.y, to.z + 6), to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget]);

  // Camera fit-to-graph (Issue 2): frame the bounding sphere with enough
  // padding that the whole disclosed graph is inside the view frustum,
  // preserving whatever direction the camera is currently looking from
  // (falls back to the initial +z direction if the camera is exactly at
  // the target, e.g. first load).
  useEffect(() => {
    if (!fitRequest) return;
    const center = new Vector3(...fitRequest.center);
    const perspective = camera as unknown as { fov?: number; isPerspectiveCamera?: boolean };
    const fovDeg = perspective.isPerspectiveCamera && perspective.fov ? perspective.fov : 50;
    const fovRad = (fovDeg * Math.PI) / 180;
    const padding = 1.35;
    const distance = Math.max(20, (Math.max(fitRequest.radius, 1) * padding) / Math.sin(fovRad / 2));

    const dir = camera.position.clone().sub(center);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    const toPos = center.clone().addScaledVector(dir, distance);
    startAnim(toPos, center);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  useFrame(() => {
    const anim = animRef.current;
    if (!anim) return;
    const t = Math.min(1, (performance.now() - anim.start) / anim.durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // emphasized-ish ease-out cubic
    camera.position.lerpVectors(anim.fromPos, anim.toPos, eased);
    const orbit = controls as OrbitControlsLike | undefined;
    if (orbit?.target) {
      orbit.target.lerpVectors(anim.fromTarget, anim.toTarget, eased);
      camera.lookAt(orbit.target);
    } else {
      camera.lookAt(anim.toTarget);
    }
    if (t >= 1) animRef.current = null;
    orbit?.update?.();
  });

  return null;
}
