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
// T2 remediation (Finding 2c coverage): mirrors the real `Graph3DScene`'s
// `onReady` prop (fired from its `<Canvas onCreated>` in production) so
// tests can simulate "3D successfully (re-)rendered" without a real WebGL
// context.
let capturedOnReady: (() => void) | null = null;

vi.mock("../three/Graph3DScene", () => ({
  Graph3DScene: (props: { onContextLost?: () => void; onReady?: () => void }) => {
    capturedOnContextLost = props.onContextLost ?? null;
    capturedOnReady = props.onReady ?? null;
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
    capturedOnReady = null;
    // T2 remediation (Finding 2c test coverage): a non-empty fixture --
    // a genuinely empty graph never mounts `Graph3DScene` in the first
    // place (`GraphView`'s own `isEmpty` gate), so it can never actually
    // experience a real context-loss/recovery cycle; a single node is
    // enough to keep that gate open across this suite's toggle/context-loss
    // round trips, matching how this scenario would actually occur.
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [{ id: "n1", label: "Node 1", type: "concept" }], edges: [] }),
    });
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
    const message = await screen.findByText(/3D rendering became unavailable/);
    expect(message).toBeInTheDocument();
    // Finding 2b: the announcement must actually be a live/status region --
    // a plain, non-live paragraph is never announced to assistive tech.
    expect(message).toHaveAttribute("role", "status");
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

  // T2 remediation, Finding 2c: the "3D rendering became unavailable"
  // message used to never clear, even after the user successfully switched
  // back to 3D. `onReady` (fired from the real `Graph3DScene`'s
  // `<Canvas onCreated>`, simulated here via the stub) is GraphView's signal
  // that 3D actually re-rendered.
  it("clears the context-loss announcement once 3D successfully re-renders after a manual retry", async () => {
    vi.spyOn(webgl, "supportsWebGL").mockReturnValue(true);
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
    capturedOnContextLost!();
    expect(await screen.findByText(/3D rendering became unavailable/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Switch to 3D" }));
    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
    expect(capturedOnReady).toBeTypeOf("function");

    // Simulates the real Canvas's `onCreated` firing once the new WebGL
    // context is actually up -- this is what production wires to `onReady`.
    capturedOnReady!();

    await waitFor(() =>
      expect(screen.queryByText(/3D rendering became unavailable/)).not.toBeInTheDocument(),
    );
  });

  // T2 remediation, Finding 2a: a deliberate, working manual toggle must
  // never surface the genuine-context-loss failure message. This exercises
  // GraphView's own wiring only (Graph3DScene is stubbed here, same
  // convention as the rest of this file) -- the real root cause this job
  // fixes (an unmount-triggered `webglcontextlost` from three.js's own
  // `WebGLRenderer.dispose()`) lives entirely inside the REAL
  // `Graph3DScene`, and is covered directly (without a mock) by
  // `graphPerf.synthetic.test.ts`'s `isGenuineContextLoss` coverage instead
  // -- see that file for why jsdom can't drive the full Canvas-mount path
  // this scenario needs.
  it("a manual 2D/3D toggle never shows the context-loss message (GraphView never calls its context-lost handler from the toggle)", async () => {
    vi.spyOn(webgl, "supportsWebGL").mockReturnValue(true);
    const user = userEvent.setup();
    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Switch to 2D" }));
    await waitFor(() => expect(screen.queryByTestId("graph-3d-scene-stub")).not.toBeInTheDocument());
    expect(screen.queryByText(/3D rendering became unavailable/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Switch to 3D" }));
    await waitFor(() => expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument());
    expect(screen.queryByText(/3D rendering became unavailable/)).not.toBeInTheDocument();
  });
});
