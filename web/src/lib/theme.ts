// Theme state: dark-first, both themes shipped. Persisted to localStorage;
// falls back to the OS `prefers-color-scheme` on first visit. Applies via a
// `data-theme` attribute on <html> so tokens/semantic.css and
// tokens/graph.css can key off a single attribute selector.

export type Theme = "dark" | "light";

const STORAGE_KEY = "mythic-proportion:theme";

function systemPrefersLight(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return systemPrefersLight() ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

export function persistTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  persistTheme(theme);
  document.dispatchEvent(new CustomEvent("mythic:theme-change", { detail: theme }));
}

export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
