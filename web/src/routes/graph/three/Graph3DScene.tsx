// R3F Canvas root for the 3D graph (deliverables 1/6/11): owns the
// ForceLayoutClient (Web-Worker-backed simulation), the single per-frame
// position-application pass (refs only), GPU/BVH picking dispatch, adaptive
// DPR, and camera focus/fit. NEVER calls setState from inside useFrame --
// discrete UI state (selected/hovered/filters) lives in GraphView.tsx and
// flows down as props; this file only mutates GPU-facing refs each frame.
import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, OrbitControls, PerformanceMonitor } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import type { BloomEffect, EffectComposer as EffectComposerImpl } from "postprocessing";
import { ACESFilmicToneMapping, FogExp2 } from "three";
import {
  lerpAtmosphereFog,
  readAtmosphereFogParams,
  readBloomMotionParams,
  readVignetteParams,
  type AtmosphereFogParams,
  type GraphColors,
} from "../../../lib/graph-colors";
import type { GraphMode, VizEdge, VizNode } from "../types";
import { neighborsOf } from "../graphMath";
import { prefersReducedMotion } from "../../../lib/motion";
import { useForceLayoutWorker } from "./useForceLayoutWorker";
import { InstancedNodes, type InstancedNodesHandle } from "./InstancedNodes";
import { InstancedEdges, type InstancedEdgesHandle } from "./InstancedEdges";
import { NodeLabels, type NodeLabelsHandle } from "./NodeLabels";
import { CommunityHulls } from "./CommunityHulls";
import { CommunityCentroidBadges } from "./CommunityCentroidBadges";
import { CameraRig, type GraphFitRequest } from "./CameraRig";
// Escalation remediation round 8 Fix B + round 9: mode-scoped,
// shape-ADAPTIVE padding scale for the WHOLE-GRAPH settle fit only --
// decided per settle from the live measured overestimate ratio; see the
// decision function's doc comment in modeForces.ts and
// cameraFitPaddingByteIdentity.test.ts for the safety proof. Selection
// fits never receive it.
import { orbitalSettleFitPaddingScale } from "./modeForces";
import { TerrainSurface } from "./TerrainSurface";
import {
  blendPositions,
  isTransitionActive,
  resolveChromeCrossfadeAlpha,
  startModeTransition,
  type ModeTransitionState,
} from "./modeTransition";
import { elevationPointsEqual, type ElevationPoint } from "./terrainElevation";
// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5): per-mode
// "atmosphere" chrome layer -- see ModeChrome.tsx's own header comment for
// why Terrain is intentionally excluded from this resolver (its chrome
// lives inside TerrainSurface.tsx itself, wired via the `colors` prop below).
import { renderModeChrome, resolveTerrainCrossfade } from "./ModeChrome";
import {
  bloomFadeDurationMs,
  bloomTargetIntensity,
  currentBloomIntensity,
  effectiveSafeTierLevel,
  safeTierFlags,
  startBloomFade,
  stepSafeTierLevel,
  SAFE_TIER_LEVEL_MIN,
  type BloomFadeState,
  type BloomFadeTrigger,
  type EffectsTier,
} from "./safeTier";

export interface BoundingSphereFit {
  center: [number, number, number];
  radius: number;
  /**
   * T2 remediation (Finding 1 -- Terrain camera-fit "thin sliver near the
   * horizon" bug at scale). Full per-axis world-space extent (max-min) of
   * the same points `center`/`radius` were computed from -- `[dx, dy, dz]`.
   * Optional so every pre-existing caller/test that only destructures
   * `center`/`radius` is unaffected. See `resolveFlatShapeElevation` in
   * `CameraRig.tsx` for why this additional per-axis data is needed: a
   * single isotropic radius cannot tell a roughly cube-shaped bounding
   * volume (any viewing direction frames it fine) apart from a flat,
   * pancake-shaped one (only an elevated viewing direction frames it
   * legibly) -- Terrain's bounding volume becomes exactly that flat shape
   * at scale, because its heightfield's y-range is a fixed constant
   * (`TERRAIN_MAX_HEIGHT`) while its x/z footprint grows with node count.
   */
  extent: [number, number, number];
  /**
   * Escalation remediation round 9 (Verifier's clipping reproduction at
   * small N). The TRUE maximum distance of any contributing node from
   * `center` -- measured from the same live positions in a second pass,
   * never estimated. `radius` (the AABB half-diagonal, floored at 8) is a
   * shape-dependent OVERESTIMATE of this value; the live ratio between the
   * two is what decides whether Orbital's settle fit may safely apply
   * `ORBITAL_SETTLE_FIT_PADDING_SCALE` (see `orbitalSettleFitPaddingScale`
   * in modeForces.ts). Optional so `SelectionFit`'s construction and every
   * pre-existing caller/test that only destructures `center`/`radius`/
   * `extent` is unaffected -- `computeBoundingSphere` itself always sets
   * it.
   */
  maxNodeDistance?: number;
}

/**
 * World-space bounding sphere (center + radius) of every currently-visible
 * node's latest tick position. Pure/exported so it can be exercised directly
 * against multiple graph shapes (see graphPerf.synthetic.test.ts's T2
 * remediation coverage) instead of only indirectly via source-regex
 * matching. Returns `null` when no visible node has a known position yet
 * (worker hasn't ticked, or every visible id fell out of the latest tick's
 * id set) -- callers simply skip issuing a fit request in that case, exactly
 * as before this extraction.
 *
 * `radius` is floored at 8 world units so a near-degenerate (near-zero-
 * extent) graph still gets a sane, non-zero fit distance instead of parking
 * the camera uncomfortably close (see `computeFitDistance` in CameraRig.tsx,
 * which is the actual scale-responsive half of the fit -- this floor only
 * guards the true-zero-extent edge case, it does not re-tune per shape).
 */
export function computeBoundingSphere(
  indexMap: Map<string, number>,
  positions: Float32Array,
  visibleIds: Set<string>,
): BoundingSphereFit | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let count = 0;
  for (const [id, idx] of indexMap) {
    if (!visibleIds.has(id)) continue;
    const x = positions[idx * 3];
    const y = positions[idx * 3 + 1];
    const z = positions[idx * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    count++;
  }
  if (count === 0) return null;
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const radius = Math.max(8, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2);
  // Round 9: second pass over the SAME contributing nodes for the true max
  // node distance from the center just computed (a two-pass necessity --
  // the AABB center is only known after the first pass). This is a
  // discrete, settle/selection-frequency path, never per-tick.
  let maxNodeDistanceSq = 0;
  for (const [id, idx] of indexMap) {
    if (!visibleIds.has(id)) continue;
    const ox = positions[idx * 3] - center[0];
    const oy = positions[idx * 3 + 1] - center[1];
    const oz = positions[idx * 3 + 2] - center[2];
    const distSq = ox * ox + oy * oy + oz * oz;
    if (distSq > maxNodeDistanceSq) maxNodeDistanceSq = distSq;
  }
  return { center, radius, extent: [dx, dy, dz], maxNodeDistance: Math.sqrt(maxNodeDistanceSq) };
}

/**
 * T2 remediation (bounded remediation, second and final attempt on the
 * residual edge-on-framing defect -- see `resolveFitViewDirection` in
 * `CameraRig.tsx` for the full root cause, evidence trail, and how this
 * value is consumed). Returns the dominant direction of a SMALL focus set
 * (at most 3 points) -- the pair among `ids` with the greatest pairwise
 * distance, as a raw (non-normalized) direction vector -- or `null` when
 * that is not a meaningful/safe computation to make: fewer than 2 resolved
 * points, or more than 3 points.
 *
 * Deliberately bounded to small sets: this app's canonical repro is exactly
 * a degree-1 node plus its single neighbor (2 points), and the finding's own
 * scope note explicitly allows "e.g. ~2-3 points" for this correction. An
 * all-pairs scan is O(n^2) and is intentionally NEVER run against a large
 * focus set -- the whole-graph fit path (`onEnd` below) never calls this
 * function at all, so a large/roomy focus set keeps the already-confirmed-
 * working general fit behavior (preserving the camera's existing viewing
 * direction) completely untouched.
 */
export function computeFocusAxis(
  indexMap: Map<string, number>,
  positions: Float32Array,
  ids: Set<string>,
): [number, number, number] | null {
  if (ids.size < 2 || ids.size > 3) return null;
  const pts: [number, number, number][] = [];
  for (const id of ids) {
    const idx = indexMap.get(id);
    if (idx === undefined) continue;
    pts.push([positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]]);
  }
  if (pts.length < 2) return null;

  let best: [number, number, number] | null = null;
  let bestDistSq = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[i][0];
      const dy = pts[j][1] - pts[i][1];
      const dz = pts[j][2] - pts[i][2];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > bestDistSq) {
        bestDistSq = distSq;
        best = [dx, dy, dz];
      }
    }
  }
  // Coincident points (near-zero extent) carry no meaningful direction --
  // let the caller fall back to no-axis-correction behavior.
  if (!best || bestDistSq < 1e-6) return null;
  return best;
}

export interface SelectionFit extends BoundingSphereFit {
  axis: [number, number, number] | null;
}

/**
 * T3 advisory remediation (the "Meridian Logistics" framing defect, H2/H3):
 * the ONE selection-scoped fit computation, shared by the selection effect
 * (fires on click) AND the worker settle handler (`onEnd`) below. Frames the
 * selected node plus its 1-hop neighbors via the same
 * `computeBoundingSphere`/`computeFocusAxis` machinery as before -- this
 * extraction changes no fit geometry, it exists so the two call sites can
 * never disagree about what a selection fit is, and so the computation is
 * directly testable (see selectionSettleFitPriority.test.ts) without a real
 * R3F `<Canvas>`/WebGL context, exactly like `computeBoundingSphere` above.
 *
 * Returns `null` when the selected id (and every neighbor) has no resolved
 * position yet -- the first tick is still pending, or the id is not in the
 * worker's dataset at all. The settle handler's selection-aware retry is the
 * designed fallback for that case (H3): a click-time miss is re-attempted on
 * "end", once positions exist, instead of silently never fitting.
 */
export function computeSelectionFit(
  indexMap: Map<string, number>,
  positions: Float32Array,
  edges: { source: string; target: string }[],
  selectedId: string,
): SelectionFit | null {
  const focusIds = neighborsOf({ nodes: [], edges }, selectedId);
  focusIds.add(selectedId);
  const fit = computeBoundingSphere(indexMap, positions, focusIds);
  if (fit === null) return null;
  const axis = computeFocusAxis(indexMap, positions, focusIds);
  return { center: fit.center, radius: fit.radius, extent: fit.extent, axis };
}

/**
 * T2 remediation (3D graph intermittent-collapse investigation, round 3):
 * true when a tick's `revision` is OLDER than the highest revision already
 * applied to GPU-facing state -- see `highestAppliedRevisionRef`'s doc
 * comment inside `SceneContents`'s `useForceLayoutWorker` call for the full
 * race this guards against. Pure/exported, like `computeBoundingSphere`
 * above, so it can be exercised directly (see `graphTickStaleness.test.ts`)
 * without needing a real R3F `<Canvas>`/WebGL context, which jsdom cannot
 * provide.
 */
export function isStaleTickRevision(revision: number, highestAppliedRevision: number): boolean {
  return revision < highestAppliedRevision;
}

/**
 * Verifier remediation cycle 2 (VERIFICATION_NEEDS_FIX, blocker): extracted
 * out of `SceneContents` specifically so its effect-ordering/dependency-
 * array TIMING (the actual defect class -- a structural source-regex test
 * cannot detect it, only a real render/commit-sequence test can) is
 * directly testable via `@testing-library/react`'s `renderHook`, without a
 * real WebGL `<Canvas>` -- none of this hook's own logic touches
 * R3F/Three.js APIs, matching this file's own established convention of
 * extracting pure/hook logic out of the R3F boundary specifically so it is
 * testable (see `computeBoundingSphere`/`isStaleTickRevision` above).
 *
 * Root cause of remediation cycle 1's residual bug: `SceneContents`'s
 * mode-change effect writes `outgoingModeRef.current` SYNCHRONOUSLY (a ref
 * mutation takes effect immediately) but only SCHEDULES `setTransitioning`
 * (React state does not apply until the next render/commit). Within the
 * SAME commit `mode` first changes away from `"terrain"`, this effect used
 * to ALSO require `transitioning` (state) to already read `true` before
 * deferring the clear -- but `transitioning` is still the stale `false`
 * from the render that just happened, so the deferral never engaged and
 * `terrainPoints` cleared immediately, one commit too early.
 *
 * Fix: depend ONLY on `outgoingModeRef.current` (the ref) for the DECISION
 * of whether to defer -- it is already synchronously correct by the time
 * this effect's callback actually runs (effects are always scheduled
 * strictly after the render/commit that triggered them, and the mode-change
 * effect that writes this ref is declared earlier in `SceneContents`, so it
 * always runs first within the same commit). `transitioning` remains a
 * DEPENDENCY (not a condition read in the body) purely so this effect
 * re-evaluates once more when the transition genuinely completes and
 * `outgoingModeRef.current` is cleared elsewhere (a ref mutation alone never
 * re-triggers an effect) -- traced end to end: start (ref set synchronously
 * in the SAME commit, this effect correctly defers), mid-fade (no change,
 * stays deferred), end (the ref is cleared synchronously BEFORE
 * `setTransitioning(false)` is even called, so by the time THAT state
 * change causes this effect to re-run, the ref already reads `null` and
 * clearing proceeds correctly, never left permanently stuck deferred).
 */
export function useTerrainPointsClearOnLeave(
  mode: GraphMode,
  outgoingModeRef: MutableRefObject<GraphMode | null>,
  transitioning: boolean,
  setTerrainPoints: Dispatch<SetStateAction<ElevationPoint[]>>,
): void {
  useEffect(() => {
    if (mode === "terrain") return;
    if (outgoingModeRef.current === "terrain") return;
    setTerrainPoints((prev) => (prev.length === 0 ? prev : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, transitioning, outgoingModeRef, setTerrainPoints]);
}

/**
 * T3-advised escalation remediation round 2 (plan Section 11 escalation
 * track; plan Section 5.6 item 6 "bloom safe-tier degradation"). Decides
 * whether `<EffectComposer>` is MOUNTED at all. Rationale: the composer
 * permanently holds full-resolution input/output render targets (plus the
 * bloom effect's own half-res targets) for as long as it is mounted --
 * standing GPU pressure in every mode, even while the safe-tier ladder has
 * bloom fully disabled. Gating on the ladder's own `flags.bloomEnabled`
 * (any level >= 1, which includes both Balanced and Minimal) reclaims those
 * targets exactly when bloom's steady-state effective intensity is 0.
 *
 * Two deliberate bounds:
 *  - The unmount is DELAYED by the ladder's own bloom fade duration (the
 *    same token-driven `suppressMs` the fade itself uses), so the existing
 *    150ms fade-to-zero completes on-screen before the composer disappears
 *    -- no mid-fade pop. Remount on recovery is immediate, so the fade-in
 *    has a composer to render through. (Reduced motion resolves the token
 *    to 0, collapsing the delay -- an instant swap, consistent with every
 *    other reduced-motion fade in this file.)
 *  - A mode TRANSITION's transient bloom suppression does NOT unmount the
 *    composer: tearing down and reallocating render targets on every 800ms
 *    transition would recreate the exact allocation churn this job removes.
 *
 * Disclosed trade (documented, deliberate): the purely decorative Vignette
 * rides inside the same composer, so it too disappears while bloom is
 *  safe-tier-disabled. Vignette is explicitly "never a state carrier"
 * (Section 5.6 item 6), and reclaiming the full-res targets in the crashing
 * mode is the whole point of this fix. Whether the swap is visually clean
 * (tone-mapping hand-back included -- the composer forces NoToneMapping on
 * the renderer while mounted and restores ACES on unmount) is flagged for
 * Browser Validator confirmation; jsdom cannot rasterize it.
 */
export function useComposerGate(bloomEnabled: boolean, getUnmountDelayMs: () => number): boolean {
  const [mounted, setMounted] = useState(bloomEnabled);
  // Ref-read so a new getter identity never restarts the timer (same
  // convention as `handlersRef` in useForceLayoutWorker).
  const getDelayRef = useRef(getUnmountDelayMs);
  getDelayRef.current = getUnmountDelayMs;
  useEffect(() => {
    if (bloomEnabled) {
      setMounted(true);
      return;
    }
    const id = window.setTimeout(() => setMounted(false), getDelayRef.current());
    return () => window.clearTimeout(id);
  }, [bloomEnabled]);
  return mounted;
}

/**
 * Returns a stable callback ref that disposes a detached instance --
 * needed because @react-three/postprocessing@2.19.1 never disposes the
 * underlying `postprocessing` composer on unmount (verified against the
 * installed dist: its unmount cleanups only remove passes and restore tone
 * mapping), so unmounting alone would strand the composer's full-res
 * render targets until nondeterministic GC -- the opposite of what the
 * gate above exists to do.
 *
 * The dispose is DEFERRED by one microtask, cancelled if the SAME instance
 * re-attaches first: React 18 StrictMode's dev-mode effect double-invoke
 * detaches and synchronously re-attaches the same memo-preserved composer
 * instance, and disposing it in that window would permanently empty its
 * internal pass list (the lib's `useMemo`-owned RenderPass is never
 * re-added), breaking dev rendering. A REAL unmount never re-attaches, so
 * the microtask disposes exactly once; a replacement instance attaching
 * (gate off/on cycle) does not cancel the old instance's dispose. See
 * `effectComposerGating.test.ts` for all three sequences.
 */
export function useDisposeOnDetach<T extends { dispose(): void }>(): (instance: T | null) => void {
  const attachedRef = useRef<T | null>(null);
  const pendingRef = useRef<{ instance: T; cancelled: boolean } | null>(null);
  return useCallback((instance: T | null) => {
    if (instance !== null) {
      if (pendingRef.current?.instance === instance) {
        pendingRef.current.cancelled = true;
        pendingRef.current = null;
      }
      attachedRef.current = instance;
      return;
    }
    const detached = attachedRef.current;
    attachedRef.current = null;
    if (!detached) return;
    const pending = { instance: detached, cancelled: false };
    pendingRef.current = pending;
    queueMicrotask(() => {
      if (!pending.cancelled) pending.instance.dispose();
      if (pendingRef.current === pending) pendingRef.current = null;
    });
  }, []);
}

/**
 * T3-advised escalation remediation round 2, Issue 2 (plan Section 5.1
 * J-CONTEXT-LOSS -- defense-in-depth crash recovery): how long the frame
 * stamp may sit still, while the canvas is unpaused and the tab visible,
 * before the frameloop is declared dead. Chosen at 5s: the longest
 * LEGITIMATE frame gap in that state is a heavy GC pause or first-use
 * shader-compile hitch (worst observed order: ~1-2s on weak hardware), so
 * 5s sits far above any healthy gap -- a false trigger would discard a
 * live 3D session -- while still surfacing the 2D fallback within ~5-6s of
 * a genuine silent freeze, against the previous behavior of NEVER
 * recovering. Polled once per second: the check is O(1), and 1s granularity
 * bounds worst-case detection latency at threshold + 1s.
 */
export const FRAMELOOP_STALL_THRESHOLD_MS = 5000;
export const FRAMELOOP_WATCHDOG_POLL_MS = 1000;

/**
 * Frameloop liveness watchdog, independent of the DOM `webglcontextlost`
 * event: the live-observed crash shape was a silently frozen canvas (last
 * frame still on screen, Terrain toggle still selected, NO context-lost
 * event, no 2D fallback) -- a GPU-process hang starves rAF entirely, so
 * neither of the two existing recovery triggers can ever see it. The stamp
 * is written refs-only inside the existing `useFrame` (this file's
 * "never setState in useFrame" invariant); THIS check runs on a
 * `window.setInterval` OUTSIDE the render loop (the same discrete-interval
 * convention the 800ms feeds use), firing the existing report()/
 * `onContextLost` path -- which is latched via `isGenuineContextLoss`, so
 * repeated or racing triggers are no-ops.
 *
 * Two legitimate-stall guards, both DEFERRING the stamp rather than merely
 * skipping the check (so returning from either state re-arms a full
 * threshold window instead of false-triggering on the first check back):
 *  - `paused` (GraphView's mounted-hidden tab excursion sets
 *    frameloop="never" -- rAF deliberately stopped);
 *  - `document.hidden` (browsers suspend rAF for hidden tabs).
 * After firing, the stamp is also reset so recovery is signalled once per
 * stall, not once per poll.
 *
 * T2 bounded remediation (Verifier finding): the interval's own
 * `document.hidden` deferral CANNOT be the only hidden-tab re-arm, because
 * browsers throttle/suspend background-tab interval callbacks (Chrome's
 * Intensive Timer Throttling clamps them to ~once per minute after 5
 * minutes hidden). After a long-backgrounded tab returns, the next poll may
 * be the FIRST callback in minutes: it sees `document.hidden === false`
 * against a stamp stale purely from throttling and would kick the user out
 * of a healthy 3D session. The PRIMARY re-arm is therefore a
 * `visibilitychange` listener -- an explicit lifecycle event browsers
 * deliver reliably even under heavy timer throttling -- which resets the
 * stamp synchronously on the hidden->visible transition, before any poll
 * can compare. (Per the HTML spec, `visibilityState` updates and the
 * `visibilitychange` dispatch happen in the same synchronous "update the
 * rendering" steps, so no poll callback can ever observe
 * `hidden === false` before this handler has run.) The interval's own
 * hidden-deferral remains as a redundant safeguard for polls that DO fire
 * while hidden.
 */
export function useFrameloopWatchdog(
  frameStampRef: MutableRefObject<number>,
  paused: boolean,
  onStall: () => void,
): void {
  const onStallRef = useRef(onStall);
  onStallRef.current = onStall;
  useEffect(() => {
    frameStampRef.current = performance.now();
    const rearmOnVisible = () => {
      if (document.visibilityState === "visible") {
        frameStampRef.current = performance.now();
      }
    };
    document.addEventListener("visibilitychange", rearmOnVisible);
    const id = window.setInterval(() => {
      const now = performance.now();
      if (paused || document.hidden) {
        frameStampRef.current = now;
        return;
      }
      if (now - frameStampRef.current >= FRAMELOOP_STALL_THRESHOLD_MS) {
        frameStampRef.current = now;
        onStallRef.current();
      }
    }, FRAMELOOP_WATCHDOG_POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", rearmOnVisible);
      window.clearInterval(id);
    };
  }, [paused, frameStampRef]);
}

/**
 * The render-loop error path React boundaries structurally cannot provide:
 * R3F's frame loop runs via requestAnimationFrame OUTSIDE React's render/
 * commit phase, so a throw there never reaches `WebglErrorBoundary` -- and
 * (verified against the installed @react-three/fiber@8.17.10 source, which
 * schedules the next rAF BEFORE rendering) it does not even stop the loop:
 * the canvas just silently stops updating while the stamp-bearing
 * subscribers may keep running. R3F v8's `<Canvas>` has no onError prop, so
 * the seam used instead is the renderer boundary itself: `onCreated` wraps
 * `gl.render` with this guard, which routes a throw -- whether from R3F's
 * automatic render or from any of the EffectComposer's internal per-pass
 * renders, all of which cross `renderer.render` -- to the same latched
 * report() recovery path, then rethrows so diagnostics stay visible.
 * (A throw in composer glue code that never crosses `renderer.render` is a
 * disclosed residual gap; the watchdog above covers full loop starvation.)
 */
export function wrapRenderWithRecovery<A extends unknown[], R>(
  render: (...args: A) => R,
  onRenderError: () => void,
): (...args: A) => R {
  return (...args: A) => {
    try {
      return render(...args);
    } catch (error) {
      onRenderError();
      throw error;
    }
  };
}

export interface Graph3DSceneProps {
  nodes: VizNode[];
  edges: VizEdge[];
  visibleIds: Set<string>;
  colors: GraphColors;
  selectedId: string | null;
  hoveredId: string | null;
  neighborIds: Set<string>;
  onHoverNode: (id: string | null) => void;
  onSelectNode: (id: string) => void;
  /**
   * Deselection (plan Section 5.1 J-FOCUS "clear"): wired to the Canvas's
   * `onPointerMissed`, which R3F fires only for a genuine click that hits
   * no mesh AND whose pointer travelled <= 2px since pointerdown (the
   * `delta <= 2` guard in @react-three/fiber's event layer) -- an
   * OrbitControls drag that happens to release over empty space can never
   * trigger it. Deliberately consumed at the outer Canvas level only, never
   * inside SceneContents: clearing a selection must not touch the fit-
   * request machinery (the selection-fit effect below early-returns on a
   * null `selectedId`, so the camera stays where it is).
   */
  onClearSelection?: () => void;
  /** Dev/test hook: called with each PerformanceMonitor fps sample -- never asserted as a hard budget (see graphPerf tests). */
  onFpsSample?: (fps: number) => void;
  /**
   * REQUIRED graceful-degradation floor (reflexion critique item 4): fired
   * on a `webglcontextlost` event OR a WebGL renderer creation failure, so
   * the caller (GraphView) can auto-switch to the 2D fallback WITHOUT
   * requiring the user to notice and click the manual toggle themselves.
   */
  onContextLost?: () => void;
  /**
   * T2 remediation (Finding 2c): fired every time the underlying `<Canvas>`
   * successfully (re-)creates its WebGL context -- i.e. on every mount,
   * including a manual "Switch to 3D" retry after a genuine context-loss
   * fallback. Lets the caller (GraphView) clear a stale context-loss
   * announcement once 3D has actually re-rendered, instead of leaving it
   * stuck on screen forever. Optional so every other caller (tests,
   * `ModeSpikeView`) is unaffected.
   */
  onReady?: () => void;
  /**
   * Phase 4a de-risking spike (plan Section 6.3), optional and additive:
   * selects the worker's per-mode force configuration and, on a change from
   * the previous mode, starts a bounded/interruptible matrix-interpolation
   * transition (M1) toward the new mode's live worker output. Omitted,
   * this prop defaults to "cloud" and every mode-transition/terrain code
   * path below stays fully inert -- byte-identical to this component's
   * pre-spike behavior, which is why `GraphView.tsx` (production, Phase 4c
   * territory) needs no change to keep working exactly as before.
   */
  mode?: GraphMode;
  /**
   * Phase 4c graph state-lifecycle fix (plan Section 3.3/6.5, Section 11's
   * risk-table mitigation): `true` while GraphView is mounted-hidden (a tab
   * excursion away from Graph). Stops the R3F render loop (`Canvas
   * frameloop="never"`) so a hidden canvas never keeps burning GPU frames,
   * without tearing down the worker, the WebGL context, or any scene state
   * -- `frameloop` flips back to `"always"` the instant this goes false
   * again, resuming exactly where it left off. Optional/defaults to
   * `false` so every other caller (tests, `ModeSpikeView`) is unaffected.
   */
  paused?: boolean;
  /**
   * Deep-Field Observatory Phase 4 (plan Section 5.1 IA: "a new
   * effects/quality control (Auto default / Full / Balanced / Minimal) ...
   * the single inspectable home of the safe-tier decision", owned/rendered
   * by GraphView.tsx). Optional/defaults to `"auto"` so every other caller
   * (tests, `ModeSpikeView`) is unaffected. See `safeTier.ts`'s
   * `effectiveSafeTierLevel` for the exact per-tier semantics.
   */
  effectsTier?: EffectsTier;
  /**
   * Fired whenever the RESOLVED safe-tier ladder level (0-4, combining this
   * `effectsTier` prop with the live `PerformanceMonitor`-driven auto level
   * this component owns internally) changes -- a discrete, low-frequency
   * event (never per-frame), matching `onFpsSample`'s own event-driven
   * convention. GraphView.tsx uses this to drive its aria-live
   * announcement text (`stepAnnouncement`/`tierChangeAnnouncement` in
   * `safeTier.ts`) without needing to own any of the ladder logic itself.
   */
  onSafeTierLevelChange?: (level: number) => void;
}

/** Catches synchronous WebGLRenderer-construction failures from `<Canvas>` (some
 *  browsers/drivers throw rather than firing `webglcontextlost`) and reports
 *  them the same way as a live context loss. */
class WebglErrorBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function SceneContents({
  nodes,
  edges,
  visibleIds,
  colors,
  selectedId,
  hoveredId,
  neighborIds,
  onHoverNode,
  onSelectNode,
  mode = "cloud",
  effectsTier = "auto",
  onSafeTierLevelChange,
  autoSafeTierLevel,
  frameStampRef,
}: Omit<Graph3DSceneProps, "onFpsSample"> & {
  /**
   * Deep-Field Observatory Phase 4: the live `PerformanceMonitor`-driven
   * ladder level, owned and bumped by the OUTER `Graph3DScene` component
   * (whose `<PerformanceMonitor onIncline/onDecline>` wraps `<Suspense>`
   * above this component, not inside it) -- threaded in as a plain prop
   * rather than being part of the public `Graph3DSceneProps` surface, since
   * it is a derived runtime value, not a caller-supplied input.
   */
  autoSafeTierLevel: number;
  /**
   * T3-advised escalation remediation round 2 (Issue 2): the frameloop
   * liveness stamp, owned by the OUTER `Graph3DScene` (which runs the
   * `useFrameloopWatchdog` interval against it, outside the render loop)
   * and written refs-only at the top of this component's existing
   * `useFrame` -- the "last committed frame" marker the watchdog compares
   * against. A derived runtime seam like `autoSafeTierLevel` above, not a
   * caller-supplied input.
   */
  frameStampRef: MutableRefObject<number>;
}) {
  const nodesHandleRef = useRef<InstancedNodesHandle>(null);
  const edgesHandleRef = useRef<InstancedEdgesHandle>(null);
  const labelsHandleRef = useRef<NodeLabelsHandle>(null);

  // T2 remediation (browser-audit item, pre-existing before the StrictMode
  // camera-fit fix): scroll-to-zoom produced zero camera change in both
  // prod and dev, on fresh loads, while drag-rotate -- wired by the exact
  // same `OrbitControls.connect()` call -- worked. Root cause traced into
  // `@react-three/drei`'s `OrbitControls` wrapper
  // (`node_modules/@react-three/drei/core/OrbitControls.js`): with no
  // explicit `domElement` prop, it resolves its listener target via
  // `domElement || events.connected || gl.domElement`, where
  // `events.connected` is only populated once R3F's own `<Canvas>` runs its
  // event-source layout effect -- a second, timing-dependent mount phase
  // distinct from (and racing against) this component's own `useEffect`
  // that calls `controls.connect(...)`. Reading `gl` directly via
  // `useThree` and pinning `domElement` on `<OrbitControls>` below removes
  // that indirection: the wheel/pointer listener always attaches to the
  // real, stable render canvas from the first connect, never to a
  // transitional or ambiguous target.
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  // id -> offset-into-`positions` cache, rebuilt only when the worker's
  // node ordering changes (`revision`) -- NOT once per tick (reflexion
  // critique item 2: this is what lets InstancedEdges.applyPositions stay
  // O(visible edges) without allocating a fresh Map every tick).
  const idIndexCacheRef = useRef<{ revision: number; map: Map<string, number> }>({
    revision: -1,
    map: new Map(),
  });

  // T2 remediation (3D graph intermittent-collapse investigation, round 3):
  // a monotonic staleness guard. `revision` increments once per worker
  // `init`/`update` (see forceLayout.worker.ts's `buildSimulation`); this
  // tracks the HIGHEST revision whose tick has actually been applied so far.
  // A single Worker's own `postMessage` stream is guaranteed FIFO by the
  // platform (ticks from one live worker can never arrive out of revision
  // order), so this guard is not needed to protect against that case. It
  // exists as defense-in-depth against a DIFFERENT, real platform subtlety:
  // `Worker.terminate()` stops the worker's own thread from producing
  // further messages, but does NOT retroactively cancel a message the
  // worker already posted before termination and that is already sitting in
  // the main thread's own task queue, undelivered -- so a message from an
  // already-disposed worker generation could, in principle, still reach
  // this handler after a newer generation's ticks have already been
  // applied. `useForceLayoutWorker`'s cleanup already unsubscribes this
  // callback from ITS OWN client before terminating (see that file), which
  // covers a clean unmount; this guard additionally covers the case of two
  // live `ForceLayoutClient`s sharing this same closure across a data/mode
  // re-init (`layout.init(...)` bumps `revision` without tearing down the
  // worker at all -- see `useForceLayoutWorker`'s second effect), where a
  // slow-to-arrive tick from the PRE-re-init revision must never be allowed
  // to overwrite positions already applied from the NEW revision. See
  // `graphTickStaleness.test.ts` for direct behavioral coverage using real
  // out-of-order async delivery (a `MessageChannel`-backed fake worker, not
  // the synchronous mock most of this route's other tests use).
  const highestAppliedRevisionRef = useRef(-1);

  // Zero-allocation position snapshot (Codex finding): a SINGLE reused flat
  // Float32Array, bulk-copied (`.set(positions)`) once per tick -- never a
  // fresh `[x, y, z]` tuple allocated per node per tick. Discrete (non-hot-
  // path) consumers -- selection focus, camera fit-to-graph, community hulls
  // -- read out of it via `positionsAccessorRef.current.get(id)`, which DOES
  // allocate a small tuple per call, but only on their own low-frequency
  // triggers (a selection change, an "end" event, an 800ms interval), never
  // once per tick/frame.
  const latestPositionsBufferRef = useRef<Float32Array>(new Float32Array(0));
  const positionsAccessorRef = useRef({
    get(id: string): [number, number, number] | undefined {
      const idx = idIndexCacheRef.current.map.get(id);
      if (idx === undefined) return undefined;
      const buf = latestPositionsBufferRef.current;
      return [buf[idx * 3], buf[idx * 3 + 1], buf[idx * 3 + 2]];
    },
  });

  const visibleIdsRef = useRef(visibleIds);
  visibleIdsRef.current = visibleIds;

  // T2 remediation (Finding 1): selection focus no longer routes through
  // CameraRig's `focusTarget` prop (see the selection effect below) -- it
  // reuses `fitRequest`'s scale-responsive bounding-sphere path instead.
  // `CameraRig` still accepts `focusTarget` (kept generic/available for a
  // future direct single-point-focus need), so `null` is passed through
  // unconditionally rather than removing the prop from CameraRig itself.
  const [fitRequest, setFitRequest] = useState<GraphFitRequest | null>(null);
  const fitNonceRef = useRef(0);

  // T3-advised escalation remediation: the whole-graph settle fit's per-axis
  // extent, REUSED by the Strata floor-plane chrome (`strataFloorRadius` in
  // perModeChromeGeometry.ts) so floor discs cover the real node XZ spread
  // instead of a fixed 200-unit constant -- never a second, independently-
  // aggregated measurement (Section 5.6's single-source discipline), and
  // never an input INTO the camera fit (read-only reuse of what
  // `computeBoundingSphere` already computed for it; Section 5.6 item 5's
  // "new chrome must not alter its extent/radius inputs" holds). Updated at
  // the same discrete, low-frequency settle event the fit itself uses;
  // retains its last value while a selection is active at settle (the graph-
  // wide spread is unchanged by selection), and is null only before the
  // first whole-graph settle, where the chrome falls back to the exact
  // pre-remediation fixed radius.
  const [graphExtent, setGraphExtent] = useState<[number, number, number] | null>(null);

  // Phase 4a de-risking spike (plan Section 6.3, bet 1): mode-switch
  // transition state. `prevModeRef` lets the effect below tell a REAL mode
  // change apart from every other reason this component re-renders; a
  // fresh transition is only started when `mode` actually changes, never on
  // mount (there is nothing to blend FROM yet) and never spuriously on an
  // unrelated prop update.
  const transitionRef = useRef<ModeTransitionState | null>(null);
  const prevModeRef = useRef<GraphMode>(mode);
  const blendedPositionsRef = useRef<Float32Array>(new Float32Array(0));
  const [terrainPoints, setTerrainPoints] = useState<ElevationPoint[]>([]);
  // T2 remediation (bounded investigation, plan Section 6.5 closeout
  // finding -- transient "jagged black/teal" artifact in ~1/5 Orbital ->
  // Cloud mode-switch attempts, see instancedNodesLod.test.ts for the full
  // root-cause evidence): a REACTIVE mirror of "a transition is in flight",
  // needed ONLY so InstancedNodes' LOD-rescale effect (prop-identity-keyed)
  // actually re-runs when a transition starts/ends -- `transitionRef` alone
  // (a ref) never triggers a re-render, so InstancedNodes would never see
  // the change. This is a discrete start/stop signal, set at most twice per
  // transition (never per-tick) -- never read inside the per-tick hot path
  // itself, which still reads `transitionRef.current` exactly as before.
  const [transitioning, setTransitioning] = useState(false);

  // Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.3
  // "Mode-transition cross-fade": "chrome/fog begin an 800ms easeOutCubic
  // cross-fade ... outgoing chrome fades down, incoming fades up"). Rides
  // the SAME `transitionRef`/`transitioning` signal above -- never a second,
  // independent transition system. `outgoingModeRef` records which mode's
  // chrome must keep rendering (fading OUT) alongside the new `mode`'s
  // chrome (fading IN) for the duration of the blend; `outgoingFogRef`
  // mirrors that same "old mode" for the fog-color/density lerp further
  // below. Both are set at the exact same point the position-blend
  // transition itself starts (the mode-change effect below), and cleared at
  // the exact same point that transition completes (the tick handler's
  // completion branch) -- one shared start/stop lifecycle, not a duplicated
  // one.
  const outgoingModeRef = useRef<GraphMode | null>(null);
  const outgoingFogRef = useRef<AtmosphereFogParams | null>(null);

  // Deep-Field Observatory Phase 5: the chrome cross-fade WEIGHT (0 = fully
  // outgoing, 1 = fully incoming). Unlike bloom's per-frame ref-mutated
  // intensity, chrome opacity is driven by ordinary REACT PROPS on
  // `CloudNebula`/`OrbitalChrome`/`StrataChrome` (each is a small, O(1)-scale
  // chrome layer, not a per-node hot path) -- so it is updated via
  // `setState` on the SAME coarse, non-per-frame interval convention this
  // directory already uses for other O(1) low-frequency recomputes
  // (`CommunityHulls`/`CommunityCentroidBadges`/`NodeLabels`' community
  // titles all poll every 800ms via `window.setInterval`, never inside
  // `useFrame`). At 50ms this still resolves ~16 discrete steps across the
  // 800ms envelope -- smooth enough for slow-moving atmospheric chrome
  // cross-fades, while remaining unambiguously OUTSIDE the node-count-bound
  // per-frame hot path the "never setState in useFrame" rule (Section 5.3
  // "Performance") targets.
  const [chromeAlpha, setChromeAlpha] = useState(1);
  useEffect(() => {
    if (!transitioning) {
      setChromeAlpha(1);
      return;
    }
    const id = window.setInterval(() => {
      setChromeAlpha(resolveChromeCrossfadeAlpha(transitionRef.current, performance.now()));
    }, 50);
    return () => window.clearInterval(id);
  }, [transitioning]);

  // Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section 5.3
  // "Safe-tier choreography" / Section 5.6 items 5-6). `safeTierLevel`
  // resolves the caller's `effectsTier` selection (Auto/Full/Balanced/
  // Minimal) against the live `PerformanceMonitor`-driven `autoSafeTierLevel`
  // the outer Graph3DScene component owns -- see `safeTier.ts`'s
  // `effectiveSafeTierLevel` for the exact per-tier semantics. `flags`
  // derives the four monotonic ladder steps from that single level
  // (bloom -> ambient freeze -> chrome -> LOD, Section 5.3).
  const safeTierLevel = effectiveSafeTierLevel(effectsTier, autoSafeTierLevel);
  const flags = safeTierFlags(safeTierLevel);

  // T3-advised escalation remediation round 2 (Issue 1): the composer is
  // only MOUNTED while the safe-tier ladder has bloom enabled -- see
  // `useComposerGate`'s doc comment for the full gating rationale (fade-
  // completion delay, transition exclusion, Vignette trade) and
  // `useDisposeOnDetach` for why the detached postprocessing instance must
  // be disposed explicitly (the library never frees its render targets).
  const composerMounted = useComposerGate(flags.bloomEnabled, () => readBloomMotionParams().suppressMs);
  const handleComposerDetach = useDisposeOnDetach<EffectComposerImpl>();

  // Reports the RESOLVED level upward on every discrete change (a manual
  // tier switch or an auto ladder step) -- never per frame -- so
  // GraphView.tsx can drive its own aria-live announcement text without
  // owning any ladder logic itself.
  const prevSafeTierLevelRef = useRef(safeTierLevel);
  useEffect(() => {
    if (prevSafeTierLevelRef.current === safeTierLevel) return;
    prevSafeTierLevelRef.current = safeTierLevel;
    onSafeTierLevelChange?.(safeTierLevel);
  }, [safeTierLevel, onSafeTierLevelChange]);

  // Bloom intensity: a ref-mutated, per-frame-eased value (Section 5.3
  // "Performance": "All fades run in the existing single frame loop via
  // refs/uniforms, never setState in useFrame") -- NEVER a React prop
  // re-render per frame. `bloomEffectRef` is the underlying `BloomEffect`
  // instance from `<Bloom ref={...}>` below; `bloomFadeRef` holds the
  // in-flight fade descriptor (or null before the first resolved target).
  const bloomEffectRef = useRef<BloomEffect>(null);
  const bloomFadeRef = useRef<BloomFadeState | null>(null);
  // Edge-detection refs for the trigger-selection effect just below --
  // mirrors `prevModeRef`'s "compare against the previous value, only act on
  // an ACTUAL change" convention.
  const prevTransitioningForBloomRef = useRef(transitioning);
  const prevBloomEnabledRef = useRef(flags.bloomEnabled);

  // Composes bloom suppression off the SAME `transitioning` signal
  // InstancedNodes' far-tier LOD suppression already reads (Section 5.6 item
  // 5), AND off the safe-tier ladder's own bloom step (Section 5.3 choreo
  // step 1) -- `bloomTargetIntensity` treats either suppressor as
  // unconditional (never additive/partial). A discrete, low-frequency effect
  // (fires on a transition edge, a safe-tier step, or a theme/token change),
  // never per-frame; the per-frame EASING toward whatever target this
  // starts is the existing `useFrame` hook further below.
  useEffect(() => {
    const now = performance.now();
    const target = bloomTargetIntensity(colors.bloom.intensity, transitioning, flags.bloomEnabled);
    const priorTarget = bloomFadeRef.current?.toIntensity;
    // Only start a NEW fade when the resolved target actually changed (or
    // there is no fade yet at all) -- guards the common case of an
    // unrelated dependency re-running this effect (e.g. a selection change
    // touching `colors` identity) with an unchanged target, which must
    // never reset an in-flight fade's progress.
    if (bloomFadeRef.current !== null && target === priorTarget) {
      prevTransitioningForBloomRef.current = transitioning;
      prevBloomEnabledRef.current = flags.bloomEnabled;
      return;
    }
    const current = bloomFadeRef.current !== null ? currentBloomIntensity(bloomFadeRef.current, now) : target;
    let trigger: BloomFadeTrigger = "none";
    if (transitioning !== prevTransitioningForBloomRef.current) {
      trigger = transitioning ? "transition-start" : "transition-end";
    } else if (flags.bloomEnabled !== prevBloomEnabledRef.current) {
      trigger = flags.bloomEnabled ? "safe-tier-up" : "safe-tier-down";
    }
    const motion = readBloomMotionParams();
    const durationMs = bloomFadeDurationMs(trigger, motion);
    bloomFadeRef.current = startBloomFade(current, target, now, durationMs);
    prevTransitioningForBloomRef.current = transitioning;
    prevBloomEnabledRef.current = flags.bloomEnabled;
  }, [transitioning, flags.bloomEnabled, colors.bloom.intensity]);

  useEffect(() => {
    if (prevModeRef.current === mode) return;
    // Deep-Field Observatory Phase 5: capture the OUTGOING mode (and its
    // token-driven fog params) BEFORE `prevModeRef` is overwritten below --
    // this is the one moment that old value is still available, and it is
    // what lets the chrome cross-fade keep rendering the LEAVING mode's
    // chrome (fading out) while the new mode's chrome fades in.
    const outgoingMode = prevModeRef.current;
    prevModeRef.current = mode;
    const snapshotIds = Array.from(idIndexCacheRef.current.map.keys());
    if (snapshotIds.length === 0) {
      // Nothing rendered yet (e.g. mode switched before the first tick) --
      // nothing to blend from, so the new mode's positions simply apply
      // directly once they arrive.
      transitionRef.current = null;
      return;
    }
    // Reduced-motion path (design handoff M1/deliverable 10): a
    // `durationMs` of 0 makes `transitionAlpha` resolve to 1 immediately
    // (see modeTransition.ts), i.e. an instant cross-fade with NO position
    // interpolation -- never auto-2D here specifically (GraphView already
    // owns the auto-2D-under-reduced-motion default at mount; this is the
    // "instant/cross-fade" alternative the design handoff also permits for
    // an in-session mode switch while already in 3D mode).
    const durationMs = prefersReducedMotion() ? 0 : undefined;
    const started = startModeTransition(
      snapshotIds,
      latestPositionsBufferRef.current,
      performance.now(),
      durationMs,
    );
    transitionRef.current = started;
    // Only a REAL (non-instant) blend window needs the LOD-suppression
    // mitigation -- the reduced-motion path resolves to alpha 1 immediately,
    // so there is no blend window during which a stale threshold could ever
    // be exceeded. The chrome/fog cross-fade shares this exact same
    // condition: reduced motion never sets `outgoingModeRef`/`outgoingFogRef`
    // at all, so `renderModeChrome`/the fog lerp below only ever see the
    // new mode -- an instant swap, matching Section 5.3's reduced-motion
    // requirement for free, with no separate branch needed.
    if (started.durationMs > 0) {
      outgoingModeRef.current = outgoingMode;
      outgoingFogRef.current = readAtmosphereFogParams(document.documentElement, outgoingMode);
      // Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix a):
      // resolve chromeAlpha's FADE-START value synchronously, in the exact
      // same tick this (real or interrupting) transition starts -- `started`
      // was just created with `startTime = performance.now()`, so this
      // resolves to (near) 0, the correct fade-in starting point. Without
      // this, `chromeAlpha` kept whatever value it last held (often 1, fully
      // opaque) until the polling interval effect below's FIRST 50ms tick,
      // which is a real reset-flash window -- and, on a rapid/interrupted
      // re-trigger (a second mode switch while `transitioning` was already
      // true), that polling effect never even RESTARTS (its dependency is
      // only `[transitioning]`, which does not change true -> true), so the
      // stale alpha would otherwise persist even longer.
      setChromeAlpha(resolveChromeCrossfadeAlpha(started, performance.now()));
    }
    setTransitioning(started.durationMs > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Verifier remediation cycle 2 (VERIFICATION_NEEDS_FIX, blocker): the
  // clearing DECISION is now owned by the extracted, directly-testable
  // `useTerrainPointsClearOnLeave` hook above (see its doc comment for the
  // full root-cause/fix trace) -- split out of what used to be one combined
  // effect specifically so its commit-timing could be exercised via
  // `@testing-library/react`'s `renderHook` (see
  // `graph3DSceneTerrainPointsClear.test.ts`) without needing a real WebGL
  // `<Canvas>`.
  useTerrainPointsClearOnLeave(mode, outgoingModeRef, transitioning, setTerrainPoints);

  // Terrain surface feed (bet 2): rebuilt on the SAME low-frequency
  // interval `CommunityHulls.tsx` already uses for its own coarse,
  // non-per-tick recompute -- never inside the per-tick path above. Only
  // POPULATES while `mode === "terrain"`; clearing on leave is the separate
  // hook above.
  useEffect(() => {
    if (mode !== "terrain") return;
    const id = window.setInterval(() => {
      const points: ElevationPoint[] = [];
      for (const node of nodes) {
        if (!visibleIdsRef.current.has(node.id)) continue;
        const pos = positionsAccessorRef.current.get(node.id);
        if (!pos) continue;
        points.push({ x: pos[0], z: pos[2], weight: node.centrality ?? 0.1 });
      }
      // Functional bail-out (T2 escalation, Terrain context-loss job): once
      // the layout has settled, this freshly built array is content-identical
      // to the previous one -- returning `prev` keeps the same reference, so
      // React bails out of the re-render and TerrainSurface's grid/geometry
      // memos are never invalidated (no rebuild, no dispose churn). While
      // physics is moving, positions differ and the update proceeds exactly
      // as before.
      setTerrainPoints((prev) => (elevationPointsEqual(prev, points) ? prev : points));
    }, 800);
    return () => window.clearInterval(id);
  }, [mode, nodes]);

  // Worker lifecycle (T2 remediation root-cause fix -- see the T2 job
  // report, and `graphPerf.synthetic.test.ts`'s "worker lifecycle survives
  // React 18 StrictMode's dev-mode double-invoke" describe block for the
  // dedicated StrictMode regression coverage -- there is no separate
  // `useForceLayoutWorker.strictmode.test.tsx` file): delegated entirely to
  // `useForceLayoutWorker`, which creates AND disposes the Worker inside a
  // single effect (never `useMemo`) so React 18 StrictMode's dev-mode
  // mount -> cleanup -> remount dance always ends up with a live Worker,
  // never a wrapper around one it already terminated. `nodes`/`edges` here
  // are the FULL dataset GraphView owns (not the disclosed/rendered subset
  // below), so toggling a filter or expanding a node's neighbors never
  // restarts the physics simulation.
  useForceLayoutWorker(nodes, edges, {
    onTick: (positions, ids, _alpha, revision, layout) => {
      // Staleness guard (see `highestAppliedRevisionRef`'s doc comment
      // above): a tick from an OLDER generation than the newest one already
      // applied is discarded outright -- still handed back to its OWN
      // worker for recycling (a no-op if that worker is already
      // terminated), but never applied to any GPU-facing state, the
      // id-index cache, or the position snapshot.
      if (isStaleTickRevision(revision, highestAppliedRevisionRef.current)) {
        layout.releaseBuffer(positions.buffer as ArrayBuffer);
        return;
      }
      highestAppliedRevisionRef.current = revision;

      const cache = idIndexCacheRef.current;
      if (cache.revision !== revision) {
        const map = new Map<string, number>();
        for (let i = 0; i < ids.length; i++) map.set(ids[i], i);
        idIndexCacheRef.current = { revision, map };
      }

      // Phase 4a spike (bet 1, M1): while a mode-switch transition is in
      // flight, blend the raw worker output toward it instead of applying
      // it directly. `positions` itself is UNCHANGED either way -- this
      // never mutates the worker's own transferable buffer, only reads
      // from it into the (reused) blended buffer -- so releasing it back
      // to the worker below is unaffected.
      let applied = positions;
      const transition = transitionRef.current;
      if (transition) {
        const now = performance.now();
        if (isTransitionActive(transition, now)) {
          let blended = blendedPositionsRef.current;
          if (blended.length !== positions.length) {
            blended = new Float32Array(positions.length);
            blendedPositionsRef.current = blended;
          }
          blendPositions(transition, ids, positions, now, blended);
          applied = blended;
        } else {
          transitionRef.current = null;
          // Discrete, once-per-transition completion event (see the
          // `transitioning` state's doc comment above) -- this branch only
          // executes on the single tick where the blend actually finishes,
          // never on every tick, since `transition` is read from
          // `transitionRef.current` and is nulled out immediately above.
          setTransitioning(false);
          // Deep-Field Observatory Phase 5: the SAME completion event clears
          // the chrome/fog cross-fade's "outgoing mode" bookkeeping -- one
          // shared start/stop lifecycle with the position blend above, never
          // a second, independently-timed completion signal.
          outgoingModeRef.current = null;
          outgoingFogRef.current = null;
        }
      }

      nodesHandleRef.current?.applyPositions(applied, ids);
      edgesHandleRef.current?.applyPositions(applied, idIndexCacheRef.current.map);
      labelsHandleRef.current?.applyPositions(applied, ids);

      // Bulk copy into the single reused buffer -- ZERO per-node allocation
      // (Codex finding: this used to allocate a fresh per-node position
      // tuple keyed by id on every tick).
      let buf = latestPositionsBufferRef.current;
      if (buf.length !== applied.length) {
        buf = new Float32Array(applied.length);
        latestPositionsBufferRef.current = buf;
      }
      buf.set(applied);

      layout.releaseBuffer(positions.buffer as ArrayBuffer);
    },
    // Camera fit-to-graph (Issue 2, BLOCKING): once the worker's layout
    // settles (`onEngineStop` -- the simulation's own "end" event, fired
    // when alpha decays below its threshold), compute the bounding sphere
    // of the currently-rendered (disclosed/visible) nodes and frame the
    // camera to fit it. Fires again whenever `layout.init`/`update`
    // restarts the sim (dataset change), so a data reload always re-fits
    // too. This is a discrete, low-frequency event handler -- NOT part of
    // the per-tick path. Also fires on every mode switch (M3): the mode
    // change reinitializes the worker, which reliably reaches a fresh
    // "end" once the new mode's physics settles, reusing this exact path
    // rather than a mode-specific camera re-fit.
    onEnd: () => {
      // Settle-fit vs selection-fit sequencing (T3 advisory H2): this
      // handler and the selection effect below share one
      // `fitNonceRef`/`setFitRequest` with no ordering guarantee, so a
      // late-arriving settle event (the sim still cooling when the user
      // clicked) used to stomp an active user-selection fit with a
      // whole-graph fit -- the observed "reverted to whole-graph view"
      // failure shape. While a node is selected, the settle event now
      // re-issues the SELECTION fit with the freshly settled positions
      // (strictly better than suppressing: post-settle positions have
      // moved, and a mode switch's own settle re-fit keeps honoring the
      // framed camera target, per journey 1). This is also the designed H3
      // retry: a click that landed before the first tick (no position yet,
      // `computeSelectionFit` returned null) gets its fit here instead of
      // silently never fitting. The whole-graph fit still runs when nothing
      // is selected, or when the selection has no resolvable position at
      // all (an id outside the worker's dataset) -- a whole-graph frame
      // beats no frame. The `selectedId`/`edges` props read here are always
      // current: `useForceLayoutWorker` re-reads its handlers object per
      // event via `handlersRef`, never a mount-time closure.
      if (selectedId) {
        const selectionFit = computeSelectionFit(
          idIndexCacheRef.current.map,
          latestPositionsBufferRef.current,
          edges,
          selectedId,
        );
        if (selectionFit) {
          fitNonceRef.current += 1;
          setFitRequest({
            center: selectionFit.center,
            radius: selectionFit.radius,
            nonce: fitNonceRef.current,
            axis: selectionFit.axis,
            extent: selectionFit.extent,
          });
          return;
        }
      }
      const fit = computeBoundingSphere(
        idIndexCacheRef.current.map,
        latestPositionsBufferRef.current,
        visibleIdsRef.current,
      );
      if (!fit) return;
      // Chrome-layer reuse only (see `graphExtent`'s doc comment above) --
      // recorded BEFORE the fit request purely because this is the one spot
      // the whole-graph extent already exists; it feeds nothing back into
      // the fit itself.
      setGraphExtent(fit.extent);
      fitNonceRef.current += 1;
      // Round-8 Fix B + round-9 adaptive gate: `paddingScale` is the ONE
      // mode-scoped input this whole-graph settle fit adds --
      // center/radius/extent stay the truthful, unscaled bounding-sphere
      // values (never pre-scaled upstream), and the two selection-fit
      // request sites above/below never carry this field. The scale is
      // decided PER SETTLE from this settle's own live measured
      // radius/max-node-distance ratio (round 9: a blanket scale provably
      // clipped small/sparse datasets, whose ratio sits at ~1.0); see
      // `orbitalSettleFitPaddingScale` (modeForces.ts) for the decision
      // math and no-clip proof.
      setFitRequest({
        center: fit.center,
        radius: fit.radius,
        nonce: fitNonceRef.current,
        extent: fit.extent,
        paddingScale:
          mode === "orbital"
            ? orbitalSettleFitPaddingScale(fit.radius, fit.maxNodeDistance)
            : undefined,
      });
    },
  }, mode);

  // Deep-Field Observatory Phase 5 (plan Section 5.3 "Mode-transition
  // cross-fade": "fog color/density interpolating"): one `FogExp2` instance,
  // created once and assigned to `scene.fog`, mutated in place every frame
  // below -- never replaced/recreated per frame, and never a React prop
  // (matching bloom's own `bloomEffectRef` convention exactly). Restores
  // whatever `scene.fog` held before on cleanup, same "only clear if we're
  // still the one that set it" discipline `TerrainEnvironment.tsx` already
  // uses for `scene.background`.
  const sceneFogRef = useRef<FogExp2 | null>(null);
  useEffect(() => {
    const fog = new FogExp2(colors.atmosphereFog.color.color.getHex(), colors.atmosphereFog.density);
    const previousFog = scene.fog;
    scene.fog = fog;
    sceneFogRef.current = fog;
    return () => {
      if (scene.fog === fog) {
        scene.fog = previousFog ?? null;
      }
      sceneFogRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  useFrame(() => {
    // T3-advised escalation remediation round 2 (Issue 2): the frameloop
    // liveness stamp -- a ref mutation only (never setState in useFrame),
    // read by the outer component's `useFrameloopWatchdog` interval.
    frameStampRef.current = performance.now();

    // Positions are applied from the worker's "tick" event, not from this
    // hook -- this useFrame exists only as the documented "R3F owns the
    // render loop" seam.
    //
    // Deep-Field Observatory Phase 4 (Section 5.3 "Performance": "All fades
    // run in the existing single frame loop via refs/uniforms, never
    // setState in useFrame"): eases the live bloom intensity toward whatever
    // target the effect above last started a fade toward, and writes it
    // straight onto the underlying BloomEffect instance -- a ref mutation,
    // never a React prop/state update, so this never re-renders.
    if (bloomFadeRef.current && bloomEffectRef.current) {
      bloomEffectRef.current.intensity = currentBloomIntensity(bloomFadeRef.current, performance.now());
    }

    // Deep-Field Observatory Phase 5 (Section 5.3 "fog color/density
    // interpolating"): the SAME refs-only, per-frame discipline as bloom
    // above -- while a transition is in flight (`outgoingFogRef` set),
    // lerp between the outgoing and incoming mode's fog params by the
    // eased transition alpha; otherwise (settled, or reduced motion, which
    // never populates `outgoingFogRef`) resolve directly to the current
    // mode's fog, matching Section 5.3's "instant chrome swap" reduced-
    // motion requirement with no separate branch.
    if (sceneFogRef.current) {
      const incoming = colors.atmosphereFog;
      const outgoing = outgoingFogRef.current;
      const resolved = outgoing
        ? lerpAtmosphereFog(outgoing, incoming, resolveChromeCrossfadeAlpha(transitionRef.current, performance.now()))
        : incoming;
      sceneFogRef.current.color.copy(resolved.color.color);
      sceneFogRef.current.density = resolved.density;
    }
  });

  // Camera focus on selection (T2 remediation, Finding 1 -- live-Chrome
  // finding: selecting ANY node zoomed the camera in far beyond any legible
  // framing, leaving only a giant overlapping label sprite on screen).
  // ROOT CAUSE: this effect used to call `setFocusTarget(pos)`, handing
  // CameraRig a raw node position that it then framed with a FIXED `z + 6`
  // offset (see CameraRig.tsx's `focusTarget` effect) -- a constant six
  // world-units regardless of the graph's actual scale. `computeFitDistance`
  // (CameraRig.tsx) treats even 20 world units as its MINIMUM legible
  // distance for a near-zero-radius graph, and real settled layouts commonly
  // need hundreds; a fixed 6-unit offset parks the camera essentially INSIDE
  // the selected node, well inside its own label sprite, with the node and
  // its neighbors entirely outside the view frustum.
  //
  // Fix: reuse the EXACT SAME bounding-sphere-plus-computeFitDistance
  // machinery the whole-graph fit-to-load path already uses
  // (`computeBoundingSphere` above / `computeFitDistance` in CameraRig.tsx),
  // scoped to the selected node PLUS its immediate (1-hop) neighbors --
  // never a new, independently-tuned distance formula. This is a DISCRETE
  // state transition (fires once per selection change, not per frame) --
  // not the "never setState in useFrame" hot path. Neighbors are computed
  // from `edges` (the FULL dataset, not the hover-sensitive `neighborIds`
  // prop, which tracks `hoveredId ?? selectedId` and would report the
  // WRONG node's neighbors while hovering a different node than the one
  // selected) via the same `neighborsOf` helper GraphView already uses for
  // progressive-disclosure expansion. Positions are read out of the
  // zero-allocation buffer above via `idIndexCacheRef`/
  // `latestPositionsBufferRef` (the same buffers `computeBoundingSphere`
  // already reads for the whole-graph fit), so a neighbor that hasn't
  // rendered yet (outside the progressive-disclosure cap) still has a
  // valid position -- the worker always simulates the FULL dataset,
  // regardless of what's currently disclosed/visible.
  useEffect(() => {
    if (!selectedId) return;
    // `computeSelectionFit` = the selected node's 1-hop neighborhood framed
    // through the same bounding-sphere path as the whole-graph fit, plus the
    // small-focus-set axis correction (see its doc comment above, and
    // `resolveFitViewDirection` in `CameraRig.tsx` for how `axis` -- `null`
    // for a large/roomy set -- is consumed). A `null` fit means no position
    // has resolved yet (first tick pending): the settle handler's
    // selection-aware branch (`onEnd` above) retries this exact fit once
    // positions exist, so returning without a fit here is a deferral, not a
    // silent drop (T3 advisory H3).
    const fit = computeSelectionFit(
      idIndexCacheRef.current.map,
      latestPositionsBufferRef.current,
      edges,
      selectedId,
    );
    if (!fit) return;
    fitNonceRef.current += 1;
    setFitRequest({
      center: fit.center,
      radius: fit.radius,
      nonce: fitNonceRef.current,
      axis: fit.axis,
      extent: fit.extent,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Issue 3a (BLOCKING, GPU-footprint/context-loss hardening): only the
  // DISCLOSED/visible subset (bounded by GraphView's progressive-disclosure
  // cap + expanded neighbors) is ever pushed into the InstancedMesh2/edge
  // buffers/label layer -- the full 10k/50k `nodes`/`edges` above stay
  // reserved for the (off-main-thread) physics worker only. This is what
  // actually keeps GPU instance/buffer counts bounded regardless of total
  // dataset size, instead of relying solely on a per-instance `visible`
  // flag (which still allocated GPU-side storage for every node).
  const renderedNodes = useMemo(() => nodes.filter((n) => visibleIds.has(n.id)), [nodes, visibleIds]);
  const renderedEdges = useMemo(
    () => edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds],
  );

  // Deep-Field Observatory Phase 4 (plan Section 3.1 item 4: "selective
  // bloom plus vignette"): re-read only on a `colors` identity change (a
  // theme flip), matching every other discrete, non-per-frame token read in
  // this component -- never per frame.
  const vignette = useMemo(() => readVignetteParams(), [colors]);

  // Deep-Field Observatory Phase 5 (plan Section 3.1 item 5): community/
  // level counts for the Orbital ring/Strata floor-plane chrome -- computed
  // over the FULL `nodes` dataset (never the visible-filtered
  // `renderedNodes`), mirroring `forceLayout.worker.ts`'s own
  // `communityCount`/`levelCount` derivation exactly, so ring radii/floor
  // heights always agree with wherever the worker's physics actually placed
  // that shell/level -- never a second, independently-scoped count.
  const communityCount = useMemo(() => 1 + nodes.reduce((max, n) => Math.max(max, n.community ?? 0), 0), [nodes]);
  const levelCount = useMemo(() => 1 + nodes.reduce((max, n) => Math.max(max, n.level ?? 0), 0), [nodes]);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={0.7} />
      <InstancedNodes
        ref={nodesHandleRef}
        nodes={renderedNodes}
        visibleIds={visibleIds}
        colors={colors}
        selectedId={selectedId}
        hoveredId={hoveredId}
        neighborIds={neighborIds}
        onHoverNode={onHoverNode}
        onSelectNode={onSelectNode}
        fit={fitRequest}
        transitionActive={transitioning}
        safeTier={flags.lodDropped}
      />
      <InstancedEdges
        ref={edgesHandleRef}
        nodes={renderedNodes}
        edges={renderedEdges}
        visibleIds={visibleIds}
        colors={colors}
        selectedId={selectedId}
        hoveredId={hoveredId}
        neighborIds={neighborIds}
      />
      <NodeLabels
        ref={labelsHandleRef}
        nodes={renderedNodes}
        colors={colors}
        selectedId={selectedId}
        hoveredId={hoveredId}
        positionsRef={positionsAccessorRef}
      />
      <CommunityHulls nodes={renderedNodes} visibleIds={visibleIds} colors={colors} positionsRef={positionsAccessorRef} />
      {/* Deep-Field Observatory Phase 2 (plan Section 5.9 Decision A --
          APPROVED): the O(tens) community-centroid glyph/badge chrome layer,
          rendered unconditionally like CommunityHulls above so it covers all
          four modes (Cloud/Orbital/Strata/Terrain) identically. */}
      <CommunityCentroidBadges
        nodes={renderedNodes}
        visibleIds={visibleIds}
        colors={colors}
        positionsRef={positionsAccessorRef}
      />
      {/* Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, major, Fix b):
          Terrain now participates in the SAME incoming/outgoing cross-fade
          lifecycle as Cloud/Orbital/Strata below, via the pure
          `resolveTerrainCrossfade` resolver -- never a hard mount/unmount
          boundary. `terrainPoints` itself is kept from being prematurely
          cleared while Terrain is still fading out (see the terrain-points
          effect above), so the outgoing surface fades its ACTUAL last shape,
          not an empty/flat heightfield. */}
      {(() => {
        const terrainCrossfade = resolveTerrainCrossfade(mode, outgoingModeRef.current, transitioning, chromeAlpha);
        return terrainCrossfade.visible ? (
          <TerrainSurface points={terrainPoints} colors={colors} opacity={terrainCrossfade.opacity} />
        ) : null;
      })()}
      {/* Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section
          5.3 "Mode-transition cross-fade"): the incoming (current) mode's
          atmosphere chrome, always at full weight outside a transition.
          While a transition is in flight, the OUTGOING mode's chrome (see
          `outgoingModeRef` above) renders alongside it, fading down as this
          one fades up -- both driven by the same `chromeAlpha` state.
          Terrain is intentionally excluded from this resolver (see
          `ModeChrome.tsx`'s header comment); its chrome lives inside the
          `<TerrainSurface>` mount above. */}
      {renderModeChrome({
        mode,
        colors,
        opacity: chromeAlpha,
        nodes: renderedNodes,
        communityCount,
        levelCount,
        graphExtent,
      })}
      {transitioning && outgoingModeRef.current
        ? renderModeChrome({
            mode: outgoingModeRef.current,
            colors,
            opacity: 1 - chromeAlpha,
            nodes: renderedNodes,
            communityCount,
            levelCount,
            graphExtent,
          })
        : null}
      <CameraRig focusTarget={null} fitRequest={fitRequest} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} enableZoom domElement={gl.domElement} />
      {/* Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section
          5.9 Decision B -- APPROVED, @react-three/postprocessing v2.19.1):
          bounded, half-resolution, emissive-driven, token-thresholded
          selective bloom plus a purely decorative vignette. Bloom's own
          `intensity` prop below is its LAST-RESOLVED discrete value only --
          the actual per-frame easing is a ref mutation on `bloomEffectRef`
          inside the `useFrame` hook above, never a React re-render; this
          JSX prop only seeds the initial/next-discrete value the library
          itself reads at (re)construction. `mipmapBlur={false}` plus
          `resolutionScale` honors "half-resolution" literally (Section 5.6
          item 6) -- the library's own newer default (`mipmapBlur={true}`,
          using `radius`) is a mutually exclusive alternate blur backend in
          this version; `radius` is still passed through token-driven below,
          though under the classic backend it may be visually inert (see the
          JOB_DONE report's disclosed limitation). Vignette is purely
          decorative atmosphere, never a state carrier (Section 5.6 item 6)
          and NOT part of the safe-tier ladder (only bloom is). */}
      {/* T3-advised escalation remediation round 2 (Issue 1): mounted only
          while safe-tier bloom is enabled -- see `useComposerGate` above.
          The ref routes through `useDisposeOnDetach` so the postprocessing
          composer's full-res render targets are genuinely freed on unmount
          (the library itself never disposes them). */}
      {composerMounted ? (
        <EffectComposer ref={handleComposerDetach} enableNormalPass={false}>
          <Bloom
            // @react-three/postprocessing@2.19.1's own generated Bloom.d.ts
            // mistypes its ref as `RefAttributes<typeof BloomEffect>` (the
            // CLASS/constructor type) rather than the actual runtime instance
            // it forwards -- a known upstream typing looseness, not a runtime
            // issue (`bloomEffectRef.current` below is genuinely a live
            // `BloomEffect` instance with a settable `.intensity`). Isolated
            // to this single prop boundary, not spread anywhere else.
            ref={bloomEffectRef as unknown as import("react").Ref<typeof BloomEffect>}
            intensity={bloomFadeRef.current ? currentBloomIntensity(bloomFadeRef.current, performance.now()) : 0}
            luminanceThreshold={colors.bloom.threshold}
            radius={colors.bloom.radius}
            mipmapBlur={false}
            resolutionScale={colors.bloom.resolutionScale}
          />
          <Vignette offset={vignette.offset} darkness={vignette.darkness} />
        </EffectComposer>
      ) : null}
    </>
  );
}

/**
 * T2 remediation (Finding 2a -- live-Chrome finding: clicking the "Switch to
 * 2D" toggle, a deliberate WORKING user action, incorrectly triggered the
 * SAME genuine-context-loss failure message). ROOT CAUSE: unmounting this
 * component (which is exactly what the manual toggle does -- GraphView
 * conditionally renders `Graph3DScene` only while `mode3D` is true) tears
 * down the R3F `<Canvas>`, and three.js's `WebGLRenderer.dispose()` (called
 * internally by R3F/drei during that teardown) calls its own
 * `forceContextLoss()`, which uses the `WEBGL_lose_context` extension to
 * deliberately fire the SAME `webglcontextlost` event a real driver
 * crash/GPU reset would -- browsers dispatch that event asynchronously
 * (never synchronously inside the `loseContext()` call), so it lands on the
 * event loop strictly AFTER this component's own synchronous unmount-cleanup
 * effects have already run. That gives a reliable way to tell the two apart:
 * `unmounting` below flips to `true` synchronously during this component's
 * unmount, before any dispose-triggered `webglcontextlost` event the browser
 * schedules for that same unmount can ever be dispatched and observed here.
 * Pure/exported so the distinction itself is directly testable without a
 * real WebGL context (which jsdom cannot provide -- see this directory's
 * established convention, e.g. `isStaleTickRevision` above).
 */
export function isGenuineContextLoss(alreadyReported: boolean, unmounting: boolean): boolean {
  return !alreadyReported && !unmounting;
}

export function Graph3DScene(props: Graph3DSceneProps) {
  const { onFpsSample, onContextLost, onReady, paused, onClearSelection, ...sceneProps } = props;
  const reported = useRef(false);
  // See `isGenuineContextLoss`'s doc comment above for the full root cause.
  const unmountingRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountingRef.current = true;
    };
  }, []);
  const report = () => {
    if (!isGenuineContextLoss(reported.current, unmountingRef.current)) return;
    reported.current = true;
    onContextLost?.();
  };
  // Latch note (T3-advised escalation remediation round 2, Issue 2,
  // verified during implementation): `reported`/`unmountingRef` are
  // per-mount `useRef(false)` instances, and GraphView conditionally
  // renders this component (`mode3D &&`), so a manual "Switch to 3D" retry
  // after a fallback constructs a FRESH component instance with a fresh,
  // un-latched `reported` -- a second genuine loss on the retried scene is
  // always detectable. All three trigger paths (context-lost event, the
  // watchdog below, the wrapped-render error path) funnel through this one
  // latched report().

  // T3-advised escalation remediation round 2 (Issue 2): frameloop liveness
  // watchdog -- catches the live-observed SILENT freeze (rAF starved, no
  // webglcontextlost ever fired, canvas stuck on its last frame) that
  // neither existing trigger path could see. The stamp is written refs-only
  // inside SceneContents' existing useFrame; this interval lives outside
  // the render loop entirely. See `useFrameloopWatchdog`'s doc comment for
  // the threshold reasoning and the paused/hidden-tab deferral guards.
  const frameStampRef = useRef(0);
  useFrameloopWatchdog(frameStampRef, paused === true, report);

  // Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section 5.3
  // "Safe-tier choreography" / Section 6 Phase 4: "a `PerformanceMonitor`-
  // driven safe-tier degradation ladder ... with hysteresis"). Lives at THIS
  // level (not inside SceneContents) because `<PerformanceMonitor>` itself
  // wraps `<Suspense><SceneContents/></Suspense>` below, not the reverse.
  // `onIncline`/`onDecline` fire only after drei's OWN internal rolling-
  // average/bounds/flip-flop hysteresis has already debounced the raw fps
  // signal -- `stepSafeTierLevel` (safeTier.ts) only ever needs to react to
  // one already-decided step at a time, never re-implement hysteresis
  // itself. A plain `useState` set from an event-handler callback (not from
  // inside `useFrame`), matching `onFpsSample`'s own existing convention.
  const [autoSafeTierLevel, setAutoSafeTierLevel] = useState(SAFE_TIER_LEVEL_MIN);
  return (
    <WebglErrorBoundary onError={report}>
      <Canvas
        camera={{ position: [0, 0, 60], far: 4000 }}
        dpr={[0.75, 2]}
        // Deep-Field Observatory Phase 1 (plan Section 3.1 item 1 / Section
        // 5.6): ACES filmic tone mapping, explicitly configured rather than
        // relying on @react-three/fiber's implicit default (which applies
        // the same mapping today only as long as no future `gl`/`flat`
        // config on this mount opts out of it) -- an explicit, testable,
        // regression-proof declaration of the plan's tone-mapping invariant.
        gl={{ toneMapping: ACESFilmicToneMapping }}
        frameloop={paused ? "never" : "always"}
        // Deselection (plan Section 5.1 J-FOCUS "clear"): see the prop's
        // doc comment on Graph3DSceneProps -- genuine empty-space clicks
        // only, never an OrbitControls drag-release.
        onPointerMissed={onClearSelection}
        onCreated={(state) => {
          // Auto-fallback floor (critique item 4): a live context loss --
          // driver crash, GPU reset, tab backgrounding on some mobile
          // browsers -- fires this event on the WebGLRenderer's canvas;
          // WebGL creation *failure* is caught by WebglErrorBoundary above.
          state.gl.domElement.addEventListener("webglcontextlost", (event) => {
            event.preventDefault();
            report();
          });
          // T3-advised escalation remediation round 2 (Issue 2): symmetric
          // restore listener -- diagnostics/recovery-timing only. By the
          // time a genuine loss's restore could fire, GraphView has already
          // switched to the 2D fallback (unmounting this canvas), so this
          // never drives state; it exists so a live session's console
          // records WHETHER and WHEN the driver recovered, evidence the
          // silent-freeze investigation previously had no way to capture.
          state.gl.domElement.addEventListener("webglcontextrestored", () => {
            console.info("[Graph3DScene] webglcontextrestored received");
          });
          // T3-advised escalation remediation round 2 (Issue 2): the
          // render-loop error path. R3F v8's Canvas has no onError prop and
          // its rAF loop is outside React's commit phase, so a throw during
          // rendering can never reach WebglErrorBoundary -- wrap the
          // renderer boundary itself (crossed by both R3F's auto-render and
          // every EffectComposer pass) so it reaches the same latched
          // recovery path. See `wrapRenderWithRecovery`'s doc comment.
          state.gl.render = wrapRenderWithRecovery(state.gl.render.bind(state.gl), report);
          // Finding 2c: fires on every successful (re-)creation of the
          // WebGL context, including a manual post-context-loss retry, so
          // the caller can clear a stale failure announcement.
          onReady?.();
        }}
      >
        <PerformanceMonitor
          onChange={({ fps }) => onFpsSample?.(fps)}
          onDecline={() => setAutoSafeTierLevel((level) => stepSafeTierLevel(level, "down"))}
          onIncline={() => setAutoSafeTierLevel((level) => stepSafeTierLevel(level, "up"))}
        >
          <AdaptiveDpr pixelated />
          <Suspense fallback={null}>
            <SceneContents {...sceneProps} autoSafeTierLevel={autoSafeTierLevel} frameStampRef={frameStampRef} />
          </Suspense>
        </PerformanceMonitor>
      </Canvas>
    </WebglErrorBoundary>
  );
}
