// Deselection visual-state remediation (live Browser Validator finding:
// after Escape/close/empty-space deselection, the previously-selected node's
// highlight styling -- emissive glow, blue `edgeActive` connection edges,
// context dim -- stayed "stuck" indefinitely, cumulatively across nodes and
// across a 2D/3D round-trip).
//
// CONFIRMED ROOT CAUSE (live Chromium reproduction against the real
// InstancedMesh2/fat-line GPU state, not a hypothesis): `selectedId` and its
// derived styling DO clear correctly -- the stuck "selected look" is the
// HOVER styling driven by a stale `hoveredId`. Hover state is only ever
// re-derived from pointer events (R3F re-raycasts exclusively on pointer
// events), but clicking a node moves the world under a stationary cursor
// (selection camera-fit + reading-pane layout shift), and Escape-deselection
// moves nothing -- so no pointer event ever fires again and `hoveredId`
// stays stuck on the old node. Hover styling is visually near-identical to
// selection styling (same `edgeActive` blue edges, emissive 0.6 vs 1.0,
// same context dim), `hoveredId` lives in GraphView (mounted-persistent), so
// the "highlight" survives deselection, accumulates alongside the next
// selection (two styled nodes at once), and survives a 2D/3D round-trip.
//
// The fix: GraphView re-baselines `hoveredId` to null at every programmatic
// selection transition (selectNode and clearSelection/Escape) -- the pointer
// -position basis hover was derived from is invalidated at exactly those
// points. A genuine hover immediately re-derives from the next real pointer
// event, so nothing is lost; a stale one stops masquerading as selection.
//
// These tests exercise the full GraphView state journey through the same
// stub-scene contract GraphView.test.tsx already uses, asserting on the
// EXACT props that drive every per-node visual (InstancedNodes emissive/
// scale/dim, InstancedEdges edgeActive color, NodeLabels, 2D canvas) -- the
// live reproduction proved those leaf layers re-derive faithfully from these
// props on every change, so the props ARE the derived-visual-state seam
// jsdom can honestly pin.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GraphView } from "../GraphView";

vi.mock("../three/Graph3DScene", () => ({
  Graph3DScene: (props: {
    nodes: { id: string; label: string }[];
    selectedId: string | null;
    hoveredId: string | null;
    onHoverNode: (id: string | null) => void;
    onSelectNode: (id: string) => void;
    onClearSelection?: () => void;
  }) => (
    <div
      data-testid="graph-3d-scene-stub"
      data-selected-id={props.selectedId ?? ""}
      data-hovered-id={props.hoveredId ?? ""}
    >
      {props.nodes.map((n) => (
        <button
          key={n.id}
          onClick={() => props.onSelectNode(n.id)}
          onMouseEnter={() => props.onHoverNode(n.id)}
        >
          node:{n.label}
        </button>
      ))}
      <button onClick={() => props.onClearSelection?.()}>simulate-pointer-missed</button>
    </div>
  ),
}));

describe("deselection genuinely clears the derived highlight drivers (stale-hover root cause)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [
          { id: "entity:a", label: "Alpha", type: "person", kind: "entity", degree: 2, community: 0 },
          { id: "entity:b", label: "Beta", type: "org", kind: "entity", degree: 1, community: 0 },
        ],
        edges: [{ source: "entity:a", target: "entity:b" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    // A truthy context stub so `supportsWebGL()` reports true and GraphView
    // mounts the (stubbed) 3D scene -- same convention as GraphView.test.tsx.
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as unknown as CanvasRenderingContext2D);
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

  async function hoverAndSelectAlpha(user: ReturnType<typeof userEvent.setup>) {
    const nodeButton = await screen.findByText("node:Alpha");
    // The real pointer journey: a pointermove raycast sets hover, then the
    // click selects. After the click the camera fit / pane layout shift can
    // move the node away from the stationary cursor, so NO further pointer
    // event is guaranteed -- exactly the live reproduction's conditions.
    await user.hover(nodeButton);
    await user.click(nodeButton);
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
  }

  it("Escape clears the hover-derived highlight driver too -- not just selectedId (the live stuck-highlight bug)", async () => {
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);
    await hoverAndSelectAlpha(user);

    fireEvent.keyDown(window, { key: "Escape" });

    const scene = screen.getByTestId("graph-3d-scene-stub");
    expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
    expect(scene).toHaveAttribute("data-selected-id", "");
    // The load-bearing assertion: with a stationary pointer no new pointer
    // event will fire, so if this is still "entity:a" every renderer keeps
    // painting Alpha's glow/blue-edge/dim treatment indefinitely.
    expect(scene).toHaveAttribute("data-hovered-id", "");
  });

  it("the reading-pane close button clears the hover-derived highlight driver too", async () => {
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);
    await hoverAndSelectAlpha(user);

    await user.click(screen.getByRole("button", { name: "Close selected node details" }));

    const scene = screen.getByTestId("graph-3d-scene-stub");
    expect(scene).toHaveAttribute("data-selected-id", "");
    expect(scene).toHaveAttribute("data-hovered-id", "");
  });

  it("a Canvas pointer-miss clear (empty-space click) clears the hover-derived highlight driver too", async () => {
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);
    await hoverAndSelectAlpha(user);

    await user.click(screen.getByText("simulate-pointer-missed"));

    const scene = screen.getByTestId("graph-3d-scene-stub");
    expect(scene).toHaveAttribute("data-selected-id", "");
    expect(scene).toHaveAttribute("data-hovered-id", "");
  });

  it("selecting node B after deselecting node A never leaves A's highlight drivers behind (the cumulative multiple-stuck-nodes symptom)", async () => {
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);
    await hoverAndSelectAlpha(user);

    fireEvent.keyDown(window, { key: "Escape" });

    // Select Beta through the a11y tree -- a programmatic (non-pointer)
    // selection, like Cmd+K jump. The stale hover on Alpha must not survive
    // it: live reproduction showed Alpha (hover 0.6 emissive + blue edges)
    // and Beta (selected 1.0) styled SIMULTANEOUSLY in this journey.
    const tree = screen.getByRole("tree", { name: "Graph nodes" });
    await user.click(within(tree).getByText("Beta (org)"));

    const scene = screen.getByTestId("graph-3d-scene-stub");
    expect(scene).toHaveAttribute("data-selected-id", "entity:b");
    expect(scene).toHaveAttribute("data-hovered-id", "");
  });

  it("a genuine new hover still re-derives normally after a deselection (nothing over-cleared)", async () => {
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);
    await hoverAndSelectAlpha(user);

    fireEvent.keyDown(window, { key: "Escape" });
    await user.hover(screen.getByText("node:Beta"));

    expect(screen.getByTestId("graph-3d-scene-stub")).toHaveAttribute("data-hovered-id", "entity:b");
  });
});
