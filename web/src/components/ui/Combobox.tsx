import { Command as CommandPrimitive } from "cmdk";
import "./combobox.css";

// A token-styled shell over `cmdk`'s Command primitive — the fuzzy-search
// combobox used both standalone (e.g. a "jump to page" field) and inside the
// Cmd+K CommandPalette (see components/command-palette/CommandPalette.tsx).
export const Combobox = CommandPrimitive;
export const ComboboxInput = CommandPrimitive.Input;
export const ComboboxList = CommandPrimitive.List;
export const ComboboxEmpty = CommandPrimitive.Empty;
export const ComboboxGroup = CommandPrimitive.Group;
export const ComboboxItem = CommandPrimitive.Item;
export const ComboboxSeparator = CommandPrimitive.Separator;
