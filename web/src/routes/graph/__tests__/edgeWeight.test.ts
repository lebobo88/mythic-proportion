// Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.1
// J5-EDGE-WEIGHT / Section 5.6 item 3): pure, shared weight -> width/opacity/
// text mapping -- ONE source of truth consumed by the fat-line edge pass
// (InstancedEdges.tsx), the reading-pane Connections list (GraphView.tsx),
// and the a11y links table's Weight column (GraphA11yTree.tsx), so those
// three surfaces can never disagree about what a given edge's weight means.
import { describe, expect, it } from "vitest";
import {
  edgeWeightFraction,
  edgeWeightToOpacity,
  edgeWeightToWidth,
  formatEdgeWeight,
} from "../edgeWeight";
import type { EdgeWeightParams } from "../../../lib/graph-colors";

const PARAMS: EdgeWeightParams = { widthMin: 1, widthMax: 4, opacityMin: 0.25, opacityMax: 0.9 };

describe("edgeWeightFraction", () => {
  it("returns null for an absent (undefined) weight -- never a fabricated number", () => {
    expect(edgeWeightFraction(undefined)).toBeNull();
  });

  it("returns null for a non-finite weight", () => {
    expect(edgeWeightFraction(Number.NaN)).toBeNull();
    expect(edgeWeightFraction(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("maps the assumed [1, 10] GraphRAG relationship-strength domain onto [0, 1]", () => {
    expect(edgeWeightFraction(1)).toBeCloseTo(0, 5);
    expect(edgeWeightFraction(10)).toBeCloseTo(1, 5);
    expect(edgeWeightFraction(5.5)).toBeCloseTo(0.5, 5);
  });

  it("clamps out-of-domain values rather than extrapolating", () => {
    expect(edgeWeightFraction(0)).toBe(0);
    expect(edgeWeightFraction(-5)).toBe(0);
    expect(edgeWeightFraction(999)).toBe(1);
  });

  it("accepts a custom domain", () => {
    expect(edgeWeightFraction(50, 0, 100)).toBeCloseTo(0.5, 5);
  });
});

describe("edgeWeightToWidth", () => {
  it("interpolates between widthMin and widthMax for a present weight", () => {
    expect(edgeWeightToWidth(0, PARAMS)).toBeCloseTo(1, 5);
    expect(edgeWeightToWidth(1, PARAMS)).toBeCloseTo(4, 5);
    expect(edgeWeightToWidth(0.5, PARAMS)).toBeCloseTo(2.5, 5);
  });

  it("falls back to the token default (widthMin) when weight is absent -- J5-EDGE-WEIGHT's explicit fallback rule", () => {
    expect(edgeWeightToWidth(null, PARAMS)).toBe(PARAMS.widthMin);
  });
});

describe("edgeWeightToOpacity", () => {
  it("interpolates between opacityMin and opacityMax for a present weight", () => {
    expect(edgeWeightToOpacity(0, PARAMS)).toBeCloseTo(0.25, 5);
    expect(edgeWeightToOpacity(1, PARAMS)).toBeCloseTo(0.9, 5);
  });

  it("falls back to opacityMin when weight is absent (mirrors the width fallback -- an absent weight is a missing signal, never treated as maximal)", () => {
    expect(edgeWeightToOpacity(null, PARAMS)).toBe(PARAMS.opacityMin);
  });
});

describe("formatEdgeWeight", () => {
  it('renders literally "weight: n/a" for an absent weight -- never a fabricated or defaulted numeric value', () => {
    expect(formatEdgeWeight(undefined)).toBe("weight: n/a");
    expect(formatEdgeWeight(Number.NaN)).toBe("weight: n/a");
  });

  it("renders the numeric weight for a present value", () => {
    expect(formatEdgeWeight(7)).toBe("weight: 7");
    expect(formatEdgeWeight(3.456)).toBe("weight: 3.46");
  });
});
