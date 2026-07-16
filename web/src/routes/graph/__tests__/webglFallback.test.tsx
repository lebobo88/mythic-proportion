// Reflexion critique item 4 (GAP): the 2D fallback must be reachable
// automatically -- both when WebGL isn't available at all (creation
// failure) and when a live context is lost mid-session -- not only via the
// manual toggle. `Graph3DScene` itself needs a real WebGL context jsdom
// can't provide, so (matching GraphView.test.tsx's own convention) it's
// stubbed here too; what's under test is GraphView's own auto-fallback
// wiring, not R3F/three's rendering.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GraphView } from "../GraphView";
import * as webgl from "../../../lib/webgl";

let capturedOnContextLost: (() => void) | null = null;

vi.mock("../three/Graph3DScene", () => ({
  Graph3DScene: (props: { onContextLost?: () => void }) => {
    capturedOnContextLost = props.onContextLost ?? null;
    return <div data-testid="graph-3d-scene-stub" />;
  },
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

describe("GraphView WebGL graceful-degradation floor", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedOnContextLost = null;
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
    vi.restoreAllMocks();
  });

  it("auto-falls back to 2D at mount when WebGL isn't available -- no manual toggle needed", async () => {
    vi.spyOn(webgl, "supportsWebGL").mockReturnValue(false);
    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to 3D" })).toBeInTheDocument());
    expect(screen.queryByTestId("graph-3d-scene-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to 3D" })).toBeDisabled();
  });

  it("does not disable the toggle and defaults to 3D when WebGL is available", async () => {
    vi.spyOn(webgl, "supportsWebGL").mockReturnValue(true);
    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Switch to 2D" })).not.toBeDisabled();
  });

  it("auto-switches to 2D when Graph3DScene reports a live context loss, without user interaction", async () => {
    vi.spyOn(webgl, "supportsWebGL").mockReturnValue(true);
    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
    expect(capturedOnContextLost).toBeTypeOf("function");

    capturedOnContextLost!();

    await waitFor(() => expect(screen.queryByTestId("graph-3d-scene-stub")).not.toBeInTheDocument());
    expect(await screen.findByText(/3D rendering became unavailable/)).toBeInTheDocument();
  });

  it("switching back to 3D manually after a context-loss fallback still works (toggle stays live)", async () => {
    vi.spyOn(webgl, "supportsWebGL").mockReturnValue(true);
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
    capturedOnContextLost!();
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to 3D" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Switch to 3D" }));
    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
  });
});
