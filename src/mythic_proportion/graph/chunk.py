"""Text-unit chunking for the GraphRAG data layer (Phase 3).

Splits a page's Markdown body into small, stable "text units" -- the atoms
entity/relationship/claim extraction runs over. Boundaries prefer Markdown
headings first (semantic sections), falling back to blank-line paragraph
breaks for any section still larger than ``max_chars``. Each unit carries a
``content_hash`` so :mod:`mythic_proportion.graph.index` can diff exactly
which units changed since the last index run and skip re-extracting the rest
(the incremental/idempotent contract).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

_HEADING_RE = re.compile(r"^(#{1,6})\s+.*$", re.MULTILINE)
_PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n")

DEFAULT_MAX_CHARS = 800


@dataclass
class TextUnitChunk:
    """One chunked, hashable slice of a page body, ready to persist/extract."""

    chunk_index: int
    text: str
    n_tokens: int
    content_hash: str


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _split_by_headings(body: str) -> list[str]:
    matches = list(_HEADING_RE.finditer(body))
    if not matches:
        return [body]

    sections: list[str] = []
    if matches[0].start() > 0:
        sections.append(body[: matches[0].start()])
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        sections.append(body[start:end])
    return [s for s in sections if s.strip()]


def _split_oversized(section: str, max_chars: int) -> list[str]:
    if len(section) <= max_chars:
        return [section]

    paragraphs = _PARAGRAPH_SPLIT_RE.split(section)
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if not paragraph.strip():
            continue
        if current and len(current) + len(paragraph) + 2 > max_chars:
            chunks.append(current)
            current = paragraph
        else:
            current = f"{current}\n\n{paragraph}" if current else paragraph
    if current:
        chunks.append(current)
    return chunks or [section]


def chunk_text(body: str, *, max_chars: int = DEFAULT_MAX_CHARS) -> list[TextUnitChunk]:
    """Chunk ``body`` into ordered, content-hashed :class:`TextUnitChunk` units.

    Deterministic (same input -> same chunks/hashes/order every time), which
    is what lets :mod:`mythic_proportion.graph.index` diff chunk sets across
    re-index runs. Returns ``[]`` for empty/whitespace-only input.
    """
    stripped = body.strip()
    if not stripped:
        return []

    sections = _split_by_headings(stripped)
    raw_chunks: list[str] = []
    for section in sections:
        raw_chunks.extend(_split_oversized(section, max_chars))

    units: list[TextUnitChunk] = []
    chunk_index = 0
    for text in raw_chunks:
        text = text.strip()
        if not text:
            continue
        units.append(
            TextUnitChunk(
                chunk_index=chunk_index,
                text=text,
                n_tokens=len(text.split()),
                content_hash=_content_hash(text),
            )
        )
        chunk_index += 1
    return units
