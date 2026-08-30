// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-ORBITAL: "a shell core glow"). ONE additive-blended sprite at the world
// origin -- the shared center every community's orbit ring/shell surrounds
// (see `OrbitalChrome.tsx`'s doc comment for why this is singular, not
// per-community). Static (no pulsing, per Section 5.6 item 8 / the design
// handoff's global "NO pulsing in any state" rule) -- its only per-frame
// behavior is the `THREE.Sprite`'s inherent camera-facing billboard, exactly
// like the existing Phase 2 `CommunityCentroidBadges` sprites.
import { useEffect, useRef, useState } from "react";
import { AdditiveBlending, CanvasTexture } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import { createRadialGlowCanvas } from "./chromeGlowTexture";

export interface OrbitalCoreGlowProps {
  colors: GraphColors;
  opacity?: number;
}

const CORE_GLOW_SCALE = 24;

export function OrbitalCoreGlow({ colors, opacity = 1 }: OrbitalCoreGlowProps) {
  const [texture, setTexture] = useState<CanvasTexture | null>(null);
  const lastColorRef = useRef<string | null>(null);

  useEffect(() => {
    const hex = `#${colors.orbitalChrome.coreGlowColor.color.getHexString()}`;
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
  }, [colors.orbitalChrome.coreGlowColor.color]);

  // Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, minor, J-004): see
  // `CloudNebula.tsx`'s identical fix for the full root cause -- the
  // unmount-only cleanup effect's closure captured the INITIAL (always-null)
  // `texture` state, so a real unmount never disposed the actual, later-
  // created GPU texture. `latestTextureRef` mirrors the current texture on
  // every change so the unmount effect always disposes the real resource.
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

  const resolvedOpacity = colors.orbitalChrome.coreGlowIntensity * colors.orbitalChrome.coreGlowColor.alpha * opacity;

  return (
    <sprite position={[0, 0, 0]} scale={[CORE_GLOW_SCALE, CORE_GLOW_SCALE, 1]}>
      {/* T3-advised escalation remediation (live Browser Validator finding:
          the core glow never appeared): `depthTest={false}`, exactly like
          `CloudNebula` -- without it, the origin-centered node cluster's
          depth writes fully occluded this origin-centered sprite. An
          additive glow drawing over nearby nodes is the intended halo look;
          being z-culled by them is not. */}
      <spriteMaterial
        map={texture}
        transparent
        opacity={resolvedOpacity}
        depthWrite={false}
        depthTest={false}
        blending={AdditiveBlending}
      />
    </sprite>
  );
}
