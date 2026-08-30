// Capped troika-three-text labels (Issue 3c, live-Chrome hardening pass):
// the 3D scene must NEVER render one `Text` mesh per node -- at 10k/50k
// nodes that is its own GPU/CPU blowup on top of the instanced-mesh cost.
// Instead we hard-cap the labeled set to the hovered node, the selected
// node, and the highest-degree nodes among whatever's currently rendered,
// up to `maxLabels` total. Positions are written into each `Text`'s
// `.position` from the same per-tick buffer InstancedNodes/InstancedEdges
// consume -- never via React state (see Graph3DScene's single onTick
// subscriber).
//
// Deep-Field Observatory Phase 2 (plan Section 3.1 item 2 / Section 5.2
// "Typography" / Section 6 Phase 2): a TWO-TIER label system layered on top
// of the cap above. Tier 1 ("community titles", ~8-12, always-on, on a
// chip) is drawn for the largest currently-visible communities (same
// `computeCommunityCentroids` ranking `CommunityCentroidBadges.tsx` already
// uses -- single source, never a second aggregation) and ALWAYS wins the
// shared cap (`selectLabelTiers`). Tier 2 ("node labels") keeps the
// pre-Phase-2 hovered/selected/top-degree selection, now bounded to
// whatever budget remains after titles, and carries a screen-space MINIMUM
// size (`computeNodeLabelFontSize`) so a label never shrinks below
// legibility purely from camera distance/perspective, while still allowed
// to shrink smaller than that up close (never grows unbounded either).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Mesh, MeshBasicMaterial, PlaneGeometry, type Group } from "three";
import { Text } from "troika-three-text";
import type { GraphColors, LabelTierParams } from "../../../lib/graph-colors";
import type { VizNode } from "../types";
import { computeCommunityCentroids, type CommunityCentroid } from "./CommunityCentroidBadges";

export interface NodeLabelsHandle {
  /** Mutate label positions from the latest worker tick -- called from Graph3DScene's single onTick subscriber. */
  applyPositions(positions: Float32Array, ids: string[]): void;
}

export interface NodeLabelsProps {
  /** Already-bounded (rendered/disclosed) node set -- see Graph3DScene's `renderedNodes`. */
  nodes: VizNode[];
  colors: GraphColors;
  selectedId: string | null;
  hoveredId: string | null;
  /** Hard cap on simultaneously-labeled nodes -- overrides `colors.labelTier.cap` when given (test/back-compat escape hatch; production wiring omits this and reads the token). */
  maxLabels?: number;
  /**
   * Deep-Field Observatory Phase 2: same `{ get(id) }` live-position
   * accessor `CommunityHulls`/`CommunityCentroidBadges`/`Graph3DScene` share
   * -- needed to compute community-title centroid positions on the same
   * low-frequency (never-per-tick) cadence.
   */
  positionsRef: { current: { get(id: string): [number, number, number] | undefined } };
}

const LABEL_Y_OFFSET = 1.6;
const COMMUNITY_TITLE_Y_OFFSET = 2.4;

// Calibrated to this file's pre-Phase-2 hardcoded `fontSize = 1.3` for what
// was implicitly a ~13px-equivalent label -- so Phase 1's declared
// `--graph-label-tier-*-size` px tokens (12/15) translate to nearly the same
// world-unit sizes the app already shipped and was visually tuned against,
// rather than an unrelated new scale (Section 5.7 permitted variation: exact
// numerics may be tuned, but token-driven).
const WORLD_UNITS_PER_PX = 0.1;

function worldFontSize(px: number): number {
  return px * WORLD_UNITS_PER_PX;
}

function colorForLabel(node: VizNode, colors: GraphColors): number {
  const base =
    node.kind === "entity"
      ? colors.community[node.community % colors.community.length]?.color
      : colors.node[node.type as keyof GraphColors["node"]]?.color;
  return (base ?? colors.node.concept.color).getHex();
}

/**
 * Deep-Field Observatory Phase 2 (plan Section 5.2 "Typography": "titles win
 * the cap under pressure"; Section 5.6 item 8: "labels hard-capped ~40,
 * two-tier, with community titles winning"). Pure, directly testable.
 * `communityCentroids` MUST already be ranked most-significant-first (the
 * exact contract `computeCommunityCentroids` returns) -- this function trusts
 * that ordering rather than re-sorting, so title selection and centroid-badge
 * selection can never silently disagree about which communities "matter
 * most" when both are over budget.
 *
 * Node-label budget is `max(0, cap - titlesShown)` -- titles ALWAYS win,
 * even in the degenerate case where `communityMax` alone already exceeds
 * `cap` (the node-label tier simply gets zero budget rather than a negative
 * one or a crash).
 */
export function selectLabelTiers(
  nodes: VizNode[],
  communityCentroids: CommunityCentroid[],
  selectedId: string | null,
  hoveredId: string | null,
  labelTier: Pick<LabelTierParams, "cap" | "communityMax">,
): { communityTitles: CommunityCentroid[]; nodeLabels: VizNode[] } {
  const communityMax = Math.max(0, Math.floor(labelTier.communityMax));
  const communityTitles = communityCentroids.slice(0, communityMax);

  const cap = Math.max(0, Math.floor(labelTier.cap));
  const nodeLabelBudget = Math.max(0, cap - communityTitles.length);

  const out: VizNode[] = [];
  const seen = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const id of [selectedId, hoveredId]) {
    if (!id || seen.has(id)) continue;
    const node = byId.get(id);
    if (node) {
      out.push(node);
      seen.add(id);
    }
  }

  const byDegree = [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  for (const node of byDegree) {
    if (out.length >= nodeLabelBudget) break;
    if (seen.has(node.id)) continue;
    out.push(node);
    seen.add(node.id);
  }

  return { communityTitles, nodeLabels: out.slice(0, nodeLabelBudget) };
}

/**
 * Deep-Field Observatory Phase 2 (plan Section 5.2 "Typography": "a hard
 * minimum `--graph-label-tier-node-min-size` 10px"). World-space text size
 * naturally shrinks with camera distance under perspective projection; this
 * computes the world-unit size that would render as exactly `minPx` pixels
 * tall at the given `distance`/`fovDegrees`/`viewportHeightPx` -- the
 * standard screen-space-size-compensation formula (world size = target
 * pixel size * (2 * tan(fov/2) * distance / viewport height)).
 */
export function computeScreenSpaceWorldSize(
  distance: number,
  fovDegrees: number,
  viewportHeightPx: number,
  minPx: number,
): number {
  if (!(viewportHeightPx > 0) || !(distance > 0) || !(fovDegrees > 0)) {
    return minPx * WORLD_UNITS_PER_PX;
  }
  const worldPerPixel = (2 * Math.tan((fovDegrees * Math.PI) / 360) * distance) / viewportHeightPx;
  return minPx * worldPerPixel;
}

/**
 * `baseWorldSize` (the token-driven `--graph-label-tier-node-size` world
 * equivalent) is the label's normal size; it is allowed to render SMALLER
 * up close under perspective (no maximum enforced -- only a MINIMUM, per
 * spec) and is floored at the screen-space-minimum-equivalent world size at
 * long range, so it never becomes illegible purely from distance.
 */
export function computeNodeLabelFontSize(
  baseWorldSize: number,
  distance: number,
  fovDegrees: number,
  viewportHeightPx: number,
  minPx: number,
): number {
  return Math.max(baseWorldSize, computeScreenSpaceWorldSize(distance, fovDegrees, viewportHeightPx, minPx));
}

/** Only re-assign (and therefore re-sync troika's SDF layout) on a material size change -- see `shouldRefreshLabelFontSize`. */
export const LABEL_FONT_REFRESH_RATIO = 1.1;

/**
 * T3-advised escalation remediation (plan Section 11's escalation track;
 * live Browser Validator finding: leaving Terrain produced a giant distorted
 * black label smear). CONFIRMED ROOT CAUSE (T3's distance-basis hypothesis
 * refined by this writer's own trace -- the dominant mechanism is
 * STALENESS): the font floor used to be recomputed ONLY inside the
 * tick-driven `applyPositions` path, from the camera position vector's own
 * magnitude (distance to the world ORIGIN). d3-force stops ticking once
 * "end" fires (`forceLayout.worker.ts` -- the settle freeze), and that same
 * "end" event is exactly what triggers the settle-fit camera animation -- so
 * the floor was always computed at the PRE-fit camera distance and then
 * frozen while the camera moved, with no further tick ever correcting it.
 * Terrain-to-anything is the worst case: Terrain's extent-aware fit parks
 * the camera farthest out, so the frozen floor was enormous in world units;
 * the incoming mode's much closer fit then rendered those huge
 * black-outlined glyphs close-up (a ~10x+ oversize; quantified in
 * `nodeLabelFontRefresh.test.ts`).
 *
 * Fix: font sizing lives in a per-frame, refs-only `useFrame` refresh (the
 * same discipline Graph3DScene's bloom/fog easing uses -- mesh-property
 * mutation, never setState), from each label's OWN camera distance (which
 * also subsumes the origin-vs-target correction T3 suggested). This
 * hysteresis gate keeps troika from re-laying-out glyphs every frame: only a
 * >= ~10% relative change (either direction) re-assigns `fontSize`. A
 * non-positive/NaN current size always refreshes; a non-positive candidate
 * never does.
 */
export function shouldRefreshLabelFontSize(current: number, next: number): boolean {
  if (!(next > 0) || !Number.isFinite(next)) return false;
  if (!(current > 0) || !Number.isFinite(current)) return true;
  const ratio = next > current ? next / current : current / next;
  return ratio >= LABEL_FONT_REFRESH_RATIO;
}

/**
 * Approximate chip footprint from the title string length -- troika's exact
 * glyph metrics are only available asynchronously (post-`sync()`), and this
 * chip is decorative/non-load-bearing background chrome (the SDF outline
 * plus the text itself remain the actual legibility carriers, per Section
 * 5.2: "The outline and chip are the legibility carriers; bloom is never
 * the legibility carrier" -- the chip specifically is documented there
 * alongside the outline as an ADDITIONAL enhancement, not the sole carrier).
 * A documented, tunable approximation (Section 5.7 permitted variation), not
 * exact glyph metrics.
 */
function estimateChipSize(title: string, fontSize: number): { width: number; height: number } {
  const CHAR_WIDTH_FACTOR = 0.62;
  const width = Math.max(fontSize, title.length * fontSize * CHAR_WIDTH_FACTOR);
  const height = fontSize * 1.6;
  return { width, height };
}

interface CommunityTitleEntry {
  text: Text;
  chip: Mesh;
}

export const NodeLabels = forwardRef<NodeLabelsHandle, NodeLabelsProps>(function NodeLabels(
  { nodes, colors, selectedId, hoveredId, maxLabels, positionsRef },
  ref,
) {
  const groupRef = useRef<Group>(null);
  const textsRef = useRef(new Map<string, Text>());
  const communityTextsRef = useRef(new Map<number, CommunityTitleEntry>());
  const communityCentroidsRef = useRef<CommunityCentroid[]>([]);
  const camera = useThree((state) => state.camera);
  const viewportHeight = useThree((state) => state.size.height);

  const labelTier: LabelTierParams = useMemo(
    () => (maxLabels === undefined ? colors.labelTier : { ...colors.labelTier, cap: maxLabels }),
    [colors.labelTier, maxLabels],
  );

  // Community-title centroids: same low-frequency (never-per-tick) interval
  // convention as `CommunityHulls.tsx`/`CommunityCentroidBadges.tsx` --
  // recomputed independently here (not lifted to a shared parent state) to
  // keep each chrome layer's own subscription self-contained, matching this
  // codebase's established per-component-interval convention; the
  // AGGREGATION LOGIC itself is still the single shared
  // `computeCommunityCentroids` function, never re-derived. `centroidsTick`
  // exists only to tell the `useMemo` below to re-run when the ref updates
  // (a ref alone never triggers a re-render) -- same documented pattern
  // Graph3DScene's own `transitioning` state uses for an analogous
  // ref-mirror-for-re-render need.
  const [centroidsTick, setCentroidsTick] = useState(0);
  useEffect(() => {
    const visibleIdsForLabels = new Set(nodes.map((n) => n.id));
    const id = window.setInterval(() => {
      communityCentroidsRef.current = computeCommunityCentroids(nodes, visibleIdsForLabels, positionsRef.current);
      setCentroidsTick((tick) => tick + 1);
    }, 800);
    return () => window.clearInterval(id);
  }, [nodes, positionsRef]);

  // Selection: hovered + selected are always included (if currently
  // rendered), then top-degree nodes fill the remaining budget -- community
  // titles are computed on the low-frequency interval above and always win
  // the shared cap (`selectLabelTiers`).
  const { communityTitles, nodeLabels: labeledNodes } = useMemo(
    () => selectLabelTiers(nodes, communityCentroidsRef.current, selectedId, hoveredId, labelTier),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, selectedId, hoveredId, labelTier, centroidsTick],
  );

  // Rebuild the (small, capped) set of node-label Text meshes on selection
  // change -- NOT per tick/per frame.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const existing = textsRef.current;
    const keep = new Set(labeledNodes.map((n) => n.id));

    for (const [id, text] of existing) {
      if (keep.has(id)) continue;
      group.remove(text);
      text.dispose();
      existing.delete(id);
    }

    for (const node of labeledNodes) {
      let text = existing.get(node.id);
      if (!text) {
        text = new Text();
        text.fontSize = worldFontSize(labelTier.nodeSize);
        text.anchorX = "center";
        text.anchorY = "bottom";
        text.outlineWidth = "6%";
        text.outlineColor = 0x000000;
        // T3-advised escalation remediation (part of the same label-smear
        // fix -- see `shouldRefreshLabelFontSize` above): seed a NEW label
        // at its node's live position immediately. Positions are otherwise
        // only written by the tick-driven `applyPositions`, and d3-force
        // stops ticking once settled -- so a label created by a post-settle
        // hover/selection would sit at the world origin indefinitely.
        const seed = positionsRef.current.get(node.id);
        if (seed) text.position.set(seed[0], seed[1] + LABEL_Y_OFFSET, seed[2]);
        group.add(text);
        existing.set(node.id, text);
      }
      text.text = node.label;
      text.color = colorForLabel(node, colors);
      text.sync();
    }
  }, [labeledNodes, colors, labelTier, positionsRef]);

  // Community-title chip+text meshes -- rebuilt when the title set or colors
  // change, keyed by COMMUNITY INDEX (stable across ticks), not node id.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const existing = communityTextsRef.current;
    const keep = new Set(communityTitles.map((c) => c.community));

    for (const [community, entry] of existing) {
      if (keep.has(community)) continue;
      group.remove(entry.text);
      group.remove(entry.chip);
      entry.text.dispose();
      entry.chip.geometry.dispose();
      (entry.chip.material as MeshBasicMaterial).dispose();
      existing.delete(community);
    }

    const fontSize = worldFontSize(labelTier.communitySize);
    for (const centroid of communityTitles) {
      let entry = existing.get(centroid.community);
      const title = `Community ${centroid.community}`;
      if (!entry) {
        const text = new Text();
        text.anchorX = "center";
        text.anchorY = "middle";
        text.fontWeight = 600;
        text.outlineWidth = `${labelTier.outlineWidth * 100}%`;
        text.outlineColor = 0x000000;
        // A fixed, low-alpha dark backing -- decorative chip chrome, never
        // the sole legibility carrier (the SDF outline plus the text glyphs
        // are). `--graph-label-chip-bg` (Section 5.2) is a CSS `color-mix()`
        // value that culori (this app's single color parser) cannot parse
        // directly, so this constant is a deliberate, documented
        // simplification of that token's INTENT (a translucent dark
        // backing), not a literal read of the token itself -- flagged here
        // rather than fabricating a "token-sourced" claim (Section 5.7
        // permitted variation covers exact chip numerics).
        const chip = new Mesh(
          new PlaneGeometry(1, 1),
          new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }),
        );
        group.add(chip);
        group.add(text);
        entry = { text, chip };
        existing.set(centroid.community, entry);
      }
      entry.text.text = title;
      entry.text.fontSize = fontSize;
      entry.text.color = colors.community[centroid.community % colors.community.length]?.color.getHex() ?? 0xffffff;
      entry.text.sync();
      const chipSize = estimateChipSize(title, fontSize);
      entry.chip.scale.set(chipSize.width, chipSize.height, 1);
    }
  }, [communityTitles, colors, labelTier]);

  useEffect(() => {
    const texts = textsRef.current;
    const communityTexts = communityTextsRef.current;
    return () => {
      for (const text of texts.values()) text.dispose();
      texts.clear();
      for (const entry of communityTexts.values()) {
        entry.text.dispose();
        entry.chip.geometry.dispose();
        (entry.chip.material as MeshBasicMaterial).dispose();
      }
      communityTexts.clear();
    };
  }, []);

  // T3-advised escalation remediation (see `shouldRefreshLabelFontSize`'s
  // doc comment above for the full root cause): the screen-space-minimum
  // font floor is applied HERE, per frame, refs-only (mesh-property
  // mutation, never setState -- the same `useFrame` discipline
  // Graph3DScene's bloom/fog easing follows), instead of inside the
  // tick-driven `applyPositions` path, which freezes the moment the sim
  // settles -- exactly when the settle-fit camera animation starts moving
  // the camera. Distance is each label's OWN camera distance (never the
  // camera's distance to the world origin), and the hysteresis gate means
  // steady state does zero troika re-syncs: O(<=40 labels) distance checks
  // per frame, with re-assignment only on a material (>=10%) change during
  // an actual camera move.
  useFrame(() => {
    const texts = textsRef.current;
    if (texts.size === 0) return;
    const perspective = camera as unknown as { fov?: number; isPerspectiveCamera?: boolean };
    const fovDeg = perspective.isPerspectiveCamera && perspective.fov ? perspective.fov : 50;
    const base = worldFontSize(labelTier.nodeSize);
    for (const text of texts.values()) {
      const next = computeNodeLabelFontSize(
        base,
        camera.position.distanceTo(text.position),
        fovDeg,
        viewportHeight,
        labelTier.nodeMinSize,
      );
      if (shouldRefreshLabelFontSize(text.fontSize as number, next)) {
        text.fontSize = next;
      }
    }
  });

  useImperativeHandle(
    ref,
    () => ({
      applyPositions(positions, ids) {
        const texts = textsRef.current;
        if (texts.size > 0) {
          for (let i = 0; i < ids.length; i++) {
            const text = texts.get(ids[i]);
            if (!text) continue;
            text.position.set(positions[i * 3], positions[i * 3 + 1] + LABEL_Y_OFFSET, positions[i * 3 + 2]);
          }
        }

        // Community titles follow their centroid, not any single node's
        // position -- moved on the same low-frequency cadence their
        // centroid itself updates (via the interval effect above), read
        // here so the chip/text mesh positions stay current without a
        // second per-tick write path.
        for (const entry of communityCentroidsRef.current) {
          const titleEntry = communityTextsRef.current.get(entry.community);
          if (!titleEntry) continue;
          const [x, y, z] = entry.position;
          titleEntry.text.position.set(x, y + COMMUNITY_TITLE_Y_OFFSET, z);
          titleEntry.chip.position.set(x, y + COMMUNITY_TITLE_Y_OFFSET, z - 0.05);
        }
      },
    }),
    // Position writes read only refs now (font sizing moved to the useFrame
    // refresh above), so the handle has no reactive dependencies left.
    [],
  );

  return <group ref={groupRef} />;
});
