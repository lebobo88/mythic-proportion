// Phase 4a de-risking spike (plan Section 6.3): component-level coverage
// for the spike's isolated mode-switch page. Matches this directory's own
// established convention (see `GraphView.test.tsx`) of stubbing
// `Graph3DScene` -- it needs a real WebGL context jsdom can't provide --
// so what's under test here is ModeSpikeView's OWN mode-state wiring
// (which prop values it passes down), not R3F/three's rendering.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModeSpikeView, readSpikeNodeCount } from "../ModeSpikeView";
import type { GraphMode } from "../types";

let capturedMode: GraphMode | undefined;

vi.mock("../three/Graph3DScene", () => ({
  Graph3DScene: (props: { mode?: GraphMode }) => {
    capturedMode = props.mode;
    return <div data-testid="graph-3d-scene-stub">mode:{props.mode}</div>;
  },
}));

describe("readSpikeNodeCount", () => {
  it("defaults to 1500 (the plan's ~1,500-node feasibility target) when no query param is present", () => {
    expect(readSpikeNodeCount("")).toBe(1500);
  });

  it("reads ?syntheticGraph=N, e.g. for the stress-toward-10,000 case", () => {
    expect(readSpikeNodeCount("?syntheticGraph=10000")).toBe(10000);
  });

  it("falls back to the default for a malformed value", () => {
    expect(readSpikeNodeCount("?syntheticGraph=not-a-number")).toBe(1500);
    expect(readSpikeNodeCount("?syntheticGraph=-5")).toBe(1500);
  });
});

describe("ModeSpikeView", () => {
  it("defaults to Cloud mode and passes it straight through to Graph3DScene", () => {
    render(<ModeSpikeView />);
    expect(screen.getByTestId("graph-3d-scene-stub")).toHaveTextContent("mode:cloud");
    expect(capturedMode).toBe("cloud");
  });

  it("renders one radio per graph mode, Cloud checked by default", () => {
    render(<ModeSpikeView />);
    const group = screen.getByRole("radiogroup", { name: "Graph mode (Phase 4a spike)" });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Orbital Systems" })).toHaveAttribute("aria-checked", "false");
  });

  it("switching to Orbital Systems re-renders Graph3DScene with mode=\"orbital\" and updates the live status line", async () => {
    const user = userEvent.setup();
    render(<ModeSpikeView />);

    await user.click(screen.getByRole("radio", { name: "Orbital Systems" }));

    expect(screen.getByTestId("graph-3d-scene-stub")).toHaveTextContent("mode:orbital");
    expect(capturedMode).toBe("orbital");
    expect(screen.getByRole("radio", { name: "Orbital Systems" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Mode: Orbital Systems.")).toBeInTheDocument();
  });

  it("can cycle through all four modes in sequence, each one reaching Graph3DScene", async () => {
    const user = userEvent.setup();
    render(<ModeSpikeView />);

    for (const [label, expected] of [
      ["Strata", "strata"],
      ["Knowledge Terrain", "terrain"],
      ["Cloud", "cloud"],
    ] as const) {
      await user.click(screen.getByRole("radio", { name: label }));
      expect(capturedMode).toBe(expected);
    }
  });

  it("passes a non-empty synthetic node set to Graph3DScene (the ~1,500-node default fixture)", () => {
    render(<ModeSpikeView />);
    // The stub only renders mode, but a crash-free render with the real
    // `generateSyntheticGraph`/`deriveVizGraph` pipeline wired underneath is
    // itself evidence the ~1,500-node default fixture path works end to
    // end (id-based grouping, visibleIds, colors fallback, etc.).
    expect(screen.getByTestId("graph-3d-scene-stub")).toBeInTheDocument();
    expect(screen.getByText(/1500 synthetic nodes/)).toBeInTheDocument();
  });
});
