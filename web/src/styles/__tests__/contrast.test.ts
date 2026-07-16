import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wcagContrast } from "culori";

// Token-contrast audit (Phase 1 testing strategy: "4.5:1 body / 3:1 large+UI
// in both light and dark"). Deliberately parses the *real* CSS token files
// on disk (not a duplicated JS copy of the values) so this test can never
// silently drift from what actually ships — CSS custom properties remain
// the single runtime source of truth per specs/ROADMAP-BRIEF.md §6.6.

function readCss(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf-8");
}

function extractDeclarations(blockText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--([\w-]+):\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(blockText)) !== null) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

function extractBlock(css: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css);
  if (!match) {
    throw new Error(`contrast.test.ts: could not find block for ${selectorPattern}`);
  }
  return match[1];
}

function resolveValue(value: string, primitives: Record<string, string>): string {
  const varMatch = /^var\(--([\w-]+)\)$/.exec(value);
  if (varMatch) {
    const resolved = primitives[varMatch[1]];
    if (!resolved) throw new Error(`contrast.test.ts: unresolved var(--${varMatch[1]})`);
    return resolved;
  }
  return value;
}

const primitivesCss = readCss("../tokens/primitives.css");
const semanticCss = readCss("../tokens/semantic.css");

const primitives = extractDeclarations(extractBlock(primitivesCss, /:root\s*{([\s\S]*)}/));

const darkBlock = extractDeclarations(
  extractBlock(semanticCss, /:root,\s*\[data-theme="dark"\]\s*{([^}]*)}/),
);
const lightBlock = extractDeclarations(extractBlock(semanticCss, /\[data-theme="light"\]\s*{([^}]*)}/));

function resolveTheme(block: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(block)) {
    resolved[key] = resolveValue(value, primitives);
  }
  return resolved;
}

const dark = resolveTheme(darkBlock);
const light = resolveTheme(lightBlock);

describe("design-token contrast audit", () => {
  it.each([
    ["dark", dark],
    ["light", light],
  ])("%s theme: body text meets 4.5:1 against surfaces", (_name, theme) => {
    expect(wcagContrast(theme["color-text-primary"], theme["color-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(theme["color-text-secondary"], theme["color-bg"])).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      wcagContrast(theme["color-text-primary"], theme["color-bg-elevated"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      wcagContrast(theme["color-text-secondary"], theme["color-bg-elevated"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])("%s theme: accent (large text / UI) meets 3:1 against bg", (_name, theme) => {
    expect(wcagContrast(theme["color-accent"], theme["color-bg"])).toBeGreaterThanOrEqual(3.0);
  });
});
