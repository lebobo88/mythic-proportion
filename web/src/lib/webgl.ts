// Feature-detection + context-loss plumbing for the Phase 5 3D graph scene's
// REQUIRED graceful-degradation floor (deliverable 9 / reflexion critique
// item 4): the 2D fallback must be reachable automatically, not only via the
// manual toggle in GraphView.tsx.
export function supportsWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
    return Boolean(gl);
  } catch {
    return false;
  }
}
