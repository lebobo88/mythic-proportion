import { Button } from "../ui";
import { ThemeToggle } from "./ThemeToggle";
import type { Theme } from "../../lib/theme";
import "./header.css";

export function Header({
  theme,
  onToggleTheme,
  onOpenPalette,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
}) {
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "");
  return (
    <header className="mp-header">
      <span className="mp-header-brand">Mythic Proportion</span>
      <Button variant="secondary" onClick={onOpenPalette} aria-label="Open command palette">
        Search or run a command
        <span className="mp-header-shortcut">{isMac ? "⌘K" : "Ctrl+K"}</span>
      </Button>
      <div className="mp-header-spacer" />
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
    </header>
  );
}
