// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-ORBITAL: "an ecliptic disc, orbit rings, and a shell core glow (rings
// static under reduced motion)"). Section 5.7 permitted variation: "Orbital
// ring ambient rotation ships disabled" -- every element here is a STATIC
// mesh, never animated per-frame. `communityCount` drives up to
// ORBITAL_SHELL_BAND_COUNT ring/wall pairs via `orbitalShellBands`
// (round-7 escalation remediation, an explicit USER DESIGN DECISION:
// nearby communities are GROUPED into a small number of legibly thick
// visual bands instead of one imperceptibly thin ring per community -- see
// perModeChromeGeometry.ts / orbitalShellBanding.test.ts; per-community
// identity stays fully carried by node color/pattern, the
// CommunityCentroidBadges layer, labels, aria, and the a11y tree, plan
// Section 5.8), which itself derives its ladder envelope from
// `orbitalRingRadii`/`orbitalRadiusForNode` in `modeForces.ts` so the
// chrome never disagrees with the extent the worker's own physics settles
// the shells across. "A shell core
// glow" (singular) is read as ONE glow at the shared origin every shell
// orbits around -- the already-existing Phase 2 `CommunityCentroidBadges`
// layer is what carries PER-COMMUNITY identity ("a centroid badge at each
// system core" in the same journey sentence describes that separate,
// already-shipped feature, not a second per-community glow this phase would
// otherwise duplicate).
import { useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { DoubleSide } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import {
  ORBITAL_RING_MIN_PX,
  ORBITAL_WALL_MIN_PX,
  orbitalOutermostShellRadius,
  orbitalRingTubeRadius,
  orbitalShellBands,
  orbitalShellWallHeight,
} from "./perModeChromeGeometry";
// Round-6 escalation remediation: the px->world screen-space conversion and
// its >=10% refresh hysteresis are REUSED from the label system's own
// Phase 2 / label-smear-remediation machinery -- never a second,
// independently-derived formula (Section 5.6 single-source discipline).
import { computeScreenSpaceWorldSize, shouldRefreshLabelFontSize } from "./NodeLabels";
import { OrbitalCoreGlow } from "./OrbitalCoreGlow";

export interface OrbitalChromeProps {
  colors: GraphColors;
  communityCount: number;
  /** Cross-fade weight (0..1) from the mode-transition envelope. Defaults to 1. */
  opacity?: number;
}

const DISC_INNER_RADIUS = 12;
const DISC_OUTER_PADDING = 40;

export function OrbitalChrome({ colors, communityCount, opacity = 1 }: OrbitalChromeProps) {
  const chrome = colors.orbitalChrome;
  const camera = useThree((state) => state.camera);
  const viewportHeight = useThree((state) => state.size.height);

  // Round-6 escalation remediation (live runtime diagnostic: rings/walls
  // were world-space-correct but SUB-PIXEL at the real settle-fit framing,
  // ~1496 units from the origin at fov 75 / ~674px viewport -> ~3.41 world
  // units per pixel). Track the camera's distance to the chrome's own
  // anchor (the world origin every shell is centered on) per frame,
  // refs-only, committing to state ONLY on a material (>=10%) change --
  // the exact hysteresis gate the label font floor uses. A once-at-mount
  // sample would be WRONG, not merely simpler: this component mounts before
  // the settle-fit camera animation finishes, so it would freeze the
  // PRE-fit distance -- the same staleness failure mode the label-smear
  // remediation already diagnosed for the font floor (see
  // `shouldRefreshLabelFontSize`'s doc comment in NodeLabels.tsx). Steady
  // state performs zero setState; during a camera move the gated re-renders
  // are cheap because at compressed spacing the derived sizes saturate at
  // the anti-fusion ceilings almost immediately, so the geometry args stop
  // changing and R3F's arg diffing skips the rebuilds.
  const framingDistanceRef = useRef(0);
  const [framingDistance, setFramingDistance] = useState(() => {
    framingDistanceRef.current = camera.position.length();
    return framingDistanceRef.current;
  });
  useFrame(() => {
    const next = camera.position.length();
    if (shouldRefreshLabelFontSize(framingDistanceRef.current, next)) {
      framingDistanceRef.current = next;
      setFramingDistance(next);
    }
  });
  const perspective = camera as unknown as { fov?: number; isPerspectiveCamera?: boolean };
  const fovDeg = perspective.isPerspectiveCamera && perspective.fov ? perspective.fov : 50;
  // Screen-space legibility floors (world units) for the tube DIAMETER and
  // wall HEIGHT -- the established Phase 2 px->world conversion, fed the
  // tracked framing distance. Floors only: up close they fall below the
  // token-scaled base sizes and change nothing; far out they are bounded by
  // the anti-fusion spacing ceilings inside the pure helpers.
  const minTubeDiameter = computeScreenSpaceWorldSize(framingDistance, fovDeg, viewportHeight, ORBITAL_RING_MIN_PX);
  const minWallHeight = computeScreenSpaceWorldSize(framingDistance, fovDeg, viewportHeight, ORBITAL_WALL_MIN_PX);
  // Banded shell list (round 7 -- the user-approved grouping design; at most
  // ORBITAL_SHELL_BAND_COUNT ring/wall pairs, which also subsumes round 3's
  // O(tens) chrome-budget cap; see orbitalShellBanding.test.ts).
  const bands = useMemo(() => orbitalShellBands(communityCount), [communityCount]);
  const inclinationRad = (chrome.ringInclinationDeg * Math.PI) / 180;
  // FULL physics extent, NOT a band subset: grouped communities' nodes
  // still orbit at their own per-community radii, so the disc must still
  // reach them and the tube thickness must still scale with the real
  // framing distance (round 7 changes only ring/wall COUNT and thickness,
  // never the disc's reach).
  const outermostShellRadius = orbitalOutermostShellRadius(communityCount) ?? DISC_INNER_RADIUS;
  const outerRadius = outermostShellRadius + DISC_OUTER_PADDING;
  // T3-advised escalation remediation (live Browser Validator finding: rings
  // invisible): tube thickness scales with the shell system's own size via
  // the pure, unit-tested `orbitalRingTubeRadius` -- the old fixed
  // `ringWidth * 0.15` (= 0.225 world units) sat far below one physical
  // pixel at the settle-fit framing distance real shell systems produce.
  // Round 5: the helper takes communityCount and derives the outermost
  // radius AND the effective inter-element gap itself (tube diameter is
  // capped at gap / 2 so adjacent rings never fuse -- since round 7 the gap
  // is the inter-BAND gap, see orbitalShellBanding.test.ts); this call site
  // can no longer feed it a radius that drifts from that gap. Round 6 adds
  // the screen-space legibility floor (see
  // orbitalChromeScreenSpaceLegibility.test.ts), which at the real fixture
  // scale now BINDS under the widened band-gap ceiling.
  const tubeRadius = orbitalRingTubeRadius(chrome.ringWidth, communityCount, minTubeDiameter);
  // Round-4 escalation remediation: wall height follows the EFFECTIVE shell
  // spacing (compressed at high community counts so the whole system stays
  // camera-frameable) -- identical to the old ORBITAL_SHELL_WALL_HEIGHT (15)
  // wherever spacing is uncompressed. Round 6: screen-space floor, bounded
  // by the spacing / 2 anti-mass ceiling. See perModeChromeGeometry.ts.
  const wallHeight = orbitalShellWallHeight(communityCount, minWallHeight);

  return (
    <group>
      {/* Ecliptic disc: a flat, mostly-transparent annulus in the XZ plane.
          Opacity is the dedicated `--graph-orbital-disc-opacity` token times
          the cross-fade weight ONLY -- the disc color token's own embedded
          alpha is no longer compounded on top (T3-advised remediation: that
          double attenuation collapsed the disc to ~7% effective opacity,
          the confirmed-invisible value). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
        <ringGeometry args={[DISC_INNER_RADIUS, outerRadius, 64]} />
        <meshBasicMaterial
          color={chrome.discColor.color}
          transparent
          opacity={chrome.discOpacity * opacity}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Orbit rings: one per shell BAND (round 7 -- grouped communities,
          at most ORBITAL_SHELL_BAND_COUNT, each legibly thick), static
          (Section 5.7: rotation ships disabled), tilted by the inclination
          token. Keyed by band identity. */}
      {bands.map(({ band, radius }) => (
        <mesh key={band} rotation={[Math.PI / 2 + inclinationRad, 0, 0]}>
          <torusGeometry args={[radius, tubeRadius, 8, 96]} />
          <meshBasicMaterial
            color={chrome.ringColor.color}
            transparent
            opacity={chrome.ringColor.alpha * opacity}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* Shell walls (T3-advised escalation remediation round 2, geometry-only
          redirect; per shell BAND since round 7): a short vertical open-ended
          cylinder at each band's radius, giving the shell system genuine
          Y-axis presence so it is
          visible from the DEFAULT unmodified camera framing -- the flat disc
          and rings above stay as-is for the from-above reading, but being
          Y-normal they project to (near-)zero screen area viewed edge-on,
          which is exactly the default first-load viewing angle. No rotation:
          cylinderGeometry's own axis is already Y (vertical). Height derives
          from ORBITAL_SHELL_SPACING (see perModeChromeGeometry.ts for the
          bound reasoning); color is the shell's identity token (ringColor)
          at the family's SURFACE-opacity token (discOpacity -- a wall is a
          large translucent surface like the disc, not a thin line like the
          ring, and 0.18 keeps nested walls airy where the ring's own 0.6
          alpha would stack into a heavy mass), composed only with the
          cross-fade alpha -- token alpha is never recompounded with itself
          (round 1's opacity de-compounding discipline). */}
      {bands.map(({ band, radius }) => (
        <mesh key={`wall-${band}`}>
          <cylinderGeometry args={[radius, radius, wallHeight, 96, 1, true]} />
          <meshBasicMaterial
            color={chrome.ringColor.color}
            transparent
            opacity={chrome.discOpacity * opacity}
            side={DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}

      <OrbitalCoreGlow colors={colors} opacity={opacity} />
    </group>
  );
}
