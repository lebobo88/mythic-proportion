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
