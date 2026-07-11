// Eased camera focus (deliverable 7): damped lerp toward a focus target over
// ~400-600ms using the shared `--ease-emphasized` motion token (see
// lib/motion.ts) -- collapses to an instant snap when
// `prefers-reduced-motion` is set (no animated camera moves), per
// deliverable 10.
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { getDuration, prefersReducedMotion } from "../../../lib/motion";

export interface CameraRigProps {
  /** World-space point to focus on, or null to leave the camera alone. */
  focusTarget: [number, number, number] | null;
}

export function CameraRig({ focusTarget }: CameraRigProps) {
  const { camera, controls } = useThree((state) => ({ camera: state.camera, controls: state.controls }));
  const animRef = useRef<{ from: Vector3; to: Vector3; start: number; durationMs: number } | null>(null);

  useEffect(() => {
    if (!focusTarget) return;
    const to = new Vector3(...focusTarget);
    const reduced = prefersReducedMotion();
    const durationMs = reduced ? 0 : Math.max(400, getDuration("slow") || 500);
    if (reduced) {
      camera.position.set(to.x, to.y, to.z + 6);
      camera.lookAt(to);
      return;
    }
    animRef.current = {
      from: camera.position.clone(),
      to: new Vector3(to.x, to.y, to.z + 6),
      start: performance.now(),
      durationMs,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget]);

  useFrame(() => {
    const anim = animRef.current;
    if (!anim) return;
    const t = Math.min(1, (performance.now() - anim.start) / anim.durationMs);
    // emphasized-ish ease-out cubic; keeps this file dependency-free of any CSS-easing parser
    const eased = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(anim.from, anim.to, eased);
    if (focusTarget) camera.lookAt(...focusTarget);
    if (t >= 1) animRef.current = null;
    (controls as { update?: () => void } | undefined)?.update?.();
  });

  return null;
}
