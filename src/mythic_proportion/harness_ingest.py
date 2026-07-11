"""Harness-aware ingest recipe (Phase 6).

Optional convenience: copies (never moves — the harness's own copies are left
untouched) a FABLE-HARNESS run's ``specs/``, ``memory/``, and the most
recently modified ``.fable/`` artifacts into ``<vault_root>/drop/``, then runs
the ordinary :func:`~mythic_proportion.ingest.pipeline.ingest_drop` pipeline
over them — no separate ingest code path.

This only ever pulls *from* a harness root *into* a vault, on explicit
request. Per N8, the harness's own operation never depends on this running;
this module has no callers anywhere else in the FABLE-HARNESS tooling.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from mythic_proportion.ingest.pipeline import IngestReport, ingest_drop

#: How many of the most-recently-modified files under ``.fable/`` to pull in
#: by default — a harness run's ``.fable/`` directory can otherwise be large
#: and much of it (telemetry, per-stage scratch) isn't durable-knowledge
#: material worth compiling into the wiki.
DEFAULT_FABLE_ARTIFACT_LIMIT = 20

_HARNESS_SOURCE_DIRS: tuple[str, ...] = ("specs", "memory")


@dataclass
class HarnessCollectReport:
    """What :func:`collect_harness_sources` copied (or found missing)."""

    copied: list[Path] = field(default_factory=list)
    skipped_missing: list[str] = field(default_factory=list)


def _flatten_name(prefix: str, rel_path: Path) -> str:
    """Turn ``memory/decisions/foo.md`` into ``memory__decisions__foo.md``.

    ``drop/`` has no subdirectory structure, so nested harness paths are
    flattened with double-underscore separators to avoid filename collisions
    while staying traceable back to their source path.
    """
    return f"{prefix}__{rel_path.as_posix().replace('/', '__')}"


def _copy_tree_flattened(
    src_dir: Path, dest_dir: Path, prefix: str, copied: list[Path]
) -> None:
    if not src_dir.is_dir():
        return
    for path in sorted(src_dir.rglob("*")):
        if not path.is_file():
            continue
        dest_name = _flatten_name(prefix, path.relative_to(src_dir))
        dest_path = dest_dir / dest_name
        if dest_path.exists():
            continue  # already staged for ingest (e.g. a prior harness-ingest run)
        shutil.copy2(path, dest_path)
        copied.append(dest_path)


def collect_harness_sources(
    harness_root: Path,
    vault_root: Path,
    *,
    fable_artifact_limit: int = DEFAULT_FABLE_ARTIFACT_LIMIT,
) -> HarnessCollectReport:
    """Copy ``specs/``, ``memory/``, and recent ``.fable/`` artifacts into ``drop/``.

    Any of the three source directories may be absent (e.g. no run has
    started yet) — that is recorded in ``skipped_missing``, not raised.
    """
    harness_root = Path(harness_root)
    vault_root = Path(vault_root)
    drop_dir = vault_root / "drop"
    drop_dir.mkdir(parents=True, exist_ok=True)

    report = HarnessCollectReport()

    for prefix in _HARNESS_SOURCE_DIRS:
        source_dir = harness_root / prefix
        if source_dir.is_dir():
            _copy_tree_flattened(source_dir, drop_dir, prefix, report.copied)
        else:
            report.skipped_missing.append(f"{prefix}/")

    fable_dir = harness_root / ".fable"
    if fable_dir.is_dir():
        artifact_files = [p for p in fable_dir.rglob("*") if p.is_file()]
        artifact_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        for path in artifact_files[:fable_artifact_limit]:
            dest_name = _flatten_name("fable", path.relative_to(fable_dir))
            dest_path = drop_dir / dest_name
            if dest_path.exists():
                continue
            shutil.copy2(path, dest_path)
            report.copied.append(dest_path)
    else:
        report.skipped_missing.append(".fable/")

    return report


def ingest_harness(
    harness_root: Path,
    vault_root: Path,
    *,
    fable_artifact_limit: int = DEFAULT_FABLE_ARTIFACT_LIMIT,
    compile: bool = False,
) -> tuple[HarnessCollectReport, IngestReport]:
    """Copy a harness's own artifacts into ``drop/`` and ingest them.

    ``compile`` defaults to ``False`` here (unlike the CLI's ``ingest`` verb,
    which defaults to ``True``) since a harness's ``specs/``/``memory/``/
    ``.fable/`` tree is often bulky; callers wanting compiled wiki pages can
    pass ``compile=True`` or run ``mythic ingest --compile`` (or
    ``compile.pipeline.compile_pending``) on the resulting vault afterward.
    """
    collect_report = collect_harness_sources(
        harness_root, vault_root, fable_artifact_limit=fable_artifact_limit
    )
    ingest_report = ingest_drop(vault_root)

    if compile and ingest_report.ingested:
        from mythic_proportion.compile.pipeline import compile_source
        from mythic_proportion.config import load_settings

        settings = load_settings(vault_root)
        for source in ingest_report.ingested:
            compile_source(vault_root, source, settings=settings)

    return collect_report, ingest_report
