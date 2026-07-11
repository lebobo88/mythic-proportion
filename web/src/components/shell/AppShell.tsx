import type { ReactNode } from "react";
import { Header } from "./Header";
import { TabNav, type TabName } from "./TabNav";
import type { Theme } from "../../lib/theme";
import "./app-shell.css";

export function AppShell({
  theme,
  onToggleTheme,
  onOpenPalette,
  activeTab,
  onSelectTab,
  children,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  activeTab: TabName;
  onSelectTab: (tab: TabName) => void;
  children: ReactNode;
}) {
  return (
    <div className="mp-app-shell">
      <Header theme={theme} onToggleTheme={onToggleTheme} onOpenPalette={onOpenPalette} />
      <div className="mp-app-shell-subheader">
        <TabNav active={activeTab} onSelect={onSelectTab} />
      </div>
      <main className="mp-app-shell-main">{children}</main>
    </div>
  );
}
