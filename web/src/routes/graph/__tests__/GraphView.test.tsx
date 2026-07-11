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
  }) => (
    <div data-testid="graph-3d-scene-stub">
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
});
