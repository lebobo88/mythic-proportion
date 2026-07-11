import { useCallback, useEffect, useMemo, useState } from "react";
import { Color as ThreeColor } from "three";
import { fetchGraph, fetchPage, type GraphData, type PageDetail } from "../../lib/api";
import { subscribeGraphColors, type GraphColors } from "../../lib/graph-colors";
import { consumePendingGraphFocus, subscribeGraphFocus } from "../../lib/graphFocusBus";
import { prefersReducedMotion } from "../../lib/motion";
import { supportsWebGL } from "../../lib/webgl";
import { deriveVizGraph, neighborsOf } from "./graphMath";
import { emptyFilterState, nodeVisible, type FilterState, type VizGraphData } from "./types";
import { generateSyntheticGraph, syntheticGraphSizeFromLocation } from "./synthetic";
import { Graph2DFallback } from "./Graph2DFallback";
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

// Graph view: consumes GET /api/graph?mode=both (Phase 3 page + GraphRAG
// entity/relationship data), rendered either as the Phase 5 3D WebGL scene
// (default) or the REQUIRED 2D canvas fallback, styled entirely from the
// `--graph-*` tokens. Both render modes, the filter/progressive-disclosure
// state, the docked reading pane, and the a11y parallel DOM are all owned
// here so 2D<->3D toggling never loses selection/filter/hover state.
export function GraphView({ onOpenPage }: { onOpenPage: (path: string) => void }) {
  const [rawData, setRawData] = useState<GraphData>({ nodes: [], edges: [] });
  const [statusHint, setStatusHint] = useState<string | null>(null);
  // Graceful-degradation floor (REQUIRED, deliverable 9 / reflexion critique
  // item 4): auto-detect at mount (no WebGL support at all) in addition to
  // the reduced-motion preference; a LIVE context loss is caught separately
  // via Graph3DScene's onContextLost below, both landing on the same 2D path.
  const webglAvailable = useMemo(() => supportsWebGL(), []);
  const [mode3D, setMode3D] = useState<boolean>(() => webglAvailable && !prefersReducedMotion());
  const [colors, setColors] = useState<GraphColors | null>(null);
  const [filter, setFilter] = useState<FilterState>(emptyFilterState());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [readingPage, setReadingPage] = useState<PageDetail | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);

  useEffect(() => subscribeGraphColors(setColors), []);

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

  const handleContextLost = useCallback(() => {
    setMode3D(false);
    setStatusHint("3D rendering became unavailable -- switched to the 2D fallback.");
  }, []);

  function toggleTypeFilter(type: string) {
    setFilter((prev) => {
      const types = new Set(prev.types);
      if (types.has(type)) types.delete(type);
      else types.add(type);
      return { ...prev, types };
    });
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

      {statusHint ? <p className="mp-graph-hint">{statusHint}</p> : null}

      <div className="mp-graph-body">
        <div className="mp-graph-canvas-wrap">
          {mode3D ? (
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
            />
          ) : (
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
          )}
        </div>

        {selectedNode ? (
          <aside className="mp-graph-reading-pane" aria-label="Selected node">
            <h3>{selectedNode.label}</h3>
            <p className="mp-graph-hint">{selectedNode.type}</p>
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
  hullFill: FALLBACK_GRAPH_COLOR,
  glow: FALLBACK_GRAPH_COLOR,
};

export default GraphView;
