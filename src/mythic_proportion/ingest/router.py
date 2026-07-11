"""Classify a dropped file into one of the three ``IngestedSource`` kinds.

Classification is a pure, extension-driven function (MIME is derived from the
extension via :mod:`mimetypes` as a secondary signal only) so it is trivially
unit-testable with no I/O beyond the path itself.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path

from mythic_proportion.ingest.models import SourceKind

DOCUMENT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".pdf",
        ".docx",
        ".pptx",
        ".xlsx",
        ".html",
        ".htm",
        ".md",
        ".txt",
        ".rtf",
        ".odt",
    }
)

IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".tiff",
        ".tif",
        ".gif",
        ".bmp",
    }
)

ARTIFACT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py",
        ".js",
        ".ts",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".csv",
        ".log",
        ".sh",
        ".sql",
    }
)


def classify(path: Path) -> SourceKind:
    """Classify ``path`` into ``document``, ``image``, or ``artifact``.

    Unknown/unlisted extensions fall back to ``artifact`` — the safest
    default for anything code-adjacent or otherwise unrecognized.
    """
    ext = Path(path).suffix.lower()
    if ext in DOCUMENT_EXTENSIONS:
        return "document"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in ARTIFACT_EXTENSIONS:
        return "artifact"
    return "artifact"


def guess_mime(path: Path) -> str:
    """Best-effort MIME type for ``path``, defaulting to a generic binary type."""
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"
