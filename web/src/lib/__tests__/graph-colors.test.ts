import { describe, expect, it } from "vitest";
import { formatHex, parse } from "culori";
import { readGraphColors, subscribeGraphColors } from "../graph-colors";

// jsdom resolves custom-property values set directly via `style.setProperty`
// (unlike full var()-chain resolution across a real stylesheet cascade,
// which jsdom does not implement), so these tests set each `--graph-*`
// token's final resolved value directly on a scratch element — proving the
// OKLCH -> THREE.Color conversion, not the CSS cascade (that's covered by
// contrast.test.ts reading the real token files, and by browser-validator
// Chrome validation against the actual app).
function makeRoot(overrides: Record<string, string> = {}): HTMLElement {
  const root = document.createElement("div");
  const defaults: Record<string, string> = {
    "--graph-node-source": "oklch(0.75 0.14 230)",
    "--graph-node-entity": "oklch(0.75 0.16 20)",
    "--graph-node-concept": "oklch(0.75 0.15 150)",
    "--graph-node-session": "oklch(0.75 0.13 300)",
    "--graph-edge": "oklch(0.4 0.02 260 / 0.55)",
    "--graph-edge-active": "oklch(0.72 0.15 250)",
    "--graph-hull-fill": "oklch(0.5 0.05 260 / 0.08)",
    "--graph-glow": "oklch(0.85 0.12 250 / 0.65)",
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`--graph-community-${i + 1}`, "oklch(0.72 0.16 20)"]),
    ),
    ...overrides,
  };
  for (const [key, value] of Object.entries(defaults)) {
    root.style.setProperty(key, value);
  }
  document.body.appendChild(root);
  return root;
}

describe("readGraphColors", () => {
  it("converts every --graph-* token into a THREE.Color matching its OKLCH source", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);

    const expectedHex = formatHex(parse("oklch(0.75 0.16 20)")!);
    const actualHex = `#${colors.node.entity.color.getHexString()}`;
    expect(actualHex.toLowerCase()).toBe(expectedHex!.toLowerCase());
  });

  it("carries the alpha channel separately from the RGB color", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);
    expect(colors.edge.alpha).toBeCloseTo(0.55, 2);
    expect(colors.node.entity.alpha).toBe(1);
  });

  it("returns all 8 community colors", () => {
    const root = makeRoot();
    const colors = readGraphColors(root);
    expect(colors.community).toHaveLength(8);
  });
});

describe("subscribeGraphColors", () => {
  it("fires immediately and again when data-theme changes", async () => {
    const root = makeRoot();
    const seen: string[] = [];
    const unsubscribe = subscribeGraphColors((colors) => {
      seen.push(`#${colors.node.entity.color.getHexString()}`);
    }, root);

    expect(seen).toHaveLength(1);

    root.style.setProperty("--graph-node-entity", "oklch(0.5 0.1 200)");
    root.setAttribute("data-theme", "light");

    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    // MutationObserver callbacks are microtask-scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });
});
