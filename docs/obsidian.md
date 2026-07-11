# Obsidian setup

Every `mythic init`-created vault is a valid Obsidian vault out of the box —
no plugins to install, no manual configuration.

## Opening the vault

1. Open Obsidian → **Open folder as vault** → select the directory you passed
   to `mythic init` (e.g. `./my-vault`).
2. Obsidian reads `.obsidian/app.json`, `.obsidian/graph.json`,
   `.obsidian/core-plugins.json`, and `.obsidian/plugins/templates/data.json`
   — all written by `init_vault` and validated as well-formed JSON by
   `tests/test_obsidian_polish.py`.

## What's pre-configured

- **Graph view colour groups** (`.obsidian/graph.json`) — nodes are
  colour-coded by page-type folder:
  - `wiki/sources/` — green
  - `wiki/entities/` — purple
  - `wiki/concepts/` — blue
  - `wiki/sessions/` — amber
- **Core plugins enabled** (`.obsidian/core-plugins.json`): file explorer,
  global search, quick switcher, graph, backlinks, outgoing links,
  templates, word count, outline.
- **Templates plugin** (`.obsidian/plugins/templates/data.json`) points at
  `_templates/`, which holds one frontmatter-starter template per page type
  (`source.md`, `entity.md`, `concept.md`, `session.md`) matching
  `schema.md`'s contract — use Obsidian's **Insert template** command
  (`Ctrl/Cmd+P` → "Insert template") when hand-authoring a page.
- **Wikilinks, not Markdown links** (`useMarkdownLinks: false` in
  `app.json`) — matches the `[[Page Title]]` convention every compiled page
  uses.
- **Attachments folder** set to `raw/` — the immutable originals Docling/
  MarkItDown parsed.

## Viewing the graph

Open the **Graph view** (`Ctrl/Cmd+G` or the graph icon in the left ribbon).
Every page compiled by Mythic Proportion appears as a node; `[[wikilinks]]`
in a page's body become the edges — the graph view *is* a live view of the
knowledge graph this app maintains, with no separate visualization layer to
keep in sync.

## Human edits are safe

If you hand-edit a compiled page in Obsidian, the next compile pass will
detect that the on-disk content no longer matches its last-known
`compiled_hash` and will **not** overwrite your edit — it appends a
`> [!merge]` callout instead, so your changes and the proposed update are
both visible (see `compile/writer.py`).
