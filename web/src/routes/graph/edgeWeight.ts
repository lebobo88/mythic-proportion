// Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.1
// J5-EDGE-WEIGHT / Section 5.6 item 3): pure, shared weight -> width/opacity/
// text mapping, consumed by the fat-line edge pass (InstancedEdges.tsx), the
// reading-pane Connections list (GraphView.tsx), and the a11y links table's
// Weight column (GraphA11yTree.tsx) -- ONE mapping so the three surfaces can
// never disagree about what a given edge's weight means.
import type { EdgeWeightParams } from "../../lib/graph-colors";

// The plan (Section 5.2/5.6 item 3) specifies WHICH tokens width/opacity
// interpolate between, but not the input weight domain -- `edge.weight` is a
// plain optional server float (`VizEdge`/`GraphEdge`, api.ts), not a
// pre-normalized 0..1 value. GraphRAG's own relationship-strength convention
// (see `mythic_proportion/graph/tuples.py`'s extraction prompt: "<STRENGTH
// 1-10>", and `graph/store.py`'s MAX-aggregation of duplicate relationship
// weights) is the assumed domain -- a labeled engineering judgment call
// (plan Section 13 precedent: "settle during engineering ... labeled, never
// fabricated"), not a value the plan itself asserts. A stray out-of-domain
// value clamps rather than extrapolates, so it can never invert the ramp.
export const EDGE_WEIGHT_DOMAIN_MIN = 1;
export const EDGE_WEIGHT_DOMAIN_MAX = 10;

/**
 * `null` for an absent/non-finite weight -- the caller renders the literal
 * `"weight: n/a"` fallback (`formatEdgeWeight` below), never a fabricated
 * number, per J5-EDGE-WEIGHT. Otherwise a `[0, 1]` fraction, clamped (never
 * extrapolated) to the given domain.
 */
export function edgeWeightFraction(
  weight: number | undefined,
  domainMin: number = EDGE_WEIGHT_DOMAIN_MIN,
  domainMax: number = EDGE_WEIGHT_DOMAIN_MAX,
): number | null {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return null;
  if (domainMax <= domainMin) return 0;
  const t = (weight - domainMin) / (domainMax - domainMin);
  return Math.min(1, Math.max(0, t));
}

/**
 * Width falls back to the token default (`widthMin`) when weight is absent
 * -- J5-EDGE-WEIGHT's explicit fallback rule ("width falls back to the token
 * default").
 */
export function edgeWeightToWidth(fraction: number | null, params: EdgeWeightParams): number {
  if (fraction === null) return params.widthMin;
  return params.widthMin + fraction * (params.widthMax - params.widthMin);
}

/**
 * Opacity has no explicit fallback rule stated in the plan; this mirrors the
 * width fallback (the token MIN, never the max) for the same reason -- an
 * absent weight is a missing signal, never treated as a maximal
 * (fabricated-strong) one. Labeled engineering judgment (plan Section 13
 * precedent), symmetrical with `edgeWeightToWidth` above.
 */
export function edgeWeightToOpacity(fraction: number | null, params: EdgeWeightParams): number {
  if (fraction === null) return params.opacityMin;
  return params.opacityMin + fraction * (params.opacityMax - params.opacityMin);
}

/**
 * The single "weight: n/a" fallback text -- shared verbatim by the
 * Connections list and the a11y Weight column so they can never disagree
 * (J5-EDGE-WEIGHT: "Absent weight renders 'weight: n/a', never a fabricated
 * number").
 */
export function formatEdgeWeight(weight: number | undefined): string {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return "weight: n/a";
  // GraphRAG relationship-strength weights are typically integer-ish (1-10)
  // but the server type is a plain float -- round to 2 decimal places for a
  // stable, tabular-friendly display rather than assuming an integer.
  const rounded = Math.round(weight * 100) / 100;
  return `weight: ${rounded}`;
}
