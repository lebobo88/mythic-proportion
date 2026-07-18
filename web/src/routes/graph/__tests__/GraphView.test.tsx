import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  }) => (
    <div data-testid="graph-3d-scene-stub" data-mode={props.mode} data-paused={String(props.paused)}>
      {props.nodes.map((n) => (
        <button key={n.id} onClick={() => props.onSelectNode(n.id)} onMouseEnter={() => props.onHoverNode(n.id)}>
          node:{n.label}
        </button>
      ))}
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
});
