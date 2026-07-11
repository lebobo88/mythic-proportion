import { useEffect } from "react";
import { Dialog, DialogContent } from "../ui/Dialog";
import {
  Combobox,
  ComboboxInput,
  ComboboxList,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
} from "../ui/Combobox";
import { TABS, type TabName } from "../shell/TabNav";
import "./command-palette.css";

// Placeholder "jump to page" fixtures — Phase 2 replaces this with a live
// `/api/pages` fetch once the wiki view is rebuilt on this shell (see
// specs/mythic-proportion-3d-graphrag.html Phase 2). Kept here purely to
// prove the combobox's fuzzy-search + navigation wiring end to end.
const DEMO_PAGES = [
  { id: "index", title: "Index" },
  { id: "graphrag-notes", title: "GraphRAG notes" },
  { id: "design-system", title: "Design system" },
];

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectTab: (tab: TabName) => void;
  onJumpToPage?: (pageId: string) => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onSelectTab,
  onJumpToPage,
}: CommandPaletteProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
      if (event.key === "Escape" && open) {
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  function runAndClose(action: () => void) {
    action();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Command palette"
        description="Switch tabs, jump to a page, or run an action."
        className="mp-command-palette-content"
      >
        <Combobox label="Command palette">
          <ComboboxInput autoFocus placeholder="Type a command or search..." />
          <ComboboxList>
            <ComboboxEmpty>No matching command or page.</ComboboxEmpty>

            <ComboboxGroup heading="Navigate">
              {TABS.map((tab) => (
                <ComboboxItem
                  key={tab}
                  value={`switch tab ${tab}`}
                  onSelect={() => runAndClose(() => onSelectTab(tab))}
                >
                  Switch to {tab}
                </ComboboxItem>
              ))}
            </ComboboxGroup>

            <ComboboxGroup heading="Pages">
              {DEMO_PAGES.map((page) => (
                <ComboboxItem
                  key={page.id}
                  value={`jump to page ${page.title}`}
                  onSelect={() =>
                    runAndClose(() => {
                      onSelectTab("Wiki");
                      onJumpToPage?.(page.id);
                    })
                  }
                >
                  {page.title}
                </ComboboxItem>
              ))}
            </ComboboxGroup>

            <ComboboxGroup heading="Actions">
              <ComboboxItem value="run ask" onSelect={() => runAndClose(() => onSelectTab("Ask"))}>
                Run Ask
              </ComboboxItem>
              <ComboboxItem
                value="open ingest"
                onSelect={() => runAndClose(() => onSelectTab("Ingest"))}
              >
                Open Ingest
              </ComboboxItem>
            </ComboboxGroup>
          </ComboboxList>
        </Combobox>
      </DialogContent>
    </Dialog>
  );
}
