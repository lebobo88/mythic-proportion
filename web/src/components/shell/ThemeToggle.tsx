import { Button } from "../ui";
import { Tooltip } from "../ui";
import type { Theme } from "../../lib/theme";

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        aria-label={label}
        aria-pressed={theme === "light"}
        onClick={onToggle}
      >
        {theme === "dark" ? "Light" : "Dark"}
      </Button>
    </Tooltip>
  );
}
