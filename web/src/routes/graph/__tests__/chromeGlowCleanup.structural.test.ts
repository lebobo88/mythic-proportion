// Verifier remediation cycle 1 (VERIFICATION_NEEDS_FIX, minor, J-004,
// bundled at engineering discretion): `CloudNebula.tsx`/`OrbitalCoreGlow.tsx`
// each had an unmount-cleanup effect with an EMPTY dependency array whose
// closure captured the INITIAL (always-null) `texture` state -- so
// `texture?.dispose()` on real unmount always disposed nothing, and the
// actually-created `CanvasTexture` (set later via `setTexture`) leaked on
// every unmount (a minor GPU-texture leak over a long session of repeated
// Cloud/Orbital mode switching). Fix: a ref mirrors the LATEST texture on
// every change, and the unmount effect disposes THAT ref's current value,
// not a stale closed-over state variable. Same "jsdom cannot genuinely
// observe a real unmount+GPU-dispose interaction, check structurally"
// convention as this directory's other R3F-lifecycle coverage.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(fileName: string): string {
  return readFileSync(join(__dirname, "..", "three", fileName), "utf-8");
}

describe.each(["CloudNebula.tsx", "OrbitalCoreGlow.tsx"])("%s disposes the LATEST texture on unmount, not a stale closure", (fileName) => {
  const source = readSource(fileName);

  it("keeps a ref mirroring the latest texture, updated whenever the texture state changes", () => {
    expect(source).toMatch(/const latestTextureRef = useRef<CanvasTexture \| null>\(null\);/);
    expect(source).toMatch(/useEffect\(\(\) => \{\s*latestTextureRef\.current = texture;\s*\}, \[texture\]\);/);
  });

  it("disposes latestTextureRef.current (never the stale `texture` closure variable) inside the unmount-only cleanup effect", () => {
    expect(source).toMatch(/useEffect\(\(\) => \{\s*return \(\) => \{\s*latestTextureRef\.current\?\.dispose\(\);/);
  });
});
