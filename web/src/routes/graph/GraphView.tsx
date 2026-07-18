import { useCallback, useEffect, useMemo, useState } from "react";
import { Color as ThreeColor } from "three";
import { fetchGraph, fetchPage, type GraphData, type PageDetail } from "../../lib/api";
import { subscribeGraphColors, type GraphColors } from "../../lib/graph-colors";
import { consumePendingGraphFocus, subscribeGraphFocus } from "../../lib/graphFocusBus";
import { prefersReducedMotion } from "../../lib/motion";
import { supportsWebGL } from "../../lib/webgl";
import { deriveVizGraph, neighborsOf } from "./graphMath";
import {
  emptyFilterState,
  GRAPH_MODES,
  nodeVisible,
  type FilterState,
  type GraphMode,
  type VizGraphData,
} from "./types";
import { generateSyntheticGraph, syntheticGraphSizeFromLocation } from "./synthetic";
import { Graph2DFallback } from "./Graph2DFallback";
import { Graph2DModeFallback } from "./Graph2DModeFallback";
import { CommunityBadge } from "./CommunityBadge";
import { Graph3DScene } from "./three/Graph3DScene";
import { GraphA11yTree } from "./a11y/GraphA11yTree";
import "./graph.css";

// Issue 3a (BLOCKING, live-Chrome context-loss finding): the DEFAULT initial
// render must be a bounded subset, not the full 10k/50k-node dataset --
// pushing everything to the GPU at once is what tripped
// `THREE.WebGLRenderer: Context Lost.` at 10k nodes. 1500 sits inside the
// requested ~1000-2000 top-degree-node range: comfortably interactive with
// the LOD/instancing/culling budget in InstancedNodes.tsx + InstancedEdges.tsx,
// while still showing a meaningfully large hub neighborhood by default.
// Selecting a node expands ITS neighbors into view too (see `selectNode`
// below), so exploring beyond the cap is always one click away.
const PROGRESSIVE_DISCLOSURE_CAP = 1500;

// Phase 4c (plan Section 6.5, item 2): the production mode-switch labels --
// kept as its own small local copy rather than importing the Phase 4a
// spike's `ModeSpikeView.tsx` version, matching that file's own documented
// reasoning for staying fully decoupled from production `GraphView.tsx`.
const MODE_LABELS: Record<GraphMode, string> = {
  cloud: "Cloud",
  orbital: "Orbital Systems",
  strata: "Strata",
  terrain: "Knowledge Terrain",
};

// Graph view: consumes GET /api/graph?mode=both (Phase 3 page + GraphRAG
// entity/relationship data), rendered either as the Phase 5 3D WebGL scene
// (default) or the REQUIRED 2D canvas fallback, styled entirely from the
// `--graph-*` tokens. Both render modes, the filter/progressive-disclosure
// state, the docked reading pane, and the a11y parallel DOM are all owned
// here so 2D<->3D toggling never loses selection/filter/hover state.
export function GraphView({
  onOpenPage,
  onGoToIngest,
  visible = true,
}: {
  onOpenPage: (path: string) => void;
  /**
   * Phase 4b empty-graph-state fix (plan Section 6.4, item 4): navigates to
   * the Ingest view. Optional so this component still renders standalone
   * (tests, the mode-spike route) without a real navigation callback -- the
   * empty-state message still names `mythic index-graph` even when this is
   * omitted, it just has nothing to call on click.
   */
  onGoToIngest?: () => void;
  /**
   * Phase 4c graph state-lifecycle fix (plan Section 3.3/6.5): `App.tsx`
   * keeps this component mounted-hidden (never unmounted) once the Graph tab
   * has been visited, so worker/physics state, selection, filters, mode, and
   * camera intent all survive a tab excursion. `visible` (default `true`, so
   * every other caller -- tests, a future standalone embed -- keeps working
   * unchanged) tells the 3D scene to pause its render loop while hidden
   * (Section 11's risk-table mitigation against "a background canvas
   * continuing to burn frames while hidden") without tearing down the
   * worker or losing any state.
   */
  visible?: boolean;
}) {
  const [rawData, setRawData] = useState<GraphData>({ nodes: [], edges: [] });
  // Distinguishes "haven't heard back from the initial fetch yet" from "a
  // fetch resolved with a genuinely empty graph" -- both states start with
  // the same `{nodes: [], edges: []}` `rawData`, but only the latter should
  // ever show the empty-state message below (Phase 4b, plan Section 6.4).
  const [loaded, setLoaded] = useState(false);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  // T2 remediation (Finding 2): a DEDICATED state for the genuine-WebGL-
  // context-loss announcement, kept separate from `statusHint` above (fetch
  // failure / synthetic-graph size / empty-state naming) for two reasons:
  // (1) it needs its own `role="status"` region so it's actually announced
  // to assistive tech (Finding 2b), matching the plan's "WebGL context loss
  // triggers auto-2D plus an announcement" requirement (Section 9.3 journey
  // 3), which a plain, non-live `statusHint` paragraph never satisfied; (2)
  // it needs to be reliably clearable once 3D successfully re-renders
  // (Finding 2c, below) without risking clobbering an unrelated `statusHint`
  // message that happens to be showing at the same time.
  const [contextLostMessage, setContextLostMessage] = useState<string | null>(null);
  // Graceful-degradation floor (REQUIRED, deliverable 9 / reflexion critique
  // item 4): auto-detect at mount (no WebGL support at all) in addition to
  // the reduced-motion preference; a LIVE context loss is caught separately
  // via Graph3DScene's onContextLost below, both landing on the same 2D path.
  const webglAvailable = useMemo(() => supportsWebGL(), []);
  const [mode3D, setMode3D] = useState<boolean>(() => webglAvailable && !prefersReducedMotion());
  const [colors, setColors] = useState<GraphColors | null>(null);
  // Phase 4c (plan Section 6.5, items 1-2): the active graph representation.
  // Lives here (not inside Graph3DScene) so it -- like selection, filters,
  // and expanded-node state -- survives the graph state-lifecycle fix's
  // mounted-hidden persistence across tab excursions (Section 9.3 journey 8).
  //
  // LABELED OPEN DECISION (plan Section 5.3, acceptable to leave open at
  // Phase 4 engineering time): "the exact Leiden hierarchy level depth
  // exposed in Strata mode." This implementation stacks EVERY available
  // hierarchy level simultaneously (`modeForces.ts`'s `strataLayerY`, keyed
  // by each node's own `level` across the full `levelCount` the worker
  // computes from the dataset) rather than adding a separate single-level
  // "active hierarchy level" selector control. This is a real, working
  // Strata mode with real Leiden level data -- not a fabricated value -- but
  // it is a deliberate, labeled simplification: no per-level filter/drill-
  // down control exists yet. A future job can add one without changing this
  // state's shape.
  const [mode, setMode] = useState<GraphMode>("cloud");
  const [modeAnnouncement, setModeAnnouncement] = useState(`Mode: ${MODE_LABELS.cloud}.`);
  const [filter, setFilter] = useState<FilterState>(emptyFilterState());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [readingPage, setReadingPage] = useState<PageDetail | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const syntheticSize = syntheticGraphSizeFromLocation();
    const load = syntheticSize
      ? Promise.resolve(generateSyntheticGraph({ nodeCount: syntheticSize }))
      : fetchGraph("both");

    load
      .then((data) => {
        if (cancelled) return;
        setRawData(data);
        setLoaded(true);
        setStatusHint(syntheticSize ? `Synthetic graph: ${syntheticSize} nodes.` : null);
      })
      .catch(() => {
        if (!cancelled) setStatusHint("Couldn't load the graph -- retry from the Graph tab.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const vizData: VizGraphData = useMemo(() => deriveVizGraph(rawData), [rawData]);

  // Phase 4c (plan Section 6.5 item 5): size the generative community ramp
  // to the ACTUAL distinct community count in the current dataset, not a
  // fixed 8 -- so hue spacing stays even at 16, 32, or whatever a real
  // vault's Leiden clustering produces (see readGraphColors's doc comment).
  // Computed off `vizData` (the FULL derived dataset), never off
  // `visibleIds` -- filtering/progressive-disclosure must never reshuffle
  // which color a given community renders as ("encoding invariance",
  // Section 5.1's unifying thesis).
  const communityCount = useMemo(() => {
    const distinct = new Set(vizData.nodes.map((n) => n.community));
    return Math.max(1, distinct.size);
  }, [vizData.nodes]);

  useEffect(
    () => subscribeGraphColors(setColors, document.documentElement, communityCount),
    [communityCount],
  );

  const availableTypes = useMemo(
    () => Array.from(new Set(vizData.nodes.map((n) => n.type))).sort(),
    [vizData.nodes],
  );

  // Progressive disclosure: start with the top-degree N nodes, expand a
  // node's neighbors into view on selection (deliverable 8).
  const baseVisibleIds = useMemo(() => {
    const sorted = [...vizData.nodes].sort((a, b) => b.degree! - a.degree!);
    const top = sorted.slice(0, PROGRESSIVE_DISCLOSURE_CAP).map((n) => n.id);
    return new Set([...top, ...expandedIds]);
  }, [vizData.nodes, expandedIds]);

  const visibleIds = useMemo(() => {
    const out = new Set<string>();
    for (const node of vizData.nodes) {
      if (!baseVisibleIds.has(node.id)) continue;
      if (!nodeVisible(node, filter)) continue;
      out.add(node.id);
    }
    return out;
  }, [vizData.nodes, baseVisibleIds, filter]);

  const neighborIds = useMemo(
    () => (hoveredId || selectedId ? neighborsOf(rawData, (hoveredId ?? selectedId)!) : new Set<string>()),
    [rawData, hoveredId, selectedId],
  );

  // Progressive disclosure "expand on demand" (Issue 3a): selecting a node
  // reveals that node's 1-hop neighbors too, not just the node itself --
  // otherwise a selected node picked from outside the top-degree cap would
  // render with all its edges dangling to invisible endpoints.
  const selectNode = useCallback(
    (id: string) => {
      setSelectedId(id);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        for (const neighborId of neighborsOf(rawData, id)) next.add(neighborId);
        return next;
      });
    },
    [rawData],
  );

  // Cmd+K "jump to node" (deliverable 7) -- drains a pending request on
  // mount (palette fires before this view exists) and stays subscribed for
  // repeat jumps while already on the Graph tab.
  useEffect(() => {
    const pending = consumePendingGraphFocus();
    if (pending) selectNode(pending);
    return subscribeGraphFocus(selectNode);
  }, [selectNode]);

  useEffect(() => {
    if (!selectedId) {
      setReadingPage(null);
      setReadingError(null);
      return;
    }
    if (selectedId.startsWith("entity:")) {
      setReadingPage(null);
      setReadingError(null);
      return;
    }
    let cancelled = false;
    fetchPage(selectedId)
      .then((page) => {
        if (!cancelled) {
          setReadingPage(page);
          setReadingError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setReadingError("Couldn't load that page.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selectedNode = selectedId ? vizData.nodes.find((n) => n.id === selectedId) : null;

  // Empty-graph state (Phase 4b, plan Section 6.4, item 4 -- a real UX gap
  // identified by the plan's investigation): a fresh vault or one that has
  // never run `mythic index-graph` returns zero nodes, and until this fix
  // the graph canvas just rendered blank with no explanation. Gated on
  // `loaded` (see that state's own comment) so this never flashes during
  // the initial fetch, and on `!statusHint` so it never fights with the
  // separate fetch-failure/synthetic-graph hint above.
  const isEmpty = loaded && !statusHint && vizData.nodes.length === 0;

  // T2 remediation (Finding 2a): this fires ONLY on a genuine WebGL context
  // loss now -- `Graph3DScene`'s own `onContextLost` wiring distinguishes
  // that from the manual 2D/3D toggle's unmount-triggered dispose (see
  // `isGenuineContextLoss`'s doc comment in Graph3DScene.tsx for the root
  // cause and evidence). The manual toggle's `onClick` below calls
  // `setMode3D` directly and never touches this handler or
  // `contextLostMessage` at all.
  const handleContextLost = useCallback(() => {
    setMode3D(false);
    setContextLostMessage("3D rendering became unavailable -- switched to the 2D fallback.");
  }, []);

  // T2 remediation (Finding 2c): clears a stale context-loss announcement
  // once 3D has actually successfully re-rendered (a fresh WebGL context
  // was created) -- fires on every `Graph3DScene` mount, including the
  // user's own "Switch to 3D" retry after a fallback, so the message never
  // stays stuck on screen after 3D is working again. A no-op (clearing an
  // already-null message) on every other mount, including the very first.
  const handleGraphReady = useCallback(() => {
    setContextLostMessage(null);
  }, []);

  function toggleTypeFilter(type: string) {
    setFilter((prev) => {
      const types = new Set(prev.types);
      if (types.has(type)) types.delete(type);
      else types.add(type);
      return { ...prev, types };
    });
  }

  // Phase 4c (plan Section 6.5, item 2): the mode-switch radiogroup control.
  // Selection/filters/expanded-node state are untouched by a mode change --
  // only the worker's force configuration (and, in 3D, the bounded M1
  // transition between them) reacts to `mode`.
  function selectMode(next: GraphMode) {
    setMode(next);
    setModeAnnouncement(`Mode: ${MODE_LABELS[next]}.`);
  }

  return (
    <div className="mp-graph">
      <div className="mp-graph-toolbar">
        <button
          type="button"
          onClick={() => setMode3D((v) => !v)}
          aria-pressed={mode3D}
          disabled={!mode3D && !webglAvailable}
          title={!webglAvailable ? "WebGL isn't available in this browser -- 3D mode is disabled." : undefined}
        >
          {mode3D ? "Switch to 2D" : "Switch to 3D"}
        </button>
        <div role="radiogroup" aria-label="Graph mode" className="mp-graph-filters">
          {GRAPH_MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={mode === candidate}
              className={mode === candidate ? "mp-graph-filter mp-graph-filter--active" : "mp-graph-filter"}
              onClick={() => selectMode(candidate)}
            >
              {MODE_LABELS[candidate]}
            </button>
          ))}
        </div>
        <div className="mp-graph-filters" role="group" aria-label="Filter by type">
          {availableTypes.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={filter.types.has(type)}
              className={filter.types.has(type) ? "mp-graph-filter mp-graph-filter--active" : "mp-graph-filter"}
              onClick={() => toggleTypeFilter(type)}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {/* Phase 4c (plan Section 6.5, item 7): the first of two aria-live
          regions -- mode-change announcements. The second (selection/state)
          lives in GraphA11yTree, rendered unconditionally below regardless
          of 2D/3D mode. */}
      <p aria-live="polite" className="mp-visually-hidden">
        {modeAnnouncement}
      </p>

      {statusHint ? <p className="mp-graph-hint">{statusHint}</p> : null}

      {/* T2 remediation (Finding 2b): `role="status"` gives this region an
          implicit `aria-live="polite"` + `aria-atomic="true"` (same
          convention as the empty-state message below), so a genuine WebGL
          context loss is now actually announced to assistive tech, matching
          the plan's "WebGL context loss triggers auto-2D plus an
          announcement" requirement (Section 9.3 journey 3). Visible (unlike
          the mode-announcement region above) -- this is the SAME
          user-facing message sighted users already saw before this fix, now
          also announced. Rendered unconditionally (not
          `{contextLostMessage ? ... : null}`) so the live region itself is
          already present in the accessibility tree BEFORE the message ever
          changes -- a region only inserted at the moment content appears is
          not reliably announced by every screen reader, the same reason the
          `mp-visually-hidden` region above stays permanently mounted. Empty
          when there is nothing to announce, so it renders no visible text
          and no extra layout weight in the common case. */}
      <p role="status" className={contextLostMessage ? "mp-graph-hint" : "mp-graph-hint mp-visually-hidden"}>
        {contextLostMessage ?? ""}
      </p>

      <div className="mp-graph-body">
        <div className="mp-graph-canvas-wrap">
          {isEmpty ? (
            <div className="mp-graph-empty" role="status">
              <p>No knowledge graph yet.</p>
              <p>
                This view needs a knowledge graph built from your vault. Run{" "}
                <code>mythic index-graph</code> from the CLI, or start it from the{" "}
                {onGoToIngest ? (
                  <button type="button" className="mp-graph-empty-link" onClick={onGoToIngest}>
                    Ingest
                  </button>
                ) : (
                  "Ingest"
                )}{" "}
                view.
              </p>
            </div>
          ) : mode3D ? (
            <Graph3DScene
              nodes={vizData.nodes}
              edges={vizData.edges}
              visibleIds={visibleIds}
              colors={colors ?? FALLBACK_COLORS}
              selectedId={selectedId}
              hoveredId={hoveredId}
              neighborIds={neighborIds}
              onHoverNode={setHoveredId}
              onSelectNode={selectNode}
              onContextLost={handleContextLost}
              onReady={handleGraphReady}
              mode={mode}
              paused={!visible}
            />
          ) : mode === "cloud" ? (
            <Graph2DFallback
              nodes={vizData.nodes}
              edges={vizData.edges}
              visibleIds={visibleIds}
              colors={colors}
              selectedId={selectedId}
              hoveredId={hoveredId}
              onHoverNode={setHoveredId}
              onSelectNode={selectNode}
            />
          ) : (
            // Phase 4c (plan Section 6.5 item 6): Orbital/Strata/Terrain's
            // own 2D fallback -- structural (nested clusters / hierarchy /
            // region list), NOT the Cloud force-directed canvas. Filtered
            // to `visibleIds` exactly like Graph3DScene/Graph2DFallback
            // above, so progressive disclosure/type filters apply the same
            // way regardless of render mode.
            <Graph2DModeFallback
              mode={mode}
              nodes={vizData.nodes.filter((n) => visibleIds.has(n.id))}
              // VERIFICATION_NEEDS_FIX (major) remediation: Strata's links
              // table needs real edge data -- filtered to both endpoints
              // visible, matching the same convention `Graph2DFallback`/
              // `GraphA11yTree`'s own links tables already use.
              edges={vizData.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))}
              colors={colors ?? FALLBACK_COLORS}
              selectedId={selectedId}
              onSelectNode={selectNode}
            />
          )}
        </div>

        {selectedNode ? (
          <aside className="mp-graph-reading-pane" aria-label="Selected node">
            <h3>{selectedNode.label}</h3>
            <p className="mp-graph-hint">{selectedNode.type}</p>
            {colors ? (
              // Phase 4d (plan Section 6.6 item 3): community color carried
              // into this 2D chrome as an accent, always paired with the
              // same non-color glyph/text cue the 2D fallback/a11y tree use
              // (CommunityBadge) -- identical index -> identical color/glyph
              // everywhere ("encoding invariance", Section 5.1).
              <CommunityBadge
                index={selectedNode.community % colors.community.length}
                count={communityCount}
                level={selectedNode.level}
                color={colors.communityAt(
                  selectedNode.community % colors.community.length,
                  selectedNode.level ?? 0,
                )}
              />
            ) : null}
            {selectedNode.kind === "entity" ? (
              <p>Entity node, degree {selectedNode.degree ?? 0}.</p>
            ) : readingError ? (
              <p className="mp-graph-hint">{readingError}</p>
            ) : readingPage ? (
              <div>
                <button type="button" onClick={() => onOpenPage(readingPage.path)}>
                  Open in Wiki
                </button>
                <div dangerouslySetInnerHTML={{ __html: readingPage.html }} />
              </div>
            ) : (
              <p className="mp-graph-hint">Loading...</p>
            )}
          </aside>
        ) : null}
      </div>

      <GraphA11yTree
        nodes={vizData.nodes}
        edges={vizData.edges}
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelectNode={selectNode}
        mode={mode}
        colors={colors ?? FALLBACK_COLORS}
      />
    </div>
  );
}

// Used only before the first `subscribeGraphColors` callback fires (jsdom /
// pre-hydration) -- never rendered against real user-visible pixels since
// the 3D Canvas itself doesn't mount meaningfully until then either.
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

export default GraphView;
