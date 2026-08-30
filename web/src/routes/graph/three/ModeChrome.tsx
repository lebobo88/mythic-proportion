// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-CLOUD/J-ORBITAL/J-STRATA/J-TERRAIN "atmosphere" chrome layers). A single
// resolver so `Graph3DScene.tsx` mounts exactly one chrome component per
// mode (never four unconditional mounts) -- the SAME "one small switch,
// reused for both the incoming and outgoing side of a cross-fade" shape
// `GraphA11yTree.tsx`'s own per-mode `mode === "orbital" ? ... : ...` switch
// already established for a11y parity, applied here to the 3D chrome layer.
// Terrain's chrome (hillshade/contour/sky) already lives inside
// `TerrainSurface.tsx` itself (this phase's Section 5.6 item 5 risk-mode),
// so it is intentionally NOT re-resolved here -- Graph3DScene mounts
// `<TerrainSurface colors={colors} .../>` directly, unconditionally, exactly
// as it did before this phase (only now with `colors` threaded through).
import type { GraphColors } from "../../../lib/graph-colors";
import type { GraphMode, VizNode } from "../types";
import { CloudNebula } from "./CloudNebula";
import { OrbitalChrome } from "./OrbitalChrome";
import { StrataChrome } from "./StrataChrome";

export interface ModeChromeProps {
  mode: GraphMode;
  colors: GraphColors;
  opacity: number;
  /** Already visible-filtered nodes (Graph3DScene's `renderedNodes`) -- Strata's floor-plane chrome needs them to know which levels are present. (Orbital no longer consumes them: round 7's band grouping replaced round 3's visible-member-ranked ring cap.) */
  nodes: VizNode[];
  communityCount: number;
  levelCount: number;
  /**
   * T3-advised escalation remediation: the whole-graph settle fit's
   * `[dx, dy, dz]` extent (Graph3DScene's `graphExtent` -- read-only reuse
   * of `computeBoundingSphere`'s output), consumed only by Strata's
   * floor-disc sizing (`strataFloorRadius`). `null` before the first settle.
   */
  graphExtent: [number, number, number] | null;
}

/** Terrain renders no separate chrome element here -- see this file's header comment. */
export function renderModeChrome({ mode, colors, opacity, nodes, communityCount, levelCount, graphExtent }: ModeChromeProps) {
  if (mode === "cloud") return <CloudNebula colors={colors} opacity={opacity} />;
  if (mode === "orbital") return <OrbitalChrome colors={colors} communityCount={communityCount} opacity={opacity} />;
  if (mode === "strata")
    return (
      <StrataChrome
        colors={colors}
        nodes={nodes}
        levelCount={levelCount}
        opacity={opacity}
        graphExtent={graphExtent}
      />
    );
  return null;
}

/**
 * Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix b):
 * Terrain is a single component (`TerrainSurface`), not a per-mode chrome
 * layer resolved by `renderModeChrome` above -- but it still needs the SAME
 * incoming/outgoing cross-fade participation Cloud/Orbital/Strata already
 * have (Section 5.3: "outgoing chrome fades down, incoming fades up",
 * applying to every mode, no per-mode exception per Section 6 Phase 5).
 * Pure, directly testable: since a transition only ever starts on an ACTUAL
 * mode change (`Graph3DScene.tsx`'s mode-change effect bails out early
 * otherwise), `mode` and `outgoingMode` can never both be `"terrain"`
 * simultaneously -- so Terrain only ever needs ONE render slot, chosen by
 * whether it is the incoming or the outgoing side (or neither).
 */
export function resolveTerrainCrossfade(
  mode: GraphMode,
  outgoingMode: GraphMode | null,
  transitioning: boolean,
  chromeAlpha: number,
): { visible: boolean; opacity: number } {
  if (mode === "terrain") {
    return { visible: true, opacity: chromeAlpha };
  }
  if (transitioning && outgoingMode === "terrain") {
    return { visible: true, opacity: 1 - chromeAlpha };
  }
  return { visible: false, opacity: 0 };
}
