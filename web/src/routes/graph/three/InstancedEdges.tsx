// One batched fat-line pass for every VISIBLE edge (deliverable 3 /
// reflexion critique item 1, extended by Deep-Field Observatory Phase 3 --
// plan Section 3.1 item 3 / Section 5.6 item 3 / Section 6 Phase 3): a
// single `LineSegmentsGeometry` (position + color + a per-instance width
// attribute), but hidden edges are actually removed from what's submitted to
// the GPU each frame via `geometry.instanceCount` clamped to the currently-
// visible edge count -- NOT merely recolored toward the background
// (recoloring alone doesn't reduce draw cost; this is
// `InstancedBufferGeometry`'s own instance-count mechanism, the fat-line
// analog of the pre-Phase-3 `setDrawRange` cull). Positions are rewritten
// each tick via `applyPositions`, and that rewrite is O(visible edges),
// never O(all edges): it walks a precomputed `visibleEdgesRef` list and
// looks each endpoint's position up in an `idIndexMap` (an O(1) Map rebuilt
// only when the worker's node ordering changes -- i.e. once per data
// change, not once per tick), rather than building a fresh id->position Map
// on every worker tick.
//
// Deep-Field Observatory Phase 3: this replaces the pre-Phase-3
// `LineBasicMaterial`/plain `LineSegments`/`BufferGeometry` 1px-only pass
// with three's own fat-line technique (`LineSegments2`/`LineSegmentsGeometry`/
// `LineMaterial`, `three/examples/jsm/lines/*` -- the plan's Section 5.7
// permitted-variation choice over drei's `Line` wrapper, since this
// directory's node/edge layer already talks to plain `three` objects
// directly, never drei components, for the procedural render path) so a
// served `edge.weight` can drive both WIDTH (via `edgeLineShader.ts`'s
// `instanceWidth` per-instance patch) and OPACITY (via `edgeLineShader.ts`'s
// `instanceOpacity`/`vOpacity` per-instance patch -- genuine alpha, see the
// VERIFICATION_NEEDS_FIX remediation note below) -- STILL one batched draw
// call, per Section 5.6 item 3's invariant ("width/opacity encode weight
// independently"). `LineSegments2` also keeps the `LineMaterial.resolution`
// uniform in sync with the live renderer viewport automatically on every
// render (`LineSegments2.onBeforeRender`, confirmed by direct source read of
// the installed `three@0.169` -- see edgeLineShader.test.ts's dedicated
// regression test) -- the class of gotcha Section 11 flags for fatline
// shaders (a stale/never-updated `resolution` uniform) is handled by
// three's own object, not hand-wired here.
//
// VERIFICATION_NEEDS_FIX remediation (T2 remediation cycle 1, both findings
// confirmed via source reading alone):
//
// Fix 1 (blocker) -- stale frustum-culling bounds: `LineSegmentsGeometry.
// setPositions` (called below with all-zero placeholder data at
// GPU-buffer-allocation time) EAGERLY computes the bounding box/sphere from
// whatever data it's given, locking in a degenerate origin-centered,
// radius-0 sphere. `applyPositions` mutates `instanceStart`/`instanceEnd`
// per tick but never recomputes that bound, and three's own frustum test
// (`Frustum.intersectsObject`, `Frustum.js`) only calls
// `geometry.computeBoundingSphere()` when `boundingSphere` is `null` -- so
// the stale bound would otherwise permanently govern this object's
// visibility, independent of where the actual graph is. Fixed by disabling
// `frustumCulled` entirely on the single batched `line2` object below: there
// is only ever ONE such object for the whole edge set, so per-object frustum
// culling buys nothing, and this removes the whole defect class rather than
// requiring a bounding-volume recompute on every tick.
//
// Fix 2 (major) -- weight-to-opacity encoding was inverted in light theme:
// the original implementation faked per-edge "opacity" by blending the
// vertex color toward a hardcoded BLACK constant, which reads correctly in
// dark theme (`--graph-bg` near-black) but is BACKWARD in light theme
// (`--graph-bg` near-white in all four modes) -- a low-weight edge darkened
// toward black becomes MORE prominent against a light background, the
// opposite of the intended encoding. Fixed by threading weight-opacity
// through as GENUINE per-instance alpha (edgeLineShader.ts's
// `instanceOpacity`/`vOpacity` patch, multiplying the material's own
// `opacity` uniform in the fragment shader) instead -- correct against any
// background color/theme, with zero background-token coupling. The
// PRE-EXISTING selection/hover dim (`mixColor(base, BLACK, focusFadeT)`,
// present before this Phase 3 work) is untouched by this fix; only weight's
// contribution to that blend was removed.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Color, InstancedBufferAttribute, type InterleavedBufferAttribute } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { GraphColors } from "../../../lib/graph-colors";
import { edgeWeightFraction, edgeWeightToOpacity, edgeWeightToWidth } from "../edgeWeight";
import type { VizEdge, VizNode } from "../types";
import { patchEdgeLineMaterial } from "./edgeLineShader";

export interface InstancedEdgesHandle {
  /** `idIndexMap`: node id -> offset into `positions` (see Graph3DScene's per-revision cache). */
  applyPositions(positions: Float32Array, idIndexMap: Map<string, number>): void;
}

export interface InstancedEdgesProps {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleIds: Set<string>;
  colors: GraphColors;
  selectedId: string | null;
  hoveredId: string | null;
  neighborIds: Set<string>;
}

const BLACK = new Color(0, 0, 0);

function mixColor(base: Color, bg: Color, t: number): Color {
  return base.clone().lerp(bg, t);
}

export const InstancedEdges = forwardRef<InstancedEdgesHandle, InstancedEdgesProps>(function InstancedEdges(
  { nodes, edges, visibleIds, colors, selectedId, hoveredId, neighborIds },
  ref,
) {
  // The edges actually drawn this frame -- endpoints both in `visibleIds`.
  // Recomputed only on data/filter/selection change, never per tick.
  const visibleEdgesRef = useRef<VizEdge[]>([]);
  // Tracks the last capacity the GPU buffers were sized to, so a filter/
  // selection change (which never changes `edges.length`) never triggers a
  // reallocation -- only a genuine dataset change (new/removed edges) does.
  const capacityRef = useRef(0);

  const geometry = useMemo(() => new LineSegmentsGeometry(), []);
  const material = useMemo(() => {
    const m = new LineMaterial({ transparent: true, opacity: 0.9 });
    m.vertexColors = true;
    // Screen-space (pixel) width, matching the `--graph-edge-weight-width-*`
    // token values (1..4) and the pre-Phase-3 1px-only behavior -- see this
    // file's header and edgeLineShader.ts's header for why WORLD_UNITS is
    // unused. `worldUnits` already defaults to `false`; set explicitly here
    // to document the choice.
    m.worldUnits = false;
    m.linewidth = 1;
    patchEdgeLineMaterial(m);
    return m;
  }, []);
  const line2 = useMemo(() => {
    const line2 = new LineSegments2(geometry, material);
    // VERIFICATION_NEEDS_FIX Fix 1 (blocker): disable per-object frustum
    // culling entirely -- see this file's header for the full stale-bound
    // mechanism. There is only ever ONE batched edge object, so this costs
    // nothing structurally (no per-instance culling is lost; `instanceCount`
    // above already governs which edges submit at all) and removes the
    // whole defect class outright.
    line2.frustumCulled = false;
    return line2;
  }, [geometry, material]);

  useEffect(() => {
    const visible = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    visibleEdgesRef.current = visible;

    // Capacity sized to the max possible (all edges) so a filter toggle
    // never needs to reallocate the GPU buffer -- only `instanceCount` (and
    // the color/width attribute contents) change on visibility changes.
    const capacity = Math.max(1, edges.length);
    if (capacityRef.current !== capacity) {
      capacityRef.current = capacity;
      geometry.setPositions(new Float32Array(capacity * 6)); // start.xyz, end.xyz
      geometry.setColors(new Float32Array(capacity * 6)); // start.rgb, end.rgb
      geometry.setAttribute("instanceWidth", new InstancedBufferAttribute(new Float32Array(capacity), 1));
      // VERIFICATION_NEEDS_FIX Fix 2 (major): genuine per-instance alpha,
      // mirroring the instanceWidth attribute exactly -- see this file's
      // header and edgeLineShader.ts's header for why this replaced the
      // original color-blend-toward-BLACK "opacity" proxy.
      geometry.setAttribute("instanceOpacity", new InstancedBufferAttribute(new Float32Array(capacity), 1));
    }
    // Hidden edges are excluded from the instanced draw entirely -- this is
    // the actual cull (LineSegmentsGeometry's own `instanceCount`, the
    // fat-line analog of the pre-Phase-3 `setDrawRange` clamp), not a
    // recolor. GPU never processes instances past this count.
    geometry.instanceCount = visible.length;

    const colorStartAttr = geometry.getAttribute("instanceColorStart") as InterleavedBufferAttribute | undefined;
    const colorEndAttr = geometry.getAttribute("instanceColorEnd") as InterleavedBufferAttribute | undefined;
    const widthAttr = geometry.getAttribute("instanceWidth") as InstancedBufferAttribute | undefined;
    const opacityAttr = geometry.getAttribute("instanceOpacity") as InstancedBufferAttribute | undefined;

    const focused = selectedId !== null || hoveredId !== null;
    for (let i = 0; i < visible.length; i++) {
      const edge = visible[i];
      const isActive =
        focused &&
        (edge.source === selectedId ||
          edge.target === selectedId ||
          edge.source === hoveredId ||
          edge.target === hoveredId);
      const base = isActive ? colors.edgeActive.color : colors.edge.color;

      // Deep-Field Observatory Phase 3: weight drives width AND opacity
      // INDEPENDENTLY (plan Section 5.6 item 3). Both are real per-instance
      // shader attributes (edgeLineShader.ts's `instanceWidth`/
      // `instanceOpacity`) -- `edge.weight` flows straight through (never a
      // fabricated or defaulted number, J5-EDGE-WEIGHT) -- an absent weight
      // yields `fraction === null`, and both helpers fall back to their
      // token MIN (see edgeWeight.ts's documented rationale).
      const fraction = edgeWeightFraction(edge.weight);
      const width = edgeWeightToWidth(fraction, colors.edgeWeight);
      const weightOpacity = edgeWeightToOpacity(fraction, colors.edgeWeight);

      // The PRE-EXISTING selection/hover context dim -- unchanged from
      // before Phase 3, and unrelated to weight (VERIFICATION_NEEDS_FIX Fix
      // 2: weight no longer contributes to this color blend at all; it
      // drives genuine alpha via `opacityAttr` below instead).
      const focusFadeT = focused && !isActive ? 0.85 : 0;

      const c = mixColor(base, BLACK, focusFadeT);
      colorStartAttr?.setXYZ(i, c.r, c.g, c.b);
      colorEndAttr?.setXYZ(i, c.r, c.g, c.b);
      if (widthAttr) widthAttr.array[i] = width;
      if (opacityAttr) opacityAttr.array[i] = weightOpacity;
    }
    // `colorStartAttr`/`colorEndAttr` share one underlying interleaved
    // buffer (see LineSegmentsGeometry.setColors) -- flagging either is
    // sufficient to upload both.
    if (colorStartAttr) colorStartAttr.needsUpdate = true;
    if (widthAttr) widthAttr.needsUpdate = true;
    if (opacityAttr) opacityAttr.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, nodes, edges, colors, visibleIds, selectedId, hoveredId, neighborIds]);

  useImperativeHandle(
    ref,
    () => ({
      applyPositions(positions, idIndexMap) {
        const startAttr = geometry.getAttribute("instanceStart") as InterleavedBufferAttribute | undefined;
        const endAttr = geometry.getAttribute("instanceEnd") as InterleavedBufferAttribute | undefined;
        if (!startAttr || !endAttr) return;
        const visible = visibleEdgesRef.current;
        // O(visible edges), NEVER O(all edges): no Map allocation here --
        // `idIndexMap` is built once per worker revision by Graph3DScene.
        for (let i = 0; i < visible.length; i++) {
          const edge = visible[i];
          const srcIdx = idIndexMap.get(edge.source);
          const tgtIdx = idIndexMap.get(edge.target);
          if (srcIdx !== undefined) {
            startAttr.setXYZ(i, positions[srcIdx * 3], positions[srcIdx * 3 + 1], positions[srcIdx * 3 + 2]);
          }
          if (tgtIdx !== undefined) {
            endAttr.setXYZ(i, positions[tgtIdx * 3], positions[tgtIdx * 3 + 1], positions[tgtIdx * 3 + 2]);
          }
        }
        // `instanceStart`/`instanceEnd` share one underlying interleaved
        // buffer -- flagging either is sufficient to upload both.
        startAttr.needsUpdate = true;
      },
    }),
    [geometry],
  );

  return <primitive object={line2} />;
});
