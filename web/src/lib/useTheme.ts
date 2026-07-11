import { useCallback, useEffect, useState } from "react";
import { applyTheme, getInitialTheme, toggleTheme, type Theme } from "./theme";

// React hook wrapping the vanilla theme module (see theme.ts). Applies the
// theme to <html data-theme> synchronously on first render to avoid a
// flash-of-wrong-theme, then exposes a toggle for the ThemeToggle control.
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => {
    const initial = getInitialTheme();
    applyTheme(initial);
    return initial;
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setThemeState((current) => toggleTheme(current));
  }, []);

  return { theme, toggle };
}
