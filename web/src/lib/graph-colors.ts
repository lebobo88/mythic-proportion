// Runtime bridge between the `--graph-*` CSS token family (see
// src/styles/tokens/graph.css) and the future R3F 3D scene (Phase 5). Reads
// the *computed* (fully var()-resolved) OKLCH values off <html> and converts
// them into THREE.Color, so the 2D chrome and 3D scene are provably driven
// by one palette. Re-reads automatically whenever `data-theme` changes.
//
// three@0.169's Color.setStyle() does not parse `oklch()` strings, so we
// convert OKLCH -> sRGB ourselves via `culori` before constructing THREE.Color.

import { Color as ThreeColor } from "three";
import { formatRgb, parse } from "culori";

export const GRAPH_NODE_TYPES = ["source", "entity", "concept", "session"] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

const COMMUNITY_COUNT = 8;

export interface GraphColor {
  /** THREE.Color populated from the token's resolved sRGB value. */
  color: ThreeColor;
  /** Alpha channel, if the token specifies one (1 otherwise). */
  alpha: number;
}

export interface GraphColors {
  node: Record<GraphNodeType, GraphColor>;
  edge: GraphColor;
  edgeActive: GraphColor;
  community: GraphColor[]; // index 0..COMMUNITY_COUNT-1
  hullFill: GraphColor;
  glow: GraphColor;
}

function readVar(varName: string, root: Element): string {
  return getComputedStyle(root).getPropertyValue(varName).trim();
}

function toGraphColor(cssValue: string): GraphColor {
  const parsed = parse(cssValue);
  if (!parsed) {
    // Fail loud in dev, but degrade to a visible magenta rather than
    // throwing, so a single missing token doesn't blank the whole scene.
    console.warn(`graph-colors: could not parse token value "${cssValue}"`);
    return { color: new ThreeColor(1, 0, 1), alpha: 1 };
  }
  const rgbString = formatRgb({ ...parsed, alpha: undefined });
  return {
    color: new ThreeColor().setStyle(rgbString),
    alpha: parsed.alpha ?? 1,
  };
}

/**
 * Read the current `--graph-*` tokens off `document.documentElement` (or a
 * given root, for testing) into THREE.Color instances. Call again after any
 * `data-theme` change — see `subscribeGraphColors` for the standing version.
 */
export function readGraphColors(root: Element = document.documentElement): GraphColors {
  const community = Array.from({ length: COMMUNITY_COUNT }, (_, i) =>
    toGraphColor(readVar(`--graph-community-${i + 1}`, root)),
  );

  return {
    node: {
      source: toGraphColor(readVar("--graph-node-source", root)),
      entity: toGraphColor(readVar("--graph-node-entity", root)),
      concept: toGraphColor(readVar("--graph-node-concept", root)),
      session: toGraphColor(readVar("--graph-node-session", root)),
    },
    edge: toGraphColor(readVar("--graph-edge", root)),
    edgeActive: toGraphColor(readVar("--graph-edge-active", root)),
    community,
    hullFill: toGraphColor(readVar("--graph-hull-fill", root)),
    glow: toGraphColor(readVar("--graph-glow", root)),
  };
}

/**
 * Subscribe to graph-color changes: fires `callback` immediately with the
 * current colors, then again every time `data-theme` flips on <html>.
 * Returns an unsubscribe function.
 */
export function subscribeGraphColors(
  callback: (colors: GraphColors) => void,
  root: HTMLElement = document.documentElement,
): () => void {
  callback(readGraphColors(root));

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.attributeName === "data-theme")) {
      callback(readGraphColors(root));
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  return () => observer.disconnect();
}
