// Deep-Field Observatory Phase 4 (plan Section 3.1 item 4 / Section 5.3
// "Safe-tier choreography" / Section 5.6 items 5-6 / Section 6 Phase 4).
// Pure, side-effect-free decision functions for:
//  (1) the PerformanceMonitor-driven safe-tier degradation LADDER (bloom ->
//      ambient freeze -> chrome -> LOD), including the user-facing
//      Auto/Full/Balanced/Minimal effects/quality control (Section 5.1 IA:
//      "a new effects/quality control ... the single inspectable home of the
//      safe-tier decision");
//  (2) bloom-intensity fades composed off the SAME `transitioning` mode-
//      switch signal Graph3DScene.tsx already owns (Section 5.6 item 5:
//      "bloom suppression composes off the SAME `transitioning` signal, and
//      bloom restores only after the far-tier restore").
//
// Kept entirely free of React/R3F/DOM so every rule here is directly
// testable without a real WebGL context -- same "extract the decision into a
// pure function" convention this directory already uses for
// `computeLodDistances` (InstancedNodes.tsx) and `transitionAlpha`/
// `blendPositions` (modeTransition.ts). The REACT-level wiring (the
// `<PerformanceMonitor onIncline/onDecline>` hookup, the `<Bloom>` ref
// mutation inside `useFrame`, the effects-control radiogroup, the aria-live
// region) lives in Graph3DScene.tsx/GraphView.tsx and is covered by
// structural wiring tests, matching this directory's established split
// between pure-logic tests and structural-wiring tests.

/** The user-facing effects/quality control (Section 5.1 IA / Section 13). */
export type EffectsTier = "auto" | "full" | "balanced" | "minimal";

export const EFFECTS_TIERS: readonly EffectsTier[] = ["auto", "full", "balanced", "minimal"];

/**
 * The safe-tier ladder has exactly 4 steps (Section 5.3 "Safe-tier
 * choreography"): (1) bloom off, (2) ambient drift freezes, (3) chrome
 * thins, (4) LOD drops to the safe tier. Level 0 = nothing degraded (Full).
 * A single monotonic integer naturally satisfies "recovery reverses the
 * order": stepping the SAME counter down/up crosses the SAME edges in
 * reverse, so no separate "reverse ladder" table is needed.
 */
export const SAFE_TIER_LEVEL_MIN = 0;
export const SAFE_TIER_LEVEL_MAX = 4;

/**
 * One PerformanceMonitor `onDecline`/`onIncline` event = exactly one ladder
 * step (never a multi-step jump) -- drei's PerformanceMonitor already
 * implements the "with hysteresis" requirement (Section 5.3) internally via
 * its own rolling-average/bounds/flip-flop-count algorithm before it ever
 * fires `onDecline`/`onIncline`, so this function does not re-implement
 * hysteresis itself; it only translates one already-debounced event into one
 * clamped level change.
 */
export function stepSafeTierLevel(level: number, direction: "down" | "up"): number {
  if (direction === "down") return Math.min(SAFE_TIER_LEVEL_MAX, level + 1);
  return Math.max(SAFE_TIER_LEVEL_MIN, level - 1);
}

/**
 * Section 13: "The effects/quality-control surface -- recommend shipping the
 * inspectable Auto/Full/Balanced/Minimal control" (an acceptable-to-settle
 * open decision, labeled here, not fabricated as an observed spec): Full is
 * a quality CEILING -- start at/prefer the top of the ladder and never
 * proactively degrade, but always honor the live `autoLevel` emergency
 * signal (Phase 7 closeout 10k-crash fix, T3-diagnosed: the earlier
 * semantics pinned Full to level 0 unconditionally, which structurally
 * disabled the Section 5.3 bloom -> ambient -> chrome -> LOD emergency
 * safety valve and let Cloud+Full at 10k nodes crash under genuine GPU
 * pressure instead of degrading. Every `onDecline` arrives only after
 * drei's PerformanceMonitor's own rolling-average/bounds/flip-flop
 * hysteresis, so there is no "borderline noise" tier of decline events to
 * filter here -- each one is already a genuine sustained signal, and any
 * Full-specific extra lag or ceiling cap would re-create the crash window
 * in attenuated form). Balanced forces a fixed mid-ladder level (bloom
 * off + ambient frozen, chrome/LOD retained) independent of live fps --
 * a deliberately simple, inspectable middle ground rather than a second
 * live-fps-driven ceiling; Minimal forces the full safe-tier rig (matches
 * the acceptance check: "Minimal genuinely maps to the safe-tier rig (bloom
 * off, minimal chrome, LOD dropped)"). Auto remains the adaptive default;
 * with the current single debounced signal, Auto and Full resolve
 * identically -- the cases stay deliberately separate because their
 * SEMANTICS differ (Full = pinned-maximum preference that only the
 * emergency ladder may override; Auto = the tier reserved for any future
 * richer adaptive behavior, e.g. borderline/`factor`-driven tuning).
 */
export function effectiveSafeTierLevel(tier: EffectsTier, autoLevel: number): number {
  switch (tier) {
    case "full":
      // Ceiling, not floor: healthy (autoLevel 0) stays fully un-degraded;
      // a live emergency signal is followed 1:1, all the way to the
      // known-safe full rig (level 4) -- the only configuration proven to
      // survive 10k on the target GPU.
      return autoLevel;
    case "balanced":
      return 2;
    case "minimal":
      return SAFE_TIER_LEVEL_MAX;
    case "auto":
    default:
      return autoLevel;
  }
}

export interface SafeTierFlags {
  bloomEnabled: boolean;
  ambientFrozen: boolean;
  chromeThinned: boolean;
  lodDropped: boolean;
}

/**
 * Monotonic ladder per Section 5.3: each step stays engaged at every level
 * past its own threshold (never "a la carte" -- level 3 keeps bloom off AND
 * ambient frozen AND chrome thinned).
 */
export function safeTierFlags(level: number): SafeTierFlags {
  return {
    bloomEnabled: level < 1,
    ambientFrozen: level >= 2,
    chromeThinned: level >= 3,
    lodDropped: level >= 4,
  };
}

// Ladder step names, index i = the edge crossed going from level i to i+1.
const STEP_NAMES = ["bloom", "ambient motion", "chrome effects", "level of detail"] as const;
const STEP_DOWN_VERB = ["disabled", "frozen", "minimized", "lowered"] as const;
const STEP_UP_VERB = ["re-enabled", "resumed", "restored", "raised"] as const;

/**
 * Announces exactly ONE ladder-step crossing between two ADJACENT levels
 * (never a multi-step jump -- a manual Auto/Full/Balanced/Minimal selection
 * that jumps more than one level uses `tierChangeAnnouncement` instead, so
 * assistive tech gets one clear message rather than four concatenated ones).
 * Politely worded per Section 5.3's "each step politely announced via
 * `aria-live`" -- consumed by a `role="status"`/`aria-live="polite"` region
 * (never a dialog, per the plan's browser-UI dialog policy).
 */
export function stepAnnouncement(fromLevel: number, toLevel: number): string {
  const diff = toLevel - fromLevel;
  if (diff === 0 || Math.abs(diff) !== 1) return "";
  const edgeIndex = Math.min(fromLevel, toLevel);
  const name = STEP_NAMES[edgeIndex];
  if (diff > 0) {
    return `Graph detail reduced: ${name} ${STEP_DOWN_VERB[edgeIndex]} to maintain performance.`;
  }
  return `Graph detail restored: ${name} ${STEP_UP_VERB[edgeIndex]}.`;
}

const TIER_LABELS: Record<EffectsTier, string> = {
  auto: "Auto",
  full: "Full",
  balanced: "Balanced",
  minimal: "Minimal",
};

/** Announces a direct manual effects-tier selection -- a plain "Graph detail: <Tier>." message, not a step-by-step ladder narration. */
export function tierChangeAnnouncement(tier: EffectsTier): string {
  return `Graph detail: ${TIER_LABELS[tier]}.`;
}

/**
 * Section 5.6 item 5: "bloom suppression composes off the SAME
 * `transitioning` signal, and bloom restores only after the far-tier
 * restore." Section 5.3 "Safe-tier choreography" step 1: bloom is also the
 * FIRST thing the safe-tier ladder disables. Either suppressor alone forces
 * bloom fully off (0) -- never additive, never partially suppressed by one
 * and not the other.
 */
export function bloomTargetIntensity(
  tokenIntensity: number,
  transitioning: boolean,
  bloomEnabledBySafeTier: boolean,
): number {
  if (transitioning || !bloomEnabledBySafeTier) return 0;
  return tokenIntensity;
}

export type BloomFadeTrigger = "transition-start" | "transition-end" | "safe-tier-down" | "safe-tier-up" | "none";

export interface BloomMotionDurations {
  suppressMs: number;
  restoreMs: number;
}

/**
 * Section 5.3: the mode-transition pair is explicitly ASYMMETRIC (150ms
 * suppress / 225ms restore -- "rationale: suppressed far-tier flat quads
 * render near-black at grazing angles, so bloom on transient half-lit
 * geometry would smear"). The safe-tier ladder's own bloom step is
 * explicitly SYMMETRIC ("bloom off (150ms fade...)" with "recovery reverses
 * the order with the SAME fades") -- both directions use the suppress
 * duration.
 */
export function bloomFadeDurationMs(trigger: BloomFadeTrigger, motion: BloomMotionDurations): number {
  switch (trigger) {
    case "transition-start":
      return motion.suppressMs;
    case "transition-end":
      return motion.restoreMs;
    case "safe-tier-down":
    case "safe-tier-up":
      return motion.suppressMs;
    case "none":
    default:
      return 0;
  }
}

export interface BloomFadeState {
  fromIntensity: number;
  toIntensity: number;
  startTime: number;
  durationMs: number;
}

/**
 * Starts a fade FROM the current (possibly still-interpolating) intensity --
 * "hard interruptible, retarget from the current value, no reset pop", the
 * same discipline Section 5.3's hover-glow spec and `modeTransition.ts`'s
 * `startModeTransition` both already use.
 */
export function startBloomFade(
  fromIntensity: number,
  toIntensity: number,
  now: number,
  durationMs: number,
): BloomFadeState {
  return { fromIntensity, toIntensity, startTime: now, durationMs: Math.max(0, durationMs) };
}

/** Linearly eased intensity at `now`, clamped to the target once `durationMs` has elapsed (or immediately, if `durationMs` is 0 -- the reduced-motion/instant-safe-tier-step path). Mirrors `modeTransition.ts`'s `transitionAlpha` shape. */
export function currentBloomIntensity(state: BloomFadeState, now: number): number {
  if (state.durationMs <= 0) return state.toIntensity;
  const t = Math.min(1, Math.max(0, (now - state.startTime) / state.durationMs));
  return state.fromIntensity + (state.toIntensity - state.fromIntensity) * t;
}
