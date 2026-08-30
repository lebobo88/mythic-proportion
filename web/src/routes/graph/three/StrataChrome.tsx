// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-STRATA: "graded translucent floor planes per Leiden level plus an etched
// level axis with text labels ... An empty level renders no plane"). Floor
// planes/rims reuse `strataFloorLevelY`/`strataLevelsPresent`
// (`perModeChromeGeometry.ts`, itself reusing `strataLayerY` from
// `modeForces.ts`) so the chrome never disagrees with wherever the worker's
// own physics actually settles a given level's nodes. The axis is a
// dedicated child component (`StrataAxis.tsx`) using the SAME imperative
// troika `Text` pattern `NodeLabels.tsx` already established for
// community-title chips, rather than a second, differently-built label
// mechanism.
import { useMemo } from "react";
import { DoubleSide } from "three";
import type { GraphColors } from "../../../lib/graph-colors";
import { strataFloorLevelY, strataFloorRadius, strataLevelsPresent, STRATA_LEVEL_WALL_HEIGHT } from "./perModeChromeGeometry";
import { StrataAxis } from "./StrataAxis";

export interface StrataChromeProps {
  colors: GraphColors;
  /** Already visible-filtered nodes (Graph3DScene's `renderedNodes`) -- only levels with at least one member get a floor plane. */
  nodes: { level?: number }[];
  levelCount: number;
  /** Cross-fade weight (0..1) from the mode-transition envelope. Defaults to 1. */
  opacity?: number;
  /**
   * T3-advised escalation remediation: the whole-graph settle fit's
   * `[dx, dy, dz]` extent (read-only reuse of `computeBoundingSphere`'s
   * output via Graph3DScene's `graphExtent`) -- sizes the floor discs to the
   * REAL node XZ spread instead of the old fixed 200-unit constant, which
   * under-covered the cluster at scale. `null`/absent falls back to exactly
   * that prior fixed radius.
   */
  graphExtent?: [number, number, number] | null;
}

/** High segment count so the circular level wall actually traces the disc's edge smoothly, never a faceted/mismatched shape. */
const FLOOR_SEGMENTS = 64;
/** Gap between the floor discs' edge and the etched level axis, so the axis stays readable just outside whatever radius the discs resolve to. */
const AXIS_EDGE_GAP = 12;

export function StrataChrome({ colors, nodes, levelCount, opacity = 1, graphExtent = null }: StrataChromeProps) {
  const chrome = colors.strataChrome;
  const presentLevels = useMemo(() => Array.from(strataLevelsPresent(nodes)).sort((a, b) => a - b), [nodes]);
  const floorRadius = strataFloorRadius(graphExtent);

  return (
    <group>
      {presentLevels.map((level) => {
        const y = strataFloorLevelY(level, levelCount);
        return (
          <group key={level}>
            {/* A circular disc, not a square plane, specifically so the
                level wall below (a cylinder at the same radius) traces its
                boundary exactly -- a square plane paired with a circular
                wall would either clip the corners or float outside the
                edges depending on radius. */}
            {/* Opacity is the dedicated `--graph-strata-floor-opacity` token
                times the cross-fade weight ONLY -- the floor color token's
                own embedded alpha is no longer compounded on top
                (T3-advised remediation: that double attenuation collapsed
                the floors to ~5% effective opacity, the confirmed-invisible
                value). */}
            <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[floorRadius, FLOOR_SEGMENTS]} />
              <meshBasicMaterial
                color={chrome.floorColor.color}
                transparent
                opacity={chrome.floorOpacity * opacity}
                side={DoubleSide}
                depthWrite={false}
              />
            </mesh>
            {/* Level wall (T3-advised escalation remediation round 2,
                geometry-only redirect, replacing the old flat "edge-lit rim"
                annulus): the rim shared the floor disc's flat rotation --
                zero Y extent -- so it could never help edge-on visibility
                (T3 confirmed this directly). This short vertical open-ended
                cylinder at the same floorRadius presents real screen-space
                height from any near-horizontal viewing angle, making each
                present level a visible band AT its own strataFloorLevelY --
                directly reinforcing the vertical-stratification metaphor.
                No rotation: cylinderGeometry's own axis is already Y
                (vertical). Height derives from STRATA_LAYER_SPACING (see
                perModeChromeGeometry.ts for the bound reasoning); material
                keeps the rim's own token (bandRimColor) composed only with
                the cross-fade alpha -- token alpha is never recompounded
                (round 1's opacity de-compounding discipline). */}
            <mesh position={[0, y, 0]}>
              <cylinderGeometry args={[floorRadius, floorRadius, STRATA_LEVEL_WALL_HEIGHT, FLOOR_SEGMENTS, 1, true]} />
              <meshBasicMaterial
                color={chrome.bandRimColor.color}
                transparent
                opacity={chrome.bandRimColor.alpha * opacity}
                side={DoubleSide}
                depthWrite={false}
              />
            </mesh>
          </group>
        );
      })}
      <StrataAxis
        colors={colors}
        levelCount={levelCount}
        opacity={opacity}
        xOffset={-(floorRadius + AXIS_EDGE_GAP)}
      />
    </group>
  );
}
