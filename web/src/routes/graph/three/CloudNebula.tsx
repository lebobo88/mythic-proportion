// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-CLOUD: "deep-field fog plus faint nebula haze over the dark --graph-bg
// baseline (haze is an enhancement with a plain-background fallback)";
// Section 5.3 Ambient policy: "Nebula: fully static, no drift ever" --
// billboard-facing the camera (a `THREE.Sprite`'s inherent behavior) is NOT
// drift/animation, it never moves relative to the camera on its own, exactly
// like the existing Phase 2 `CommunityCentroidBadges` sprites). Cloud's ONE
// piece of new Phase 5 chrome; `opacity` is the caller-supplied mode-
// transition cross-fade weight (Section 5.3 "chrome ... cross-fade").
import { useEffect, useRef, useState } from "react";
import { CanvasTexture } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import { createRadialGlowCanvas } from "./chromeGlowTexture";

export interface CloudNebulaProps {
  colors: GraphColors;
  /** Cross-fade weight (0..1) from the mode-transition envelope -- see `resolveChromeCrossfadeAlpha` in `modeTransition.ts`. Defaults to 1 (fully shown) for every caller not currently transitioning. */
  opacity?: number;
}

/** Large, static, camera-facing haze -- an enhancement layer with a plain-background fallback (no texture support -> renders nothing, per Section 5.4's "Fallback" discipline). */
const NEBULA_SPRITE_SCALE = 900;

export function CloudNebula({ colors, opacity = 1 }: CloudNebulaProps) {
  const [texture, setTexture] = useState<CanvasTexture | null>(null);
  const lastColorRef = useRef<string | null>(null);

  useEffect(() => {
    const hex = `#${colors.cloudChrome.nebulaColor.color.getHexString()}`;
    if (lastColorRef.current === hex && texture) return;
    lastColorRef.current = hex;
    const canvas = createRadialGlowCanvas(hex);
    if (!canvas) {
      setTexture(null);
      return;
    }
    const next = new CanvasTexture(canvas);
    setTexture((prev) => {
      prev?.dispose();
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors.cloudChrome.nebulaColor.color]);

  // Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, minor, J-004): the
  // unmount-only cleanup effect below runs (and its closure is captured)
  // exactly ONCE, at mount -- when `texture` is still its INITIAL `null`.
  // Disposing that closed-over `texture` variable directly would always
  // dispose nothing (a real leak on every unmount of an already-loaded
  // texture); `latestTextureRef` instead mirrors whatever the CURRENT
  // texture is on every change, so the unmount effect always disposes the
  // actual, current GPU resource.
  const latestTextureRef = useRef<CanvasTexture | null>(null);
  useEffect(() => {
    latestTextureRef.current = texture;
  }, [texture]);

  useEffect(() => {
    return () => {
      latestTextureRef.current?.dispose();
    };
  }, []);

  if (!texture) return null;

  const resolvedOpacity = colors.cloudChrome.nebulaOpacity * colors.cloudChrome.nebulaColor.alpha * opacity;

  return (
    <sprite scale={[NEBULA_SPRITE_SCALE, NEBULA_SPRITE_SCALE, 1]} renderOrder={-1}>
      <spriteMaterial map={texture} transparent opacity={resolvedOpacity} depthWrite={false} depthTest={false} />
    </sprite>
  );
}
