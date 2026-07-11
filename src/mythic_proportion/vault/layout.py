"""Vault directory/file layout constants and helpers.

The vault is the Obsidian-compatible, on-disk knowledge store:

    <root>/
        drop/                 # inbox — user drops raw documents/artifacts here
        raw/                  # immutable originals, keyed by content hash
        wiki/
            sources/          # source-summary pages
            entities/         # entity pages
            concepts/         # concept pages
            sessions/         # session/run pages
        .index/               # SQLite hybrid-search sidecar (Phase 4)
        .vault-meta/          # internal bookkeeping (locks, provenance, etc.)
        _templates/           # Obsidian Templates-plugin frontmatter templates (Phase 6)
        schema.md             # page-type contract
        index.md              # append-only backlink/page catalogue
        hot.md                # recent-context cache
        .obsidian/app.json    # minimal Obsidian workspace config
        .obsidian/graph.json  # Obsidian native graph-view colour groups (Phase 6)
"""

from __future__ import annotations

from pathlib import Path

# --- directory layout -------------------------------------------------------

WIKI_SUBDIRS: tuple[str, ...] = ("sources", "entities", "concepts", "sessions")

TOP_LEVEL_DIRS: tuple[str, ...] = ("drop", "raw", "wiki", ".index", ".vault-meta", "_templates")

# --- file layout -------------------------------------------------------------

SCHEMA_FILE = "schema.md"
INDEX_FILE = "index.md"
HOT_FILE = "hot.md"
OBSIDIAN_DIR = ".obsidian"
OBSIDIAN_CONFIG_FILE = "app.json"
OBSIDIAN_GRAPH_FILE = "graph.json"
OBSIDIAN_CORE_PLUGINS_FILE = "core-plugins.json"
TEMPLATES_DIR = "_templates"


def vault_dirs(root: Path) -> list[Path]:
    """Return the full list of directories a well-formed vault must contain."""
    root = Path(root)
    dirs = [root / d for d in TOP_LEVEL_DIRS]
    dirs.extend(root / "wiki" / sub for sub in WIKI_SUBDIRS)
    dirs.append(root / OBSIDIAN_DIR)
    return dirs


def vault_files(root: Path) -> list[Path]:
    """Return the full list of top-level files a well-formed vault must contain."""
    root = Path(root)
    return [
        root / SCHEMA_FILE,
        root / INDEX_FILE,
        root / HOT_FILE,
        root / OBSIDIAN_DIR / OBSIDIAN_CONFIG_FILE,
        root / OBSIDIAN_DIR / OBSIDIAN_GRAPH_FILE,
        root / OBSIDIAN_DIR / OBSIDIAN_CORE_PLUGINS_FILE,
    ]


def is_initialized(root: Path) -> bool:
    """Return True if every required vault directory and file already exists."""
    root = Path(root)
    return all(d.is_dir() for d in vault_dirs(root)) and all(
        f.is_file() for f in vault_files(root)
    )
