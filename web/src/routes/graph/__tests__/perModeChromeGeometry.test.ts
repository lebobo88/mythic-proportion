// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-ORBITAL/J-STRATA): pure, directly testable geometry helpers for the new
// per-mode chrome layer -- kept separate from the R3F components themselves
// (`OrbitalChrome.tsx`/`StrataChrome.tsx`) so the placement math is
// unit-testable without a real WebGL context, matching this directory's
// established convention (`terrainElevation.ts`, `modeForces.ts`).
//
// Deliberately REUSES `orbitalRadiusForNode`/`strataLayerY` from
// `modeForces.ts` rather than re-deriving the shell-radius/layer-Y formulas
// -- the chrome (rings/floor planes) must always agree with where the
// worker's own physics actually places nodes for that community/level, never
// an independently-tuned second copy of the same formula (Section 5.6's
// "single source of truth" discipline, applied here to geometry, not just
// color).
import { describe, expect, it } from "vitest";
import {
  orbitalRingRadii,
  strataFloorLevelY,
  strataLevelsPresent,
} from "../three/perModeChromeGeometry";
import { orbitalRadiusForNode, strataLayerY } from "../three/modeForces";

describe("orbitalRingRadii", () => {
  it("returns one radius per community, matching orbitalRadiusForNode's own shell formula exactly", () => {
    const radii = orbitalRingRadii(4);
    expect(radii).toHaveLength(4);
    for (let community = 0; community < 4; community++) {
      expect(radii[community]).toBe(orbitalRadiusForNode({ community }, 4));
    }
  });

  it("returns an empty array for zero/negative community counts rather than throwing", () => {
    expect(orbitalRingRadii(0)).toEqual([]);
    expect(orbitalRingRadii(-3)).toEqual([]);
  });

  it("radii strictly increase with community index (concentric, non-overlapping shells)", () => {
    const radii = orbitalRingRadii(5);
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
  });
});

describe("strataFloorLevelY", () => {
  it("matches strataLayerY's own formula exactly for every level", () => {
    for (let level = 0; level < 4; level++) {
      expect(strataFloorLevelY(level, 4)).toBe(strataLayerY({ level }, 4));
    }
  });
});

describe("strataLevelsPresent", () => {
  it("returns the distinct set of levels actually present among the given nodes -- an empty level renders no plane", () => {
    const nodes = [{ id: "a", level: 0 }, { id: "b", level: 2 }, { id: "c", level: 2 }];
    const levels = strataLevelsPresent(nodes);
    expect(Array.from(levels).sort()).toEqual([0, 2]);
  });

  it("treats a missing level field as level 0", () => {
    const nodes: { id: string; level?: number }[] = [{ id: "a" }];
    expect(Array.from(strataLevelsPresent(nodes))).toEqual([0]);
  });

  it("returns an empty set for no nodes", () => {
    expect(strataLevelsPresent([]).size).toBe(0);
  });
});
