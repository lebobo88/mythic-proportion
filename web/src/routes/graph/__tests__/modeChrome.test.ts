// Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix b --
// "give Terrain's chrome the same incoming/outgoing cross-fade participation
// the other three modes have"). Unlike Cloud/Orbital/Strata (resolved via
// `renderModeChrome`'s mode switch, one mount slot per side of the fade),
// Terrain is a SINGLE component (`TerrainSurface`) that can be either the
// incoming OR the outgoing side of a transition, never both at once (a
// transition only ever starts on an ACTUAL mode change, so incoming and
// outgoing are always different modes) -- `resolveTerrainCrossfade` is the
// pure decision of whether TerrainSurface should render at all this frame,
// and at what opacity, kept separate from Graph3DScene.tsx itself so it is
// directly unit-testable without a real WebGL context (this directory's
// established convention).
import { describe, expect, it } from "vitest";
import { resolveTerrainCrossfade } from "../three/ModeChrome";

describe("resolveTerrainCrossfade", () => {
  it("is invisible when terrain is neither the incoming nor the outgoing mode", () => {
    expect(resolveTerrainCrossfade("cloud", null, false, 1)).toEqual({ visible: false, opacity: 0 });
    expect(resolveTerrainCrossfade("cloud", "orbital", true, 0.4)).toEqual({ visible: false, opacity: 0 });
  });

  it("is fully visible/opaque when terrain is the settled (non-transitioning) current mode", () => {
    expect(resolveTerrainCrossfade("terrain", null, false, 1)).toEqual({ visible: true, opacity: 1 });
  });

  it("fades IN at the chromeAlpha weight when terrain is the INCOMING mode of an in-flight transition", () => {
    expect(resolveTerrainCrossfade("terrain", "cloud", true, 0.3)).toEqual({ visible: true, opacity: 0.3 });
  });

  it("fades OUT at (1 - chromeAlpha) when terrain is the recorded OUTGOING mode of an in-flight transition", () => {
    expect(resolveTerrainCrossfade("orbital", "terrain", true, 0.3)).toEqual({ visible: true, opacity: 0.7 });
  });

  it("does not render the outgoing side once transitioning has resolved to false, even if outgoingMode was not yet cleared", () => {
    expect(resolveTerrainCrossfade("orbital", "terrain", false, 0.3)).toEqual({ visible: false, opacity: 0 });
  });
});
