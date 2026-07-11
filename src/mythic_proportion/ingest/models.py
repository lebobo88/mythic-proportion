"""Pydantic models and errors for the ingestion pipeline (Phase 2)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SourceKind = Literal["document", "image", "artifact"]


class IngestError(Exception):
    """Raised for a general, recoverable ingestion failure for a single file.

    The pipeline never lets this propagate out of ``ingest_drop``: it is
    caught per-file, recorded in the returned report, and processing of the
    remaining files continues.
    """


class IngestDependencyError(IngestError):
    """Raised when a heavy optional parsing dependency is missing at call time.

    Adapters lazy-import their real library only when actually invoked, so
    the base package stays importable (and installable) with zero heavy
    dependencies. Callers see a clear install hint instead of an ImportError.
    """


class IngestedSource(BaseModel):
    """A single file that has been classified, parsed, hashed, and preserved."""

    model_config = ConfigDict(frozen=True)

    original_name: str
    content_hash: str
    raw_path: Path
    kind: SourceKind
    parsed_markdown: str
    mime: str
    bytes: int
    ingested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = Field(default_factory=dict)
