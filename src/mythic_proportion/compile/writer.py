"""Write compiled :class:`WikiPage` objects to disk (Phase 3).

Two safety properties, both load-bearing:

* **Advisory per-file locking.** Before writing ``<page>.md`` we create
  ``<page>.md.lock``. A lock older than ``STALE_LOCK_SECONDS`` is treated as
  abandoned (e.g. a crashed writer) and reaped rather than honoured forever.
* **Never silently overwrite a human edit.** Every machine-written page
  stores a ``compiled_hash`` (SHA-256 of its body) in frontmatter. If the
  page already exists on disk and its *current* body hash no longer matches
  its own stored ``compiled_hash``, a human (or some other process) has
  edited it since the last compile — we append a ``> [!merge]`` note instead
  of clobbering their edit.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from mythic_proportion.compile.models import WikiPage

STALE_LOCK_SECONDS = 60

WriteAction = Literal["created", "updated", "merged"]


@dataclass
class WriteOutcome:
    """What happened when writing one page."""

    path: Path
    action: WriteAction
    title: str
    merge_note: str | None = None


def _compute_body_hash(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _ensure_h1(title: str, body: str) -> str:
    """Prepend ``# {title}`` to ``body`` if it doesn't already start with it.

    This is how ``graph.py`` (and any future reader) recovers a page's title
    from disk without needing a dedicated frontmatter field.
    """
    stripped = body.lstrip("\n")
    first_line = stripped.splitlines()[0].strip() if stripped else ""
    if first_line == f"# {title}":
        return body
    return f"# {title}\n\n{body.lstrip()}"


def render_frontmatter(frontmatter: dict[str, Any]) -> str:
    """Render a flat frontmatter dict (str/list[str] values only) as YAML-ish text."""
    lines = ["---"]
    for key, value in frontmatter.items():
        if isinstance(value, (list, tuple)):
            lines.append(f"{key}: [{', '.join(str(v) for v in value)}]")
        else:
            lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def parse_page(text: str) -> tuple[dict[str, Any], str]:
    """Parse a page written by :func:`render_frontmatter` back into (frontmatter, body).

    Deliberately only supports the flat subset of YAML this module ever
    writes (scalars and single-line flow lists) — good enough since we are
    both the sole writer of this format and its only reader.
    """
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    fm_text, body = parts[1], parts[2].lstrip("\n")
    frontmatter: dict[str, Any] = {}
    for line in fm_text.strip().splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            frontmatter[key] = [v.strip() for v in inner.split(",") if v.strip()] if inner else []
        else:
            frontmatter[key] = value
    return frontmatter, body


class _AdvisoryLock:
    """Create-exclusive lock file with stale-lock reaping."""

    def __init__(self, lock_path: Path, stale_seconds: int = STALE_LOCK_SECONDS) -> None:
        self._lock_path = lock_path
        self._stale_seconds = stale_seconds
        self._acquired = False

    def __enter__(self) -> "_AdvisoryLock":
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = open(self._lock_path, "x", encoding="utf-8")
            fd.write(str(time.time()))
            fd.close()
        except FileExistsError:
            age = time.time() - self._lock_path.stat().st_mtime
            if age > self._stale_seconds:
                self._lock_path.unlink(missing_ok=True)
                fd = open(self._lock_path, "x", encoding="utf-8")
                fd.write(str(time.time()))
                fd.close()
            else:
                raise RuntimeError(
                    f"page locked by another writer: {self._lock_path} (age={age:.1f}s)"
                ) from None
        self._acquired = True
        return self

    def __exit__(self, *exc_info: object) -> None:
        if self._acquired:
            self._lock_path.unlink(missing_ok=True)


def write_page(
    vault_root: Path,
    page: WikiPage,
    *,
    now: datetime | None = None,
) -> WriteOutcome:
    """Write (or merge-safely update) one compiled page under ``vault_root``."""
    vault_root = Path(vault_root)
    full_path = vault_root / page.path
    lock_path = full_path.with_name(full_path.name + ".lock")

    now = now or datetime.now(timezone.utc)
    now_iso = now.isoformat()
    body = _ensure_h1(page.title, page.body)
    new_hash = _compute_body_hash(body)

    with _AdvisoryLock(lock_path):
        if full_path.is_file():
            existing_fm, existing_body = parse_page(full_path.read_text(encoding="utf-8"))
            stored_hash = existing_fm.get("compiled_hash")
            disk_hash = _compute_body_hash(existing_body)

            if stored_hash is not None and disk_hash != stored_hash:
                # Human (or some other process) edited this page since the
                # last compile. Never clobber it — append a merge note.
                merge_note = (
                    f"\n\n> [!merge] Compile on {now_iso} proposed an update to this page, "
                    "but it was edited since the last compile, so the proposed content was "
                    f"not applied automatically (proposed hash: {new_hash[:12]}).\n"
                )
                merged_body = existing_body.rstrip("\n") + "\n" + merge_note
                fm = dict(existing_fm)
                fm["updated"] = now_iso
                full_path.write_text(
                    render_frontmatter(fm) + "\n" + merged_body, encoding="utf-8"
                )
                return WriteOutcome(
                    path=page.path, action="merged", title=page.title, merge_note=merge_note
                )

            fm = {
                "type": page.page_type,
                "source_hash": page.frontmatter.get("source_hash", existing_fm.get("source_hash", "")),
                "created": existing_fm.get("created", now_iso),
                "updated": now_iso,
                "tags": page.frontmatter.get("tags", existing_fm.get("tags", [])),
                "compiled_hash": new_hash,
            }
            full_path.write_text(render_frontmatter(fm) + "\n" + body, encoding="utf-8")
            return WriteOutcome(path=page.path, action="updated", title=page.title)

        fm = {
            "type": page.page_type,
            "source_hash": page.frontmatter.get("source_hash", ""),
            "created": now_iso,
            "updated": now_iso,
            "tags": page.frontmatter.get("tags", []),
            "compiled_hash": new_hash,
        }
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(render_frontmatter(fm) + "\n" + body, encoding="utf-8")
        return WriteOutcome(path=page.path, action="created", title=page.title)
