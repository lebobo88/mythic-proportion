// Browser-audit item 8 (cosmetic, live-Chrome finding): the 2D graph
// fallback previously drew every visible node's label unconditionally, with
// no collision avoidance -- close nodes' labels (e.g. "TEXAS" and "ACME
// ROBOTICS") visibly overlapped. `Graph2DFallback` draws to a raw
// `<canvas>` via `requestAnimationFrame`, which isn't practically
// behavior-testable in jsdom (no real `CanvasRenderingContext2D`/paint
// pipeline) -- this is a structural/source-level test, the same pattern
// `graphPerf.synthetic.test.ts` already uses elsewhere in this route for
// the same reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(): string {
  return readFileSync(join(__dirname, "..", "Graph2DFallback.tsx"), "utf-8");
}

describe("Graph2DFallback: 2D label collision avoidance (browser-audit item 8)", () => {
  it("measures each label and skips drawing it when it overlaps an already-placed label", () => {
    const source = readSource();
    expect(source).toMatch(/ctx!\.measureText\(/);
    expect(source).toMatch(/overlapsPlaced/);
    expect(source).toMatch(/if \(overlapsPlaced && !isFocused\) continue;/);
  });

  it("always draws the selected/hovered node's label regardless of overlap", () => {
    const source = readSource();
    expect(source).toMatch(/const isFocused = node\.id === selectedId \|\| node\.id === hoveredId;/);
    // The focused-node check must gate the skip, not the draw -- i.e. a
    // focused node's label is never suppressed by the collision check.
    expect(source).toMatch(/overlapsPlaced && !isFocused/);
  });

  it("prioritizes larger/higher-degree nodes' labels over smaller ones so suppression is stable, not flickering", () => {
    const source = readSource();
    expect(source).toMatch(/return b\.size - a\.size;/);
  });

  it("every visible node's circle is still drawn even when its label is suppressed (label suppression never hides the node itself)", () => {
    const source = readSource();
    // Two separate loops over visible nodes: one draws circles
    // unconditionally, a second (later) pass handles label collision.
    const circleLoopMatch = /for \(const node of nodesRef\.current\) \{\s*if \(!visibleIds\.has\(node\.id\)\) continue;[\s\S]*?ctx!\.fill\(\);\s*\}/;
    expect(source).toMatch(circleLoopMatch);
    expect(source.indexOf("ctx!.arc(")).toBeLessThan(source.indexOf("labelCandidates"));
  });
});
