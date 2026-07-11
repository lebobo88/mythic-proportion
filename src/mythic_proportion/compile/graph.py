"""Resolve the wikilink graph after a write: dangling-link stubs, index, hot (Phase 3).

After ``writer.write_page`` has landed a compile's pages on disk, this module:

1. Scans every page currently in ``wiki/`` for ``[[wikilinks]]``.
2. Creates a minimal **stub page** for any link target that doesn't resolve
   to an existing page title (tagged ``stub`` so ``lint --fix`` in Phase 5
   can find and eventually flesh them out).
3. Appends a fresh backlink catalogue block to ``index.md`` (append-only —
   never rewrites earlier blocks, per the Phase 1 invariant).
4. Refreshes ``hot.md`` with a short recent-context summary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mythic_proportion.compile.models import WikiPage
from mythic_proportion.compile.writer import parse_page, write_page
from mythic_proportion.vault.layout import HOT_FILE, INDEX_FILE, WIKI_SUBDIRS

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")

_HOT_WORD_BUDGET = 500


@dataclass
class GraphResult:
    """What changed while resolving the graph for one compile call."""

    stub_titles: list[str] = field(default_factory=list)
    page_count: int = 0


def _iter_wiki_pages(vault_root: Path) -> list[Path]:
    wiki_dir = Path(vault_root) / "wiki"
    if not wiki_dir.is_dir():
        return []
    pages: list[Path] = []
    for sub in WIKI_SUBDIRS:
        sub_dir = wiki_dir / sub
        if not sub_dir.is_dir():
            continue
        pages.extend(sorted(p for p in sub_dir.glob("*.md") if p.is_file()))
    return pages


def derive_title(frontmatter: dict[str, Any], body: str, page_path: Path | str) -> str:
    """Recover a page's display title via a three-step fallback chain.

    1. frontmatter ``title:`` if present and non-empty.
    2. the first Markdown H1 (``# ...``) in ``body``.
    3. a humanized version of the filename stem (guarantees a non-empty,
       readable title even for a page with neither of the above -- e.g. a
       degraded/human-authored page missing both a frontmatter title and an
       H1).

    Used by every reader that needs a page's display title (the indexer,
    ``lint``, ``existing_page_titles``) so title resolution is identical
    everywhere rather than each caller re-deriving it slightly differently.
    """
    fm_title = frontmatter.get("title")
    if isinstance(fm_title, str) and fm_title.strip():
        return fm_title.strip()

    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            heading = stripped[2:].strip()
            if heading:
                return heading

    return Path(page_path).stem.replace("-", " ").replace("_", " ").title()


def read_page_title(path: Path) -> str:
    """Recover a page's title from disk via :func:`derive_title`'s fallback chain."""
    frontmatter, body = parse_page(Path(path).read_text(encoding="utf-8"))
    return derive_title(frontmatter, body, path)


def extract_links(body: str) -> list[str]:
    """Return every ``[[Wikilink]]`` target title referenced in ``body``."""
    return [m.strip() for m in _WIKILINK_RE.findall(body)]


def existing_page_titles(vault_root: Path) -> list[str]:
    """Every page title currently on disk — the dedup digest used by ``prompt.py``."""
    return sorted({read_page_title(p) for p in _iter_wiki_pages(vault_root)}, key=str.lower)


def resolve_graph(vault_root: Path, *, now: datetime | None = None) -> GraphResult:
    """Create stub pages for dangling links, then rebuild ``index.md``/``hot.md``.

    Idempotent: running it again with no new pages/links produces no new
    stubs and simply appends a fresh (unchanged) catalogue snapshot to the
    append-only index.
    """
    vault_root = Path(vault_root)
    now = now or datetime.now(timezone.utc)

    pages = _iter_wiki_pages(vault_root)
    title_by_path = {p: read_page_title(p) for p in pages}
    titles_lower = {t.lower() for t in title_by_path.values()}

    links_by_title: dict[str, list[str]] = {t: [] for t in title_by_path.values()}
    dangling: dict[str, str] = {}  # lowercased -> first-seen original casing
    for path, title in title_by_path.items():
        _fm, body = parse_page(path.read_text(encoding="utf-8"))
        for target in extract_links(body):
            links_by_title.setdefault(title, []).append(target)
            if target.lower() not in titles_lower and target.lower() not in dangling:
                dangling[target.lower()] = target

    stub_titles: list[str] = []
    for target_title in dangling.values():
        stub = WikiPage.new(
            page_type="concept",
            title=target_title,
            body=(
                f"Stub page — created automatically because it was referenced via "
                f"[[{target_title}]] but did not yet exist.\n"
            ),
            tags=["stub"],
        )
        write_page(vault_root, stub, now=now)
        stub_titles.append(target_title)
        titles_lower.add(target_title.lower())
        title_by_path[vault_root / stub.path] = target_title
        links_by_title.setdefault(target_title, [])

    # Recompute backlinks now that stubs exist too.
    backlinks: dict[str, list[str]] = {t: [] for t in title_by_path.values()}
    for source_title, targets in links_by_title.items():
        for target in targets:
            for candidate_title in title_by_path.values():
                if candidate_title.lower() == target.lower():
                    backlinks.setdefault(candidate_title, []).append(source_title)
                    break

    _append_index_snapshot(vault_root, title_by_path, backlinks, now=now)

    return GraphResult(stub_titles=stub_titles, page_count=len(title_by_path))


def _append_index_snapshot(
    vault_root: Path,
    title_by_path: dict[Path, str],
    backlinks: dict[str, list[str]],
    *,
    now: datetime,
) -> None:
    index_path = Path(vault_root) / INDEX_FILE
    lines = [f"\n## Catalogue snapshot — {now.isoformat()}\n"]
    for path in sorted(title_by_path, key=lambda p: title_by_path[p].lower()):
        title = title_by_path[path]
        rel_path = path.relative_to(vault_root).as_posix()
        backlink_titles = sorted(set(backlinks.get(title, [])) - {title}, key=str.lower)
        backlink_text = ", ".join(f"[[{t}]]" for t in backlink_titles) or "(none)"
        lines.append(f"- [[{title}]] (`{rel_path}`) — backlinks: {backlink_text}")
    lines.append("")

    if not index_path.is_file():
        index_path.write_text("# Index\n", encoding="utf-8")
    with index_path.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def refresh_hot(
    vault_root: Path,
    *,
    recent_titles: list[str],
    summary: str | None = None,
) -> None:
    """Rewrite ``hot.md`` with a short recent-context cache.

    ``summary`` is an optional LLM-produced blurb (~500 words); when absent
    (degraded / no client) a deterministic bullet list of recently touched
    page titles is used instead so ``hot.md`` is always in a useful state.
    """
    hot_path = Path(vault_root) / HOT_FILE
    lines = ["# Hot", "", "Recent-context cache (~500 words), refreshed on every compile.", ""]

    if summary:
        words = summary.split()
        lines.append(" ".join(words[:_HOT_WORD_BUDGET]))
    elif recent_titles:
        lines.append("## Recently compiled pages")
        lines.append("")
        for title in recent_titles:
            lines.append(f"- [[{title}]]")
    else:
        lines.append("(nothing compiled yet)")

    hot_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
