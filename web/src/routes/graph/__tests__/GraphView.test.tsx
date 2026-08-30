import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GraphView } from "../GraphView";

// The 3D scene needs a real WebGL context R3F/three can't get from jsdom --
// stub it with a thin component that exposes the same hover/select contract
// so GraphView's own state wiring (not R3F/three's rendering) is what's
// under test here. Chrome-based visual/perf validation of the real 3D scene
// happens separately (browser-validator against a live build).
vi.mock("../three/Graph3DScene", () => ({
  Graph3DScene: (props: {
    nodes: { id: string; label: string }[];
    onHoverNode: (id: string | null) => void;
    onSelectNode: (id: string) => void;
    mode?: string;
    paused?: boolean;
    effectsTier?: string;
    // Deep-Field Observatory Phase 4 (plan Section 5.1 IA / Section 5.3
    // "Safe-tier choreography"): the real Graph3DScene fires this from its
    // own PerformanceMonitor-driven ladder -- a real WebGL context can't be
    // driven from jsdom, so this stub exposes a debug button that simulates
    // one discrete resolved-level change, letting GraphView's OWN
    // announcement wiring (not R3F/PerformanceMonitor itself) be under test
    // here, same "stub exposes the contract, not the rendering" convention
    // as the existing node hover/select buttons below.
    onSafeTierLevelChange?: (level: number) => void;
    // Deselection (plan Section 5.1 J-FOCUS "clear"): the real Graph3DScene
    // wires this to its Canvas's `onPointerMissed` (a genuine click that
    // hits no mesh). jsdom can't raycast, so the stub exposes it as a debug
    // button -- same "stub exposes the contract, not the rendering"
    // convention as the safe-tier buttons above.
    onClearSelection?: () => void;
  }) => (
    <div
      data-testid="graph-3d-scene-stub"
      data-mode={props.mode}
      data-paused={String(props.paused)}
      data-effects-tier={props.effectsTier}
    >
      {props.nodes.map((n) => (
        <button key={n.id} onClick={() => props.onSelectNode(n.id)} onMouseEnter={() => props.onHoverNode(n.id)}>
          node:{n.label}
        </button>
      ))}
      <button onClick={() => props.onSafeTierLevelChange?.(1)}>simulate-safe-tier-level-1</button>
      <button onClick={() => props.onSafeTierLevelChange?.(4)}>simulate-safe-tier-level-4</button>
      <button onClick={() => props.onSafeTierLevelChange?.(0)}>simulate-safe-tier-level-0</button>
      <button onClick={() => props.onClearSelection?.()}>simulate-pointer-missed</button>
    </div>
  ),
}));

function makeCtxStub() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center" as CanvasTextAlign,
    fillStyle: "",
    globalAlpha: 1,
  };
}

describe("GraphView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(makeCtxStub() as unknown as CanvasRenderingContext2D);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getContextSpy.mockRestore();
  });

  it("fetches GET /api/graph?mode=both on mount", async () => {
    render(<GraphView onOpenPage={vi.fn()} />);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/graph?mode=both")).toBe(true),
    );
  });

  it("defaults to the 3D scene and can toggle to the 2D fallback and back", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1 }],
        edges: [],
      }),
    });
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Switch to 2D" }));
    expect(screen.queryByTestId("graph-3d-scene-stub")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Switch to 3D" }));
    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
  });

  it("renders a type filter toggle per entity/page type and it stays pressed when active", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [
          { id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 3 },
          { id: "entity:2", label: "Beta", type: "org", kind: "entity", degree: 1 },
        ],
        edges: [{ source: "entity:1", target: "entity:2" }],
      }),
    });
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    const personFilter = await screen.findByRole("button", { name: "person" });
    expect(personFilter).toHaveAttribute("aria-pressed", "false");
    await user.click(personFilter);
    expect(personFilter).toHaveAttribute("aria-pressed", "true");
  });

  it("hover/select flow updates the docked pane and a11y tree via the same callbacks passed to the 3D scene", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 3 }],
        edges: [],
      }),
    });
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    const nodeButton = await screen.findByText("node:Alpha");
    await user.click(nodeButton);

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    // a11y parallel DOM reflects the same selection.
    const tree = screen.getByRole("tree", { name: "Graph nodes" });
    expect(within(tree).getByRole("treeitem", { name: /Alpha/ })).toHaveAttribute("aria-selected", "true");
  });

  // T2 remediation (Section 5.1, 320px reflow finding, overlap half -- live
  // Playwright evidence: selecting a node via the a11y tree with Enter while
  // focus was still inside the tree left the tree's bounded `:focus-within`
  // reveal (graph.css) visually overlapping the newly-opened reading pane's
  // title/badge/Connections list). Moving focus onto the reading pane after
  // a tree-driven selection is what makes `:focus-within` stop applying --
  // the tree returns to its normal sr-only state (per graph.css's own doc
  // comment on that rule) and the overlap can no longer occur.
  it("selecting a node via the a11y tree (Enter key, focus starts in the tree) moves focus onto the reading pane -- the tree returns to sr-only and never overlaps the newly-open pane", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0 }],
        edges: [],
      }),
    });
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    const tree = await screen.findByRole("tree", { name: "Graph nodes" });
    const treeButton = within(tree).getByRole("button", { name: /Alpha/ });
    treeButton.focus();
    expect(treeButton).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    const closeButton = screen.getByRole("button", { name: "Close selected node details" });
    expect(closeButton).toHaveFocus();
    expect(treeButton).not.toHaveFocus();
  });

  // A canvas-driven selection has no meaningful DOM focus to move away from
  // (the click target is the stubbed 3D-scene button in this test, standing
  // in for a canvas raycast hit in production) -- this pins that the
  // tree-only focus-move fix above does NOT fire for every selection path,
  // only the one it was scoped to.
  it("a canvas-driven selection does NOT move focus onto the reading pane close button (the tree-only fix above is scoped to tree-driven selections)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0 }],
        edges: [],
      }),
    });
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    const nodeButton = await screen.findByText("node:Alpha");
    await user.click(nodeButton);

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    const closeButton = screen.getByRole("button", { name: "Close selected node details" });
    expect(closeButton).not.toHaveFocus();
  });

  it("renders the a11y parallel DOM (node tree + links table) alongside either render mode", async () => {
    render(<GraphView onOpenPage={vi.fn()} />);
    expect(await screen.findByRole("tree", { name: "Graph nodes" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Graph links" })).toBeInTheDocument();
  });

  it("shows a status hint (without crashing) when the graph fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(<GraphView onOpenPage={vi.fn()} />);
    expect(await screen.findByText("Couldn't load the graph -- retry from the Graph tab.")).toBeInTheDocument();
  });

  // Phase 4b (plan Section 6.4, item 4): a real UX gap identified by the
  // plan's investigation -- a genuinely empty graph (fresh vault, or one
  // that has never run `mythic index-graph`) used to render a blank canvas
  // with no explanation. Default `fetchMock` already resolves
  // `{nodes: [], edges: []}` (see beforeEach above).
  it("shows the empty-graph state naming `mythic index-graph` and linking to Ingest, instead of a blank canvas", async () => {
    render(<GraphView onOpenPage={vi.fn()} />);
    expect(await screen.findByText("No knowledge graph yet.")).toBeInTheDocument();
    expect(screen.getByText("mythic index-graph")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-3d-scene-stub")).not.toBeInTheDocument();
  });

  it("the empty-graph state's Ingest link navigates via onGoToIngest when provided", async () => {
    const onGoToIngest = vi.fn();
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} onGoToIngest={onGoToIngest} />);

    const ingestLink = await screen.findByRole("button", { name: "Ingest" });
    await user.click(ingestLink);
    expect(onGoToIngest).toHaveBeenCalledTimes(1);
  });

  it("never shows the empty-graph state while the fetch has merely failed (a distinct status hint instead)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(<GraphView onOpenPage={vi.fn()} />);
    await screen.findByText("Couldn't load the graph -- retry from the Graph tab.");
    expect(screen.queryByText("No knowledge graph yet.")).not.toBeInTheDocument();
  });

  // Phase 4c (plan Section 6.5, items 1-2): the production mode-switch
  // radiogroup, wired straight through to Graph3DScene's `mode` prop with
  // real (non-synthetic) fetched data -- the same contract
  // `ModeSpikeView.test.tsx` already proves against synthetic fixtures.
  describe("mode-switch radiogroup (plan Section 6.5, items 1-2)", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0 }],
          edges: [],
        }),
      });
    });

    it("defaults to Cloud and passes mode straight through to Graph3DScene", async () => {
      render(<GraphView onOpenPage={vi.fn()} />);
      const scene = await screen.findByTestId("graph-3d-scene-stub");
      expect(scene).toHaveAttribute("data-mode", "cloud");
      const group = screen.getByRole("radiogroup", { name: "Graph mode" });
      expect(group).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "true");
    });

    it("switching modes updates Graph3DScene's mode prop and announces the change via aria-live", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");

      await user.click(screen.getByRole("radio", { name: "Knowledge Terrain" }));

      expect(screen.getByTestId("graph-3d-scene-stub")).toHaveAttribute("data-mode", "terrain");
      expect(screen.getByRole("radio", { name: "Knowledge Terrain" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "false");
      expect(screen.getByText("Mode: Knowledge Terrain.")).toBeInTheDocument();
    });

    it("preserves selection/filter state across a mode switch (state is owned by GraphView, not per-mode)", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      const nodeButton = await screen.findByText("node:Alpha");
      await user.click(nodeButton);
      expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "Orbital Systems" }));

      // The reading pane is still showing the same selection after the mode
      // switch -- nothing about the selection state was reset.
      expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    });

    // Phase 4d (plan Section 6.6 item 3; visual-system spec Section 5.1):
    // community color carried into 2D chrome as an accent, always paired
    // with the same non-color glyph/text cue the graph's own 2D
    // fallback/a11y tree already use (CommunityBadge) -- extended here into
    // the reading pane's own chrome, not just the canvas/fallback.
    it("the reading pane shows the selected node's community as a color+glyph+text badge", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      const nodeButton = await screen.findByText("node:Alpha");
      await user.click(nodeButton);

      expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
      expect(screen.getByText(/Community 0/)).toBeInTheDocument();
    });
  });

  // Deep-Field Observatory Phase 4 (plan Section 5.1 IA: "a new
  // effects/quality control (Auto default / Full / Balanced / Minimal) ...
  // a small radiogroup labeled 'Graph detail' -- the single inspectable
  // home of the safe-tier decision"). Same radiogroup convention as the
  // mode-switch describe block above.
  describe("effects/quality control -- 'Graph detail' radiogroup (plan Section 5.1 IA / Section 6 Phase 4)", () => {
    // A non-empty fixture, same convention as the mode-switch radiogroup
    // describe block above -- avoids the unrelated empty-graph `role="status"`
    // region (`.mp-graph-empty`) from also being in the document, which
    // would otherwise make the "exactly one status region" test below
    // falsely fail on unrelated empty-state UI, not a real regression.
    beforeEach(() => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0 }],
          edges: [],
        }),
      });
    });

    it("defaults to Auto and passes effectsTier straight through to Graph3DScene", async () => {
      render(<GraphView onOpenPage={vi.fn()} />);
      const scene = await screen.findByTestId("graph-3d-scene-stub");
      expect(scene).toHaveAttribute("data-effects-tier", "auto");
      const group = screen.getByRole("radiogroup", { name: "Graph detail" });
      expect(group).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
    });

    it("is keyboard-operable (plain <button role=\"radio\"> elements, Tab + Enter/Space, same as the existing mode radiogroup)", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");
      const minimalRadio = screen.getByRole("radio", { name: "Minimal" });
      minimalRadio.focus();
      expect(minimalRadio).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(minimalRadio).toHaveAttribute("aria-checked", "true");
    });

    it("switching tiers updates Graph3DScene's effectsTier prop, sets aria-checked correctly, and Minimal genuinely maps to the safe-tier rig selection", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");

      await user.click(screen.getByRole("radio", { name: "Minimal" }));

      expect(screen.getByTestId("graph-3d-scene-stub")).toHaveAttribute("data-effects-tier", "minimal");
      expect(screen.getByRole("radio", { name: "Minimal" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "false");
    });

    it("a manual tier switch announces the plain tier-change message via the SHARED status region (no new competing aria-live region, plan Section 5.1 IA)", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");

      await user.click(screen.getByRole("radio", { name: "Full" }));

      expect(screen.getByText("Graph detail: Full.")).toBeInTheDocument();
    });

    it("a single-step auto-driven safe-tier change (simulated via the real onSafeTierLevelChange contract) announces the specific ladder step via the SAME shared status region", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");

      await user.click(screen.getByText("simulate-safe-tier-level-1"));

      expect(screen.getByText(/bloom/i)).toBeInTheDocument();
      expect(screen.getByText(/reduced/i)).toBeInTheDocument();
    });

    it("does not render a NEW competing aria-live region for effects status -- the pre-existing role=\"status\" count (context-loss region here + GraphA11yTree's own selection-status region) is unchanged, per Section 5.1 IA: \"no new competing region\"", async () => {
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");
      // Exactly 2 pre-existing `role="status"` regions: GraphView's own
      // context-loss paragraph (now ALSO shared with effects-status text,
      // not a new element) and GraphA11yTree's selection-status region.
      expect(screen.getAllByRole("status")).toHaveLength(2);
    });
  });

  // Phase 4c (plan Section 6.5 item 6): per-mode 2D fallback + a11y-tree
  // parity, wired through real (non-mocked) GraphView state.
  describe("per-mode 2D fallback + accessibility-tree parity (plan Section 6.5 item 6)", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [
            { id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0 },
            { id: "entity:2", label: "Beta", type: "org", kind: "entity", degree: 1, community: 1 },
          ],
          edges: [],
        }),
      });
    });

    it("Cloud's 2D fallback stays the canvas node-link diagram (unchanged) when switched to 2D", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");
      await user.click(screen.getByRole("button", { name: "Switch to 2D" }));
      // The canvas-based Cloud fallback renders a <canvas>, not the
      // structural Orbital/Strata/Terrain fallback panel.
      expect(document.querySelector("canvas.mp-graph-canvas")).toBeInTheDocument();
      expect(document.querySelector(".mp-graph-mode-fallback")).not.toBeInTheDocument();
    });

    it("switching to Orbital in 2D mode renders the structural nested-cluster fallback, not the Cloud canvas", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");
      await user.click(screen.getByRole("button", { name: "Switch to 2D" }));
      await user.click(screen.getByRole("radio", { name: "Orbital Systems" }));

      const fallbackPanel = document.querySelector(".mp-graph-mode-fallback");
      expect(fallbackPanel).toBeInTheDocument();
      expect(document.querySelector("canvas.mp-graph-canvas")).not.toBeInTheDocument();
      // The always-present accessibility tree ALSO renders "Community 0" (by
      // design -- Section 6.5 item 6's last bullet requires the same ramp in
      // both places), so scope this assertion to the visible fallback panel
      // itself rather than the whole document.
      expect(within(fallbackPanel as HTMLElement).getByText(/Community 0/)).toBeInTheDocument();
    });

    // VERIFICATION_NEEDS_FIX (major) remediation: Graph2DModeFallback's
    // Strata links table previously had no `edges` prop at all, so its
    // <tbody> was permanently empty regardless of input -- Section 9.3
    // journey 3 requires "Strata renders a dendrogram plus a links table",
    // not a dendrogram plus an empty table shell.
    it("switching to Strata in 2D mode populates the links table with real source/target rows from fetched edges", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [
            { id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0, level: 0 },
            { id: "entity:2", label: "Beta", type: "org", kind: "entity", degree: 1, community: 0, level: 0 },
          ],
          edges: [{ source: "entity:1", target: "entity:2", type: "related" }],
        }),
      });
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");
      await user.click(screen.getByRole("button", { name: "Switch to 2D" }));
      await user.click(screen.getByRole("radio", { name: "Strata" }));

      const fallbackPanel = document.querySelector(".mp-graph-mode-fallback") as HTMLElement;
      expect(fallbackPanel).toBeInTheDocument();
      const table = within(fallbackPanel).getByRole("table", { name: "Graph links" });
      const dataRows = within(table).getAllByRole("row").slice(1);
      expect(dataRows).toHaveLength(1);
      const cells = within(dataRows[0]).getAllByRole("cell").map((c) => c.textContent);
      expect(cells).toEqual(["Alpha", "Beta"]);
    });

    it("the accessibility tree switches structure with mode even while still in 3D", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");

      // Cloud default: the original flat tree.
      expect(screen.getByRole("tree", { name: "Graph nodes" })).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "Orbital Systems" }));
      expect(screen.getByRole("tree", { name: "Communities (Orbital)" })).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "Strata" }));
      expect(screen.getByRole("tree", { name: "Hierarchy levels (Strata)" })).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "Knowledge Terrain" }));
      expect(screen.getByRole("list", { name: "Terrain regions" })).toBeInTheDocument();
    });
  });

  // Phase 4c graph state-lifecycle fix (plan Section 3.3/6.5): `visible`
  // flows through to Graph3DScene's `paused` prop so a mounted-hidden
  // GraphView (see App.test.tsx) pauses its render loop.
  describe("visible -> paused wiring (graph state-lifecycle fix)", () => {
    it("defaults to unpaused when `visible` is omitted", async () => {
      render(<GraphView onOpenPage={vi.fn()} />);
      const scene = await screen.findByTestId("graph-3d-scene-stub");
      expect(scene).toHaveAttribute("data-paused", "false");
    });

    it("passes paused=true to Graph3DScene when visible=false", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0 }],
          edges: [],
        }),
      });
      render(<GraphView onOpenPage={vi.fn()} visible={false} />);
      const scene = await screen.findByTestId("graph-3d-scene-stub");
      expect(scene).toHaveAttribute("data-paused", "true");
    });
  });

  // Deep-Field Observatory Phase 3 (plan Section 3.1 item 3 / Section 5.1
  // J5-EDGE-WEIGHT: "On selection, the reading pane gains a 'Connections'
  // list -- neighbor label plus numeric weight (plus edge type)").
  describe("reading-pane Connections list (plan Section 5.1 J5-EDGE-WEIGHT)", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [
            { id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 2, community: 0 },
            { id: "entity:2", label: "Beta", type: "org", kind: "entity", degree: 1, community: 0 },
            { id: "entity:3", label: "Gamma", type: "org", kind: "entity", degree: 1, community: 0 },
          ],
          edges: [
            { source: "entity:1", target: "entity:2", weight: 7, type: "related" },
            { source: "entity:3", target: "entity:1" }, // no served weight
          ],
        }),
      });
    });

    it("shows each neighbor with its numeric weight when a node with connections is selected", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      const nodeButton = await screen.findByText("node:Alpha");
      await user.click(nodeButton);

      expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
      const connections = screen.getByRole("list", { name: "Connections" });
      expect(within(connections).getByText("Beta")).toBeInTheDocument();
      expect(within(connections).getByText("weight: 7")).toBeInTheDocument();
      expect(within(connections).getByText("Gamma")).toBeInTheDocument();
    });

    it('shows the literal "weight: n/a" fallback for a connection with no served weight -- never a fabricated numeric value', async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      const nodeButton = await screen.findByText("node:Alpha");
      await user.click(nodeButton);

      const connections = await screen.findByRole("list", { name: "Connections" });
      expect(within(connections).getByText("weight: n/a")).toBeInTheDocument();
    });

    it("does not render a Connections list when the selected node has no connections", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 0, community: 0 }],
          edges: [],
        }),
      });
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      const nodeButton = await screen.findByText("node:Alpha");
      await user.click(nodeButton);

      expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Connections" })).not.toBeInTheDocument();
    });
  });

  // Deselection (user-reported usability gap; plan Section 5.1 J-FOCUS:
  // "selection persists until reselect or clear" -- the "clear" half was
  // never built: `selectNode` was the only `selectedId` writer and always
  // set a non-null id, so a selection persisted until a full page reload).
  describe("deselection (plan Section 5.1 J-FOCUS: 'selection persists until reselect or clear')", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [{ id: "entity:1", label: "Alpha", type: "person", kind: "entity", degree: 1, community: 0 }],
          edges: [],
        }),
      });
    });

    async function selectAlpha(user: ReturnType<typeof userEvent.setup>) {
      const nodeButton = await screen.findByText("node:Alpha");
      await user.click(nodeButton);
      expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    }

    it("Escape clears the selection: reading pane closes and the a11y treeitem is no longer selected", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await selectAlpha(user);

      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
      expect(screen.queryByRole("complementary", { name: "Selected node" })).not.toBeInTheDocument();
      const tree = screen.getByRole("tree", { name: "Graph nodes" });
      expect(within(tree).getByRole("treeitem", { name: /Alpha/ })).toHaveAttribute("aria-selected", "false");
    });

    it("Escape with nothing selected is a no-op (no crash, still no reading pane)", async () => {
      render(<GraphView onOpenPage={vi.fn()} />);
      await screen.findByTestId("graph-3d-scene-stub");

      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByRole("complementary", { name: "Selected node" })).not.toBeInTheDocument();
    });

    it("Escape aimed inside an open dialog (e.g. the command palette) does NOT also clear the graph selection -- one Escape press, one consumer", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await selectAlpha(user);

      // Simulate the command palette being open: Radix's DialogContent
      // renders `role="dialog"` and traps focus inside it (the palette's
      // combobox input autofocuses), so the Escape keydown's target is
      // always inside the dialog while it is open. CommandPalette's own
      // window-level handler closes the palette (see its existing "closes
      // on Escape" test); GraphView must leave the selection alone for that
      // same press regardless of listener registration order.
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const input = document.createElement("input");
      dialog.appendChild(input);
      document.body.appendChild(dialog);
      input.focus();
      fireEvent.keyDown(input, { key: "Escape" });
      dialog.remove();

      expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    });

    it("Escape while the graph tab is hidden (mounted-hidden lifecycle, visible=false) leaves the selection alone", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<GraphView onOpenPage={vi.fn()} />);
      await selectAlpha(user);

      rerender(<GraphView onOpenPage={vi.fn()} visible={false} />);
      fireEvent.keyDown(window, { key: "Escape" });

      // Selection state must survive a tab excursion (the same
      // state-preservation contract the mounted-hidden lifecycle exists
      // for) -- an Escape pressed on another tab is not a graph gesture.
      expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    });

    it("the reading pane has an app-owned close button that clears selection and is keyboard-operable", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await selectAlpha(user);

      const close = screen.getByRole("button", { name: "Close selected node details" });
      close.focus();
      expect(close).toHaveFocus();
      await user.keyboard("{Enter}");

      expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
      expect(screen.queryByRole("complementary", { name: "Selected node" })).not.toBeInTheDocument();
    });

    it("a Canvas pointer-miss (genuine click on empty 3D space) clears the selection via the onClearSelection prop", async () => {
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);
      await selectAlpha(user);

      await user.click(screen.getByText("simulate-pointer-missed"));

      expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
      expect(screen.queryByRole("complementary", { name: "Selected node" })).not.toBeInTheDocument();
    });

    it("deselection does NOT collapse expandedIds -- a neighbor disclosed beyond the top-degree cap stays visible after Escape", async () => {
      // 1500 filler nodes (degree 5) fill the progressive-disclosure cap;
      // Omega (degree 1) starts OUTSIDE it and only becomes visible when
      // selecting Hub expands Hub's 1-hop neighborhood into view. Escape
      // must clear ONLY the selection -- Omega stays disclosed, matching
      // the state-preservation ethos mode switches and 2D/3D toggles
      // already follow.
      const filler = Array.from({ length: 1500 }, (_, i) => ({
        id: `entity:f${i}`,
        label: `Filler${i}`,
        type: "person",
        kind: "entity",
        degree: 5,
        community: 0,
      }));
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodes: [
            { id: "entity:hub", label: "Hub", type: "person", kind: "entity", degree: 10, community: 0 },
            { id: "entity:omega", label: "Omega", type: "person", kind: "entity", degree: 1, community: 0 },
            ...filler,
          ],
          edges: [{ source: "entity:hub", target: "entity:omega" }],
        }),
      });
      const user = userEvent.setup();
      render(<GraphView onOpenPage={vi.fn()} />);

      const tree = await screen.findByRole("tree", { name: "Graph nodes" });
      expect(within(tree).queryByText("Omega (person)")).not.toBeInTheDocument();

      await user.click(screen.getByText("node:Hub"));
      expect(within(tree).getByText("Omega (person)")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByRole("complementary", { name: "Selected node" })).not.toBeInTheDocument();
      expect(within(tree).getByText("Omega (person)")).toBeInTheDocument();
    });
  });

});
