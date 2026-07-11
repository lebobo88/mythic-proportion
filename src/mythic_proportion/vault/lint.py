"""Vault health check: orphans, broken links, index staleness, thin pages (Phase 5).

``lint_vault`` is the read-only diagnostic pass; ``lint_fix`` is the
auto-repair pass, reusing exactly the same building blocks the rest of the
app already relies on:

* dangling wikilinks -> stub pages, via
  :func:`~mythic_proportion.compile.graph.resolve_graph` (the same stub logic
  Phase 3's compile step uses for a compile-time dangling link);
* dead/stale index rows -> pruned/refreshed via
  :meth:`~mythic_proportion.index.store.IndexStore.reindex` (the same
  incremental sync ``mythic reindex`` uses);
* ``hot.md`` -> refreshed via
  :func:`~mythic_proportion.compile.graph.refresh_hot`.
"""

from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from mythic_proportion.compile.graph import (
    existing_page_titles,
    extract_links,
    read_page_title,
    refresh_hot,
    resolve_graph,
)
from mythic_proportion.compile.writer import parse_page
from mythic_proportion.config import Settings, load_settings
from mythic_proportion.index.embeddings import get_embedder
from mythic_proportion.index.store import INDEX_DB_RELATIVE_PATH, IndexStore, ReindexReport
from mythic_proportion.vault.layout import WIKI_SUBDIRS

#: Body content below this many characters (after stripping) is flagged as
#: "thin" unless it's an intentional graph-created stub (tagged ``stub``
#: without also being tagged ``needs-compile``).
THIN_PAGE_MIN_CHARS = 80


@dataclass(frozen=True)
class _PageInfo:
    path: str
    title: str
    tags: list[str]
    body: str


@dataclass(frozen=True)
class OrphanPage:
    """A page with no inbound and no outbound ``[[wikilinks]]``."""

    title: str
    path: str


@dataclass(frozen=True)
class DanglingLink:
    """A ``[[wikilink]]`` whose target page does not exist on disk."""

    source_title: str
    source_path: str
    target_title: str


@dataclass(frozen=True)
class StaleIndexEntry:
    """An indexed row that no longer matches (or has no) on-disk page."""

    page_path: str
    reason: str  # "content_changed" | "missing_on_disk"


@dataclass(frozen=True)
class ThinPage:
    """A page whose body is suspiciously short (and not an intentional stub)."""

    title: str
    path: str
    char_count: int


@dataclass
class LintReport:
    """Everything :func:`lint_vault` found, plus a nonzero-exit-code signal."""

    orphans: list[OrphanPage] = field(default_factory=list)
    dangling_links: list[DanglingLink] = field(default_factory=list)
    stale_index_entries: list[StaleIndexEntry] = field(default_factory=list)
    thin_pages: list[ThinPage] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """``True`` iff every check came back clean."""
        return not (self.orphans or self.dangling_links or self.stale_index_entries or self.thin_pages)

    @property
    def exit_code(self) -> int:
        """``0`` when clean, ``1`` when any problem remains -- for CLI wiring."""
        return 0 if self.ok else 1

    def summary(self) -> str:
        """A human-readable report, suitable for printing to a terminal."""
        if self.ok:
            return "Vault is clean: no orphans, no broken links, no stale index rows, no thin pages."

        lines = ["Vault lint found issues:"]
        if self.orphans:
            lines.append(f"\nOrphan pages ({len(self.orphans)}) -- no inbound or outbound links:")
            lines.extend(f"  - [[{o.title}]] ({o.path})" for o in self.orphans)
        if self.dangling_links:
            lines.append(f"\nBroken wikilinks ({len(self.dangling_links)}):")
            lines.extend(
                f"  - [[{d.source_title}]] ({d.source_path}) -> [[{d.target_title}]] (missing)"
                for d in self.dangling_links
            )
        if self.stale_index_entries:
            lines.append(f"\nStale index rows ({len(self.stale_index_entries)}):")
            lines.extend(f"  - {s.page_path} ({s.reason})" for s in self.stale_index_entries)
        if self.thin_pages:
            lines.append(f"\nThin/empty pages ({len(self.thin_pages)}):")
            lines.extend(f"  - [[{t.title}]] ({t.path}, {t.char_count} chars)" for t in self.thin_pages)
        return "\n".join(lines)


@dataclass
class LintFixResult:
    """What :func:`lint_fix` changed on disk."""

    stubs_created: list[str] = field(default_factory=list)
    index_report: ReindexReport = field(default_factory=ReindexReport)
    hot_refreshed: bool = False


def _content_hash(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _collect_pages(vault_root: Path) -> list[_PageInfo]:
    wiki_dir = vault_root / "wiki"
    pages: list[_PageInfo] = []
    if not wiki_dir.is_dir():
        return pages
    for sub in WIKI_SUBDIRS:
        sub_dir = wiki_dir / sub
        if not sub_dir.is_dir():
            continue
        for md_path in sorted(sub_dir.glob("*.md")):
            if not md_path.is_file():
                continue
            frontmatter, body = parse_page(md_path.read_text(encoding="utf-8"))
            raw_tags = frontmatter.get("tags", [])
            tags = [str(t) for t in raw_tags] if isinstance(raw_tags, list) else [str(raw_tags)]
            title = read_page_title(md_path)
            rel_path = md_path.relative_to(vault_root).as_posix()
            pages.append(_PageInfo(path=rel_path, title=title, tags=tags, body=body))
    return pages


def _lint_orphans_and_dangling(pages: list[_PageInfo]) -> tuple[list[OrphanPage], list[DanglingLink]]:
    titles_lower = {page.title.lower() for page in pages}
    outbound: dict[str, list[str]] = {}
    inbound: set[str] = set()
    dangling: list[DanglingLink] = []

    for page in pages:
        targets = extract_links(page.body)
        outbound[page.title] = targets
        for target in targets:
            if target.lower() not in titles_lower:
                dangling.append(
                    DanglingLink(source_title=page.title, source_path=page.path, target_title=target)
                )
            elif target.lower() != page.title.lower():
                inbound.add(target.lower())

    orphans = [
        OrphanPage(title=page.title, path=page.path)
        for page in pages
        if not outbound.get(page.title) and page.title.lower() not in inbound
    ]
    return orphans, dangling


def _lint_thin_pages(pages: list[_PageInfo], *, min_chars: int) -> list[ThinPage]:
    thin: list[ThinPage] = []
    for page in pages:
        needs_compile = "needs-compile" in page.tags
        is_stub = "stub" in page.tags
        char_count = len(page.body.strip())
        if needs_compile:
            # A needs-compile stub: it has real excerpt content (so it may
            # not be short by character count), but it's still a coverage
            # gap awaiting a real LLM compile pass -- always flag it.
            thin.append(ThinPage(title=page.title, path=page.path, char_count=char_count))
        elif is_stub:
            continue  # an intentional graph-created dangling-link stub -- not a gap
        elif char_count < min_chars:
            thin.append(ThinPage(title=page.title, path=page.path, char_count=char_count))
    return thin


def _lint_stale_index(vault_root: Path, pages: list[_PageInfo]) -> list[StaleIndexEntry]:
    db_path = vault_root / INDEX_DB_RELATIVE_PATH
    if not db_path.is_file():
        return []

    body_by_path = {page.path: page.body for page in pages}
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT page_path, content_hash FROM pages").fetchall()
    except sqlite3.OperationalError:
        rows = []
    finally:
        conn.close()

    stale: list[StaleIndexEntry] = []
    for row in rows:
        page_path = row["page_path"]
        if page_path not in body_by_path:
            stale.append(StaleIndexEntry(page_path=page_path, reason="missing_on_disk"))
        elif _content_hash(body_by_path[page_path]) != row["content_hash"]:
            stale.append(StaleIndexEntry(page_path=page_path, reason="content_changed"))
    return stale


def lint_vault(vault_root: Path, *, thin_page_min_chars: int = THIN_PAGE_MIN_CHARS) -> LintReport:
    """Run every Phase 5 health check over ``vault_root`` and return a report.

    Read-only: never writes to the vault. See :func:`lint_fix` for the
    auto-repair pass.
    """
    vault_root = Path(vault_root)
    pages = _collect_pages(vault_root)
    orphans, dangling = _lint_orphans_and_dangling(pages)
    thin_pages = _lint_thin_pages(pages, min_chars=thin_page_min_chars)
    stale = _lint_stale_index(vault_root, pages)
    return LintReport(
        orphans=orphans,
        dangling_links=dangling,
        stale_index_entries=stale,
        thin_pages=thin_pages,
    )


def lint_fix(vault_root: Path, *, settings: Settings | None = None) -> LintFixResult:
    """Auto-fix what can safely be auto-fixed.

    * Dangling wikilinks get stub pages (reusing
      :func:`~mythic_proportion.compile.graph.resolve_graph`'s exact stub
      logic, which also refreshes the append-only ``index.md`` catalogue).
    * The SQLite hybrid-search sidecar is reindexed, pruning rows for pages
      no longer on disk and refreshing changed ones.
    * ``hot.md`` is refreshed with the current set of page titles.

    Orphan pages and thin/stub pages are diagnostic-only and are never
    auto-fixed here -- creating plausible content for them requires
    judgement (or an LLM compile pass), not a mechanical repair.
    """
    vault_root = Path(vault_root)
    settings = settings or load_settings(vault_root)

    graph_result = resolve_graph(vault_root)

    embedder = get_embedder(settings)
    with IndexStore(vault_root, embedder) as store:
        index_report = store.reindex(vault_root)

    refresh_hot(vault_root, recent_titles=existing_page_titles(vault_root))

    return LintFixResult(
        stubs_created=graph_result.stub_titles,
        index_report=index_report,
        hot_refreshed=True,
    )
