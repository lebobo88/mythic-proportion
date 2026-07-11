"""Pydantic models shared across the compile step (Phase 3).

A compile run turns one :class:`~mythic_proportion.ingest.models.IngestedSource`
into a set of interlinked wiki pages. These models are the contract between
``prompt.py`` (what we ask for), ``client.py`` (fake or real, what answers the
ask), and ``writer.py``/``graph.py`` (what gets written to disk) — every one
of those modules imports from here rather than redefining the shape.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

PageType = Literal["source", "entity", "concept", "session"]

#: Maps a page type to its plural wiki subdirectory, matching
#: ``vault.layout.WIKI_SUBDIRS``.
PAGE_TYPE_TO_DIR: dict[PageType, str] = {
    "source": "sources",
    "entity": "entities",
    "concept": "concepts",
    "session": "sessions",
}

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(title: str) -> str:
    """Turn an arbitrary page title into a filesystem-safe, lowercase slug."""
    slug = _SLUG_RE.sub("-", title.strip().lower()).strip("-")
    return slug or "page"


def default_page_path(page_type: PageType, title: str) -> Path:
    """The conventional ``wiki/<type-plural>/<slug>.md`` path for a page."""
    return Path("wiki") / PAGE_TYPE_TO_DIR[page_type] / f"{slugify(title)}.md"


class WikiPage(BaseModel):
    """One compiled wiki page, not yet written to disk.

    ``path`` is relative to the vault root (e.g. ``wiki/sources/my-doc.md``).
    ``frontmatter`` carries caller-supplied overrides (``tags``,
    ``source_hash``, ...); ``writer.write_page`` fills in/normalizes the rest
    of the frontmatter contract (``type``, ``created``, ``updated``,
    ``compiled_hash``) on write.
    """

    path: Path
    page_type: PageType
    title: str
    frontmatter: dict[str, Any] = Field(default_factory=dict)
    body: str

    @classmethod
    def new(
        cls,
        *,
        page_type: PageType,
        title: str,
        body: str,
        tags: list[str] | None = None,
        source_hash: str | None = None,
        path: Path | None = None,
    ) -> "WikiPage":
        """Convenience constructor that fills in the conventional path."""
        fm: dict[str, Any] = {"tags": tags or []}
        if source_hash is not None:
            fm["source_hash"] = source_hash
        return cls(
            path=path or default_page_path(page_type, title),
            page_type=page_type,
            title=title,
            frontmatter=fm,
            body=body,
        )


class CompileResult(BaseModel):
    """The full outcome of one compile call (fake or real)."""

    pages: list[WikiPage] = Field(default_factory=list)
    contradictions: list[str] = Field(default_factory=list)
    links_created: list[str] = Field(default_factory=list)


class CompileError(Exception):
    """Raised when no LLM provider is configured, or a real compile call fails
    after retries.

    ``pipeline.compile_source`` lets this propagate to the caller (CLI,
    watcher, tests) rather than falling back to any stub/offline page — a
    working LLM is required for compile.
    """
