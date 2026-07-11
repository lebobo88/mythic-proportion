import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { GraphView } from "../GraphView";

// jsdom does not implement canvas 2D rendering; GraphView degrades to a
// no-op if getContext("2d") returns null, so every test needs a stub
// context with spies for the drawing calls actually used by GraphView.draw().
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
  };
}

describe("GraphView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let ctxStub: ReturnType<typeof makeCtxStub>;
  let capturedTick: FrameRequestCallback | null;
  let rafCallCount: number;
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    ctxStub = makeCtxStub();
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxStub as unknown as CanvasRenderingContext2D);

    capturedTick = null;
    rafCallCount = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        rafCallCount += 1;
        if (rafCallCount === 1) capturedTick = cb; // capture only the first scheduled frame
        return rafCallCount;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getContextSpy.mockRestore();
  });

  it("hits GET /api/graph and draws nothing for the empty-graph state", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [], edges: [] }) });

    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/graph")).toBe(true));
    // Let the fetch .then() microtask apply the (empty) graph data before
    // manually driving one simulation frame.
    await Promise.resolve();
    await Promise.resolve();
    capturedTick?.(0);

    expect(ctxStub.arc).not.toHaveBeenCalled();
    expect(ctxStub.clearRect).toHaveBeenCalled();
  });

  it("hits GET /api/graph and draws nodes/edges for the populated-graph state", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        nodes: [
          { id: "notes/alpha.md", label: "Alpha", type: "concept" },
          { id: "notes/beta.md", label: "Beta", type: "entity" },
        ],
        edges: [{ source: "notes/alpha.md", target: "notes/beta.md" }],
      }),
    });

    render(<GraphView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/graph")).toBe(true));
    await Promise.resolve();
    await Promise.resolve();
    capturedTick?.(0);

    expect(ctxStub.arc).toHaveBeenCalledTimes(2);
    expect(ctxStub.moveTo).toHaveBeenCalledTimes(1);
    expect(ctxStub.lineTo).toHaveBeenCalledTimes(1);
  });

  it("shows a status hint (without crashing) when the graph fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { findByText } = render(<GraphView onOpenPage={vi.fn()} />);

    expect(await findByText("Couldn't load the graph -- retry from the Graph tab.")).toBeInTheDocument();
  });
});
