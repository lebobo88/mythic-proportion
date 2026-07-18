"""Shared "collect every wiki page" helper for the web UI (Phase 7).

Mirrors the read pattern already established by
:mod:`mythic_proportion.vault.lint` and :mod:`mythic_proportion.index.store`
(walk ``wiki/<type-plural>/*.md``, parse frontmatter via
:func:`~mythic_proportion.compile.writer.parse_page`, derive the title via
:func:`~mythic_proportion.compile.graph.derive_title`) rather than
reimplementing page discovery -- this module only adds the specific shape the
web API endpoints need (outbound links, a title->path index) on top of that
same building block.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from mythic_proportion.compile.graph import derive_title, extract_links
from mythic_proportion.compile.writer import parse_page
from mythic_proportion.ingest.dedup import Ledger
from mythic_proportion.ingest.pipeline import LEDGER_RELATIVE_PATH, default_parser_registry
from mythic_proportion.vault.layout import WIKI_SUBDIRS

_DIR_TO_PAGE_TYPE: dict[str, str] = {
    "sources": "source",
    "entities": "entity",
    "concepts": "concept",
    "sessions": "session",
}


@dataclass
class PageInfo:
    """Everything the web API needs to know about one on-disk wiki page."""

    path: str  # vault-relative, e.g. "wiki/concepts/foo.md"
    title: str
    page_type: str
    tags: list[str]
    frontmatter: dict[str, object]
    body: str
    outbound: list[str] = field(default_factory=list)  # raw wikilink target titles


def collect_pages(vault_root: Path) -> list[PageInfo]:
    """Return a :class:`PageInfo` for every page currently under ``wiki/``."""
    vault_root = Path(vault_root)
    wiki_dir = vault_root / "wiki"
    pages: list[PageInfo] = []
    if not wiki_dir.is_dir():
        return pages

    for sub in WIKI_SUBDIRS:
        sub_dir = wiki_dir / sub
        if not sub_dir.is_dir():
            continue
        for md_path in sorted(sub_dir.glob("*.md")):
            if not md_path.is_file():
                continue
            text = md_path.read_text(encoding="utf-8")
            frontmatter, body = parse_page(text)
            raw_tags = frontmatter.get("tags", [])
            tags = [str(t) for t in raw_tags] if isinstance(raw_tags, list) else [str(raw_tags)]
            page_type = str(frontmatter.get("type") or _DIR_TO_PAGE_TYPE.get(sub, sub))
            title = derive_title(frontmatter, body, md_path)
            rel_path = md_path.relative_to(vault_root).as_posix()
            pages.append(
                PageInfo(
                    path=rel_path,
                    title=title,
                    page_type=page_type,
                    tags=tags,
                    frontmatter=frontmatter,
                    body=body,
                    outbound=extract_links(body),
                )
            )
    return pages


def collect_raw_sources(vault_root: Path) -> list[PageInfo]:
    """Return a :class:`PageInfo` for every raw ingested source currently
    recorded in the dedup ledger (``.vault-meta/ingested.json``), re-parsed
    via the exact same parser registry :func:`~mythic_proportion.ingest.pipeline.ingest_drop`
    used at ingest time.

    This is GraphRAG extraction's source of truth (see
    :func:`mythic_proportion.graph.index.reindex_graph`) -- deliberately
    the *original*, uncompressed ingested documents in ``raw/``, not
    :func:`collect_pages`'s ``wiki/`` output. ``wiki/`` pages are
    LLM-compiled summaries capped at a few thousand characters
    (:mod:`mythic_proportion.compile.pipeline`/:mod:`.prompt`) -- extracting
    entities/relationships/claims from that lossy intermediate instead of
    the real source material was the root cause of near-empty GraphRAG data
    on real vaults with substantial source documents. This function is
    entirely independent of, and does not affect, the separate
    wikilink-derived page graph (:mod:`mythic_proportion.compile.graph`)
    that already powers the Wiki view's in/out link counts.

    Re-parses on every call rather than caching the parsed Markdown on disk
    (:func:`~mythic_proportion.ingest.pipeline.ingest_drop` only persists it
    transiently, in ``.vault-meta/staging/``, which is not guaranteed to
    survive) -- acceptable at personal-vault scale, and the *chunk-level*
    ``content_hash`` diff in ``graph.index`` still means an unchanged source
    costs zero LLM calls even though it costs one reparse.

    A raw file that's been moved/deleted since ingest, or whose kind has no
    registered parser, or that fails to (re-)parse (e.g. a heavy optional
    parsing dependency installed at ingest time but missing now) is skipped
    rather than aborting the whole call -- mirrors :func:`~mythic_proportion.ingest.pipeline.ingest_drop`'s
    own "a single bad file must never abort the run" contract.
    """
    # Resolved once, up front: `entry["raw_path"]` in the ledger is whatever
    # absolute/relative form `ingest_drop` happened to be called with
    # (usually absolute -- see `ingest.pipeline.ingest_drop`'s
    # `raw_dir = vault_root / "raw"`), which need not match the form *this*
    # call's `vault_root` argument was passed in (e.g. a relative
    # `--vault playground` CLI argument against an absolute ledger entry).
    # Resolving both sides before `relative_to` makes the comparison
    # path-form-independent instead of raising `ValueError` on a mismatch.
    vault_root = Path(vault_root).resolve()
    ledger_path = vault_root / LEDGER_RELATIVE_PATH
    if not ledger_path.is_file():
        return []

    ledger = Ledger(ledger_path)
    registry = default_parser_registry()
    sources: list[PageInfo] = []

    for content_hash_value, entry in sorted(ledger.items()):
        stored_raw_path = Path(entry.get("raw_path", ""))
        raw_path = stored_raw_path if stored_raw_path.is_absolute() else vault_root / stored_raw_path
        raw_path = raw_path.resolve()
        if not raw_path.is_file():
            # Legacy-vault compatibility (Codex J-001 remediation cycle,
            # finding J-004): before `ingest.pipeline.ingest_drop` resolved
            # `vault_root` to absolute (fixed in this same job), a relative
            # `--vault demo-vault` invocation (run from the *parent* of the
            # vault directory) recorded a `raw_path` in the ledger like
            # `"demo-vault/raw/<hash>.md"` -- CWD-relative, but happening to
            # be PREFIXED with the vault directory's own name. Naively
            # joining that onto an already-resolved `vault_root` above
            # double-prepends the vault name and finds nothing. That fix
            # only prevents *new* ledger writes from recording this broken
            # shape; a vault ingested before the fix stays silently broken
            # without this healing step. If the stored path's first
            # component matches this vault's own directory name, retry with
            # that one component stripped before giving up.
            legacy_parts = stored_raw_path.parts
            if legacy_parts and legacy_parts[0] == vault_root.name:
                healed_path = vault_root.joinpath(*legacy_parts[1:]).resolve()
                if healed_path.is_file():
                    raw_path = healed_path
        if not raw_path.is_file():
            continue  # moved/deleted since ingest -- skip, don't error

        kind = entry.get("kind", "document")
        parser = registry.get(kind)
        if parser is None:
            continue

        try:
            body = parser(raw_path)
        except Exception:
            # A single source failing to (re-)parse must never abort a
            # whole graph reindex -- e.g. a heavy optional dependency
            # (Docling) installed at ingest time but missing now.
            continue

        original_name = str(entry.get("original_name") or raw_path.name)
        try:
            rel_path = raw_path.relative_to(vault_root).as_posix()
        except ValueError:
            # A raw file that somehow lives outside this vault's own raw/
            # dir (e.g. a ledger copied/merged from a different vault) --
            # skip rather than raise, same "never abort the whole reindex"
            # contract as every other per-source failure above.
            continue
        sources.append(
            PageInfo(
                path=rel_path,
                title=original_name,
                page_type="source",
                tags=[],
                frontmatter={"content_hash": content_hash_value},
                body=body,
            )
        )
    return sources


def title_to_path_index(pages: list[PageInfo]) -> dict[str, str]:
    """``{lowercased title: vault-relative path}`` for every page, for wikilink resolution."""
    return {page.title.lower(): page.path for page in pages}


def backlinks_index(pages: list[PageInfo]) -> dict[str, list[str]]:
    """``{lowercased title: [titles of pages linking to it]}`` (self-links excluded)."""
    backlinks: dict[str, list[str]] = {}
    for page in pages:
        for target in page.outbound:
            key = target.lower()
            if key == page.title.lower():
                continue
            backlinks.setdefault(key, []).append(page.title)
    return backlinks
