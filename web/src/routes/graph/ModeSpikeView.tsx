// Phase 4a de-risking spike (plan Section 6.3): an ISOLATED, dev-reachable
// page proving out the two riskiest bets from the passed `DESIGN_HANDOFF`
// (plan Section 5.1) before the full four-mode production build (Phase
// 4b/4c). Reachable at `#/mode-spike` (same hash-route pattern `#/design`
// already uses in App.tsx -- see `DesignPreview.tsx`), independent of the
// `Graph`/`GraphView.tsx` production tab entirely: this view owns its own
// mode-switch control, its own synthetic fixture, and its own (spike-only,
// intentionally minimal) UI chrome, so nothing here touches production
// `GraphView` state, tests, or behavior. The mode-switch RADIOGROUP control,
// full per-mode 2D/accessibility-tree parity, and the two production
// `aria-live` regions are Phase 4c's job (plan Section 6.5) -- this page's
// single `aria-live` status line exists only so a Browser Validator run can
// directly observe a mode switch actually firing, not as a claim of
// production a11y parity.
import { useEffect, useMemo, useState } from "react";
import { Color as ThreeColor } from "three";
import type { GraphColors } from "../../lib/graph-colors";
import { subscribeGraphColors } from "../../lib/graph-colors";
import { deriveVizGraph } from "./graphMath";
import { generateSyntheticGraph } from "./synthetic";
import { GRAPH_MODES, type GraphMode, type VizGraphData } from "./types";
import { Graph3DScene } from "./three/Graph3DScene";
import "./graph.css";

const DEFAULT_SPIKE_NODE_COUNT = 1500;

/** Reads the SAME `?syntheticGraph=N` param `synthetic.ts`'s production helper reads, so this spike page and the real Graph tab share one fixture-sizing convention (plan Section 6.3: "extended with synthetic community/level/centrality values ... the `?syntheticGraph=N` mechanism already in the app"). Not gated to DEV-only here -- unlike `syntheticGraphSizeFromLocation`, this spike page is ITSELF the synthetic-only surface (there is no live-backend code path to guard against), matching `#/design`'s own non-DEV-gated precedent in App.tsx. */
export function readSpikeNodeCount(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): number {
  const params = new URLSearchParams(search);
  const raw = params.get("syntheticGraph");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_SPIKE_NODE_COUNT;
}

const MODE_LABELS: Record<GraphMode, string> = {
  cloud: "Cloud",
  orbital: "Orbital Systems",
  strata: "Strata",
  terrain: "Knowledge Terrain",
};

// Used only before the first `subscribeGraphColors` callback fires -- same
// convention as GraphView.tsx's own `FALLBACK_COLORS` (kept as a separate,
// small local copy rather than importing GraphView's, so this spike page
// stays fully decoupled from production GraphView.tsx).
const FALLBACK_GRAPH_COLOR = { color: new ThreeColor(0.5, 0.5, 0.5), alpha: 1 };
const FALLBACK_COLORS: GraphColors = {
  node: {
    source: FALLBACK_GRAPH_COLOR,
    entity: FALLBACK_GRAPH_COLOR,
    concept: FALLBACK_GRAPH_COLOR,
    session: FALLBACK_GRAPH_COLOR,
  },
  edge: FALLBACK_GRAPH_COLOR,
  edgeActive: FALLBACK_GRAPH_COLOR,
  community: Array.from({ length: 8 }, () => FALLBACK_GRAPH_COLOR),
  communityAt: () => FALLBACK_GRAPH_COLOR,
  hullFill: FALLBACK_GRAPH_COLOR,
  glow: FALLBACK_GRAPH_COLOR,
};

export function ModeSpikeView() {
  const [mode, setMode] = useState<GraphMode>("cloud");
  const [colors, setColors] = useState<GraphColors | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Mode: Cloud.");

  useEffect(() => subscribeGraphColors(setColors), []);

  // Generated ONCE per mount -- the fixture itself (node count, community/
  // level/centrality assignment) does not change on a mode switch; only the
  // worker's force configuration does (see Graph3DScene's `mode` prop).
  const vizData: VizGraphData = useMemo(() => {
    const nodeCount = readSpikeNodeCount();
    const raw = generateSyntheticGraph({ nodeCount });
    return deriveVizGraph(raw);
  }, []);

  const visibleIds = useMemo(() => new Set(vizData.nodes.map((n) => n.id)), [vizData.nodes]);

  function selectMode(next: GraphMode) {
    setMode(next);
    setStatusMessage(`Mode: ${MODE_LABELS[next]}.`);
  }

  return (
    <div className="mp-graph">
      <div className="mp-graph-toolbar">
        <div role="radiogroup" aria-label="Graph mode (Phase 4a spike)" className="mp-graph-filters">
          {GRAPH_MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={mode === candidate}
              className={
                mode === candidate ? "mp-graph-filter mp-graph-filter--active" : "mp-graph-filter"
              }
              onClick={() => selectMode(candidate)}
            >
              {MODE_LABELS[candidate]}
            </button>
          ))}
        </div>
        <p className="mp-graph-hint">
          {vizData.nodes.length} synthetic nodes -- spike scaffolding, not the production mode-switch control
          (Phase 4c).
        </p>
      </div>

      <p aria-live="polite" className="mp-graph-hint">
        {statusMessage}
      </p>

      <div className="mp-graph-body">
        <div className="mp-graph-canvas-wrap">
          <Graph3DScene
            nodes={vizData.nodes}
            edges={vizData.edges}
            visibleIds={visibleIds}
            colors={colors ?? FALLBACK_COLORS}
            selectedId={selectedId}
            hoveredId={hoveredId}
            neighborIds={new Set()}
            onHoverNode={setHoveredId}
            onSelectNode={setSelectedId}
            mode={mode}
          />
        </div>
      </div>
    </div>
  );
}

export default ModeSpikeView;
