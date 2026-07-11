// JS-side counterpart to tokens/motion.css, for imperative code that can't
// use CSS transitions (e.g. an R3F camera-focus tween). Reads the same
// custom properties so there is exactly one source of truth for durations
// and easings; honors prefers-reduced-motion by collapsing durations to 0,
// mirroring the CSS override block.

export type MotionDuration = "instant" | "fast" | "base" | "slow";
export type MotionEasing = "standard" | "out" | "emphasized";

function readMs(varName: string, root: Element = document.documentElement): number {
  const raw = getComputedStyle(root).getPropertyValue(varName).trim();
  const match = /^([\d.]+)ms$/.exec(raw);
  return match ? Number(match[1]) : 0;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Duration in ms for a motion token, already 0 if reduced-motion is set. */
export function getDuration(name: MotionDuration, root?: Element): number {
  return readMs(`--duration-${name}`, root);
}

/** Raw cubic-bezier string for an easing token (unaffected by reduced-motion). */
export function getEasing(name: MotionEasing, root: Element = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue(`--ease-${name}`).trim();
}
