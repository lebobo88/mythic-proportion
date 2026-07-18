// Phase 4a de-risking spike (plan Section 6.3, bet 1 -- mode-switch
// transition continuity): a pure, unit-testable blend engine. Deliberately
// NOT a canned/scripted position animation (the design handoff's M1 spec,
// plan Section 5.1, is explicit that "physics itself is never animated/
// faked") -- this module only ever blends between two REAL worker-computed
// position snapshots: the last-known positions from the mode being left,
// and the live, still-settling positions the target mode's worker force
// configuration is actually producing tick by tick. As the target mode's
// own simulation keeps evolving, the blend keeps re-targeting it every
// frame, so what's on screen converges toward wherever the real physics
// settles, never toward a pre-baked path.
//
// Bounded + interruptible (M1): `MODE_TRANSITION_DURATION_MS` caps the
// blend at 800ms; starting a new transition (a second mode switch mid-
// blend) simply replaces the in-flight one with a fresh snapshot -- there
// is no queue, so the newest user intent always wins immediately, mirroring
// `CameraRig.tsx`'s own user-interrupt discipline for camera animations.
export const MODE_TRANSITION_DURATION_MS = 800;

export interface ModeTransitionState {
  /** Snapshot of every visible node's position at the moment the transition started, keyed by id. */
  fromPositions: Map<string, [number, number, number]>;
  startTime: number;
  durationMs: number;
}

/**
 * Snapshots `ids`/`positions` (the exact shape the worker's "tick" message
 * already carries -- see `forceLayout.worker.ts`) into a fresh transition
 * state starting at `now`. Pass `durationMs <= 0` (e.g. under
 * `prefers-reduced-motion`) to make `transitionAlpha` resolve to 1
 * immediately -- the caller still gets a consistent snapshot object rather
 * than needing a separate reduced-motion code path.
 */
export function startModeTransition(
  ids: string[],
  positions: Float32Array,
  now: number,
  durationMs: number = MODE_TRANSITION_DURATION_MS,
): ModeTransitionState {
  const fromPositions = new Map<string, [number, number, number]>();
  for (let i = 0; i < ids.length; i++) {
    fromPositions.set(ids[i], [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  }
  return { fromPositions, startTime: now, durationMs: Math.max(0, durationMs) };
}

/** Emphasized ease-out cubic -- the same curve `CameraRig.tsx` uses for camera-fit/focus tweens, kept consistent across the two motion systems. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Eased 0..1 blend progress at `now`. Resolves to (and stays clamped at) 1 once `durationMs` has elapsed, or immediately if `durationMs` is 0 (reduced-motion path). */
export function transitionAlpha(state: ModeTransitionState, now: number): number {
  if (state.durationMs <= 0) return 1;
  const t = Math.min(1, Math.max(0, (now - state.startTime) / state.durationMs));
  return easeOutCubic(t);
}

export function isTransitionActive(state: ModeTransitionState | null, now: number): boolean {
  if (!state) return false;
  return transitionAlpha(state, now) < 1;
}

/**
 * Writes the blended (lerp'd) position for every id in `currentIds` into
 * `outBuffer` (caller-owned, reused -- no allocation on the hot per-tick
 * path, matching `Graph3DScene.tsx`'s existing zero-allocation tick
 * discipline). A node absent from `state.fromPositions` (not visible before
 * the transition started) renders at its current/target position
 * immediately -- there is nothing to blend FROM for a node that's newly
 * entering view, so snapping it in is correct, not a fallback compromise.
 */
export function blendPositions(
  state: ModeTransitionState,
  currentIds: string[],
  currentPositions: Float32Array,
  now: number,
  outBuffer: Float32Array,
): void {
  const alpha = transitionAlpha(state, now);
  for (let i = 0; i < currentIds.length; i++) {
    const toX = currentPositions[i * 3];
    const toY = currentPositions[i * 3 + 1];
    const toZ = currentPositions[i * 3 + 2];
    const from = state.fromPositions.get(currentIds[i]);
    if (!from || alpha >= 1) {
      outBuffer[i * 3] = toX;
      outBuffer[i * 3 + 1] = toY;
      outBuffer[i * 3 + 2] = toZ;
      continue;
    }
    outBuffer[i * 3] = from[0] + (toX - from[0]) * alpha;
    outBuffer[i * 3 + 1] = from[1] + (toY - from[1]) * alpha;
    outBuffer[i * 3 + 2] = from[2] + (toZ - from[2]) * alpha;
  }
}
