"""Vault initialization: idempotently create the on-disk tree and seed files."""

from __future__ import annotations

import json
from pathlib import Path

from mythic_proportion.vault.layout import (
    HOT_FILE,
    INDEX_FILE,
    OBSIDIAN_CONFIG_FILE,
    OBSIDIAN_CORE_PLUGINS_FILE,
    OBSIDIAN_DIR,
    OBSIDIAN_GRAPH_FILE,
    SCHEMA_FILE,
    TEMPLATES_DIR,
    vault_dirs,
)

_SCHEMA_MD = """\
# Schema

This vault follows the **Mythic Proportion / LLM-Wiki** page-type contract.
Every wiki page lives under `wiki/<type-plural>/` and begins with YAML
frontmatter followed by Markdown body prose that freely uses `[[wikilinks]]`
to reference other pages by their title (the graph *is* the wikilinks).

## Frontmatter fields (all page types)

| Field         | Type       | Meaning                                              |
|---------------|------------|-------------------------------------------------------|
| `type`        | string     | One of `source`, `entity`, `concept`, `session`.       |
| `source_hash` | string     | SHA-256 of the originating `raw/` file, if any.        |
| `created`     | ISO 8601   | Timestamp the page was first written.                  |
| `updated`     | ISO 8601   | Timestamp of the most recent edit (human or compile).   |
| `tags`        | list[str]  | Free-form tags used for filtering and Obsidian search.  |

## Page types

### `source` (`wiki/sources/`)
A summary of one ingested source document (from `raw/`). Captures what the
document is, its key claims, and links out to the entities/concepts it
introduces or touches.

### `entity` (`wiki/entities/`)
A named, concrete thing referenced across one or more sources: a person,
organization, product, tool, or system. Accumulates facts and links back to
every source page that mentions it.

### `concept` (`wiki/concepts/`)
An abstract idea, pattern, or technique that recurs across sources (e.g. "LLM-Wiki
pattern", "hybrid retrieval"). Synthesizes the idea once and is linked from every
page that touches it, rather than re-explaining it each time.

### `session` (`wiki/sessions/`)
A record of a harness run, conversation, or work session — useful for
harness-aware ingestion of `.fable/` artifacts and `memory/` decisions.

## The `[[wikilink]]` convention

Any page may reference another by writing `[[Page Title]]`. Wikilinks are
resolved by exact page title match (case-insensitive). A wikilink to a page
that does not yet exist is a *dangling* link; later phases (compile, lint)
create stub pages for dangling links or report them so they can be resolved.
"""

_INDEX_MD = """\
# Index

Append-only catalogue of every page in this vault and its backlinks. Compile
and lint steps in later phases append entries here; entries are never
rewritten or removed, only added, so the index doubles as a change history.

<!-- backlink catalogue -->
"""

_HOT_MD = """\
# Hot

Recent-context cache (~500 words). Refreshed by later phases as new sources
are ingested and compiled. Empty until the first ingest.
"""


#: Graph colour groups by page-type folder, shared by both the legacy
#: ``app.json["graph"]`` block (kept for backward compatibility — see the
#: Phase 1 invariant that ``"graph"`` remains present in app.json) and the
#: native ``.obsidian/graph.json`` file Obsidian itself actually reads for
#: graph-view colouring.
_GRAPH_COLOR_GROUPS: list[dict] = [
    {"query": "path:wiki/sources", "color": {"a": 1, "rgb": 0x2F9E5B}},
    {"query": "path:wiki/entities", "color": {"a": 1, "rgb": 0x9B5DE5}},
    {"query": "path:wiki/concepts", "color": {"a": 1, "rgb": 0x2F6FED}},
    {"query": "path:wiki/sessions", "color": {"a": 1, "rgb": 0xD9A406}},
]


def _obsidian_app_json() -> dict:
    """Sensible general Obsidian workspace settings.

    ``graph`` is kept here too (in addition to the native ``graph.json``,
    see :func:`_obsidian_graph_json`) — a later revision must not remove it,
    per the Phase 1 invariant that ``"graph"`` remains present in app.json.
    """
    return {
        "graph": {"colorGroups": _GRAPH_COLOR_GROUPS},
        "attachmentFolderPath": "raw",
        "newFileLocation": "folder",
        "newFileFolderPath": "wiki",
        "useMarkdownLinks": False,
        "alwaysUpdateLinks": True,
        "showUnsupportedFiles": True,
        "livePreview": True,
    }


def _obsidian_graph_json() -> dict:
    """The native ``.obsidian/graph.json`` Obsidian's graph view actually reads."""
    return {
        "collapse-color-groups": False,
        "colorGroups": _GRAPH_COLOR_GROUPS,
        "collapse-display": False,
        "showArrow": False,
        "textFadeMultiplier": 0,
        "nodeSizeMultiplier": 1,
        "lineSizeMultiplier": 1,
        "collapse-forces": False,
        "centerStrength": 0.5,
        "repelStrength": 10,
        "linkStrength": 1,
        "linkDistance": 250,
        "scale": 1,
        "close": False,
    }


def _obsidian_core_plugins_json() -> list[str]:
    """Core plugins worth enabling by default: graph, backlinks, templates, search."""
    return [
        "file-explorer",
        "global-search",
        "switcher",
        "graph",
        "backlink",
        "outgoing-link",
        "templates",
        "word-count",
        "outline",
    ]


def _obsidian_templates_plugin_json() -> dict:
    """Point the core Templates plugin at ``_templates/``."""
    return {"folder": TEMPLATES_DIR, "dateFormat": "YYYY-MM-DD", "timeFormat": "HH:mm"}


#: One frontmatter-only starter template per page type (Phase 6), written
#: under ``_templates/`` for Obsidian's Templates core plugin. These are
#: human-editing conveniences, not machine-parsed by this app.
_PAGE_TEMPLATES: dict[str, str] = {
    "source.md": """\
---
type: source
source_hash:
created: {{date}}
updated: {{date}}
tags: []
---
# {{title}}

## Summary


## Key claims


## Links

""",
    "entity.md": """\
---
type: entity
source_hash:
created: {{date}}
updated: {{date}}
tags: []
---
# {{title}}

## What it is


## Facts


## Mentioned in

""",
    "concept.md": """\
---
type: concept
source_hash:
created: {{date}}
updated: {{date}}
tags: []
---
# {{title}}

## Definition


## Related concepts

""",
    "session.md": """\
---
type: session
source_hash:
created: {{date}}
updated: {{date}}
tags: []
---
# {{title}}

## What happened


## Decisions


## Follow-ups

""",
}


def init_vault(root: Path, force: bool = False) -> None:
    """Create (or validate) the vault tree at ``root``.

    Idempotent: safe to call repeatedly. Existing directories are left alone.
    Seed files (``schema.md``, ``index.md``, ``hot.md``, Obsidian config) are
    only written if they do not already exist, unless ``force=True``, in
    which case they are overwritten with the canonical seed content.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)

    for d in vault_dirs(root):
        d.mkdir(parents=True, exist_ok=True)

    _write_if_absent(root / SCHEMA_FILE, _SCHEMA_MD, force=force)
    _write_if_absent(root / INDEX_FILE, _INDEX_MD, force=force)
    _write_if_absent(root / HOT_FILE, _HOT_MD, force=force)

    obsidian_config = root / OBSIDIAN_DIR / OBSIDIAN_CONFIG_FILE
    _write_if_absent(
        obsidian_config, json.dumps(_obsidian_app_json(), indent=2) + "\n", force=force
    )

    obsidian_graph = root / OBSIDIAN_DIR / OBSIDIAN_GRAPH_FILE
    _write_if_absent(
        obsidian_graph, json.dumps(_obsidian_graph_json(), indent=2) + "\n", force=force
    )

    obsidian_core_plugins = root / OBSIDIAN_DIR / OBSIDIAN_CORE_PLUGINS_FILE
    _write_if_absent(
        obsidian_core_plugins,
        json.dumps(_obsidian_core_plugins_json(), indent=2) + "\n",
        force=force,
    )

    templates_plugin_dir = root / OBSIDIAN_DIR / "plugins" / "templates"
    _write_if_absent(
        templates_plugin_dir / "data.json",
        json.dumps(_obsidian_templates_plugin_json(), indent=2) + "\n",
        force=force,
    )

    templates_dir = root / TEMPLATES_DIR
    for filename, content in _PAGE_TEMPLATES.items():
        _write_if_absent(templates_dir / filename, content, force=force)


def _write_if_absent(path: Path, content: str, force: bool) -> None:
    if force or not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
