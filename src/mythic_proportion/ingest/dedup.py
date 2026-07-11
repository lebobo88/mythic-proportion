"""Content-hash dedup: SHA-256 hashing plus a persisted provenance ledger.

The ledger lives at ``<vault_root>/.vault-meta/ingested.json`` and maps
content hash -> provenance record (original name, raw path, ingested_at,
etc.). It is the single source of truth ``ingest_drop`` consults to decide
whether a dropped file has already been ingested.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_CHUNK_SIZE = 1024 * 1024  # 1 MiB

#: Bounds the retry loop in :func:`_atomic_write_json` for the transient
#: Windows "sharing violation" `os.replace` can raise when two threads race
#: to replace the exact same destination path at (near-)the same instant.
_REPLACE_MAX_ATTEMPTS = 10
_REPLACE_RETRY_DELAY_S = 0.01


#: One `threading.Lock` per resolved ledger path, created on first use and
#: shared by every `Ledger` instance pointed at that path within this
#: process. `record()`'s read-merge-write is only safe from a lost update
#: when the whole sequence is serialized -- re-reading-before-write alone
#: narrows the race window but does not close it under genuine concurrency
#: (two threads can each read the same pre-state before either writes).
#: This lock closes it for any writers *within this process*; the web
#: ingest path additionally serializes writers structurally, via
#: `web.jobs.IngestWorker`'s single worker thread, so this lock is now a
#: defense-in-depth backstop rather than the only thing standing between a
#: concurrent write and a lost entry.
_ledger_locks: dict[str, threading.Lock] = {}
_ledger_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    key = str(Path(path).resolve())
    with _ledger_locks_guard:
        lock = _ledger_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _ledger_locks[key] = lock
        return lock


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    """Write ``data`` to ``path`` as JSON via a write-to-temp-then-replace.

    ``os.replace`` is atomic on both POSIX and Windows, so a reader never
    observes a half-written file, and a crash mid-write never corrupts the
    ledger -- it just leaves a stray ``.tmp-*`` file behind. On Windows,
    ``os.replace`` can raise a transient ``PermissionError`` (sharing
    violation) when two threads happen to call it against the same
    destination path at (near-)the same instant; that's retried a bounded
    number of times with a short backoff rather than propagating spuriously.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True, default=str)

    for attempt in range(_REPLACE_MAX_ATTEMPTS):
        try:
            os.replace(tmp_path, path)
            return
        except PermissionError:
            if attempt == _REPLACE_MAX_ATTEMPTS - 1:
                raise
            time.sleep(_REPLACE_RETRY_DELAY_S)


def content_hash(path_or_bytes: Path | bytes) -> str:
    """Return the SHA-256 hex digest of a file's contents or a raw bytes blob."""
    digest = hashlib.sha256()
    if isinstance(path_or_bytes, (bytes, bytearray)):
        digest.update(path_or_bytes)
        return digest.hexdigest()

    path = Path(path_or_bytes)
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


class Ledger:
    """Persisted hash -> provenance mapping backed by a JSON file.

    Every mutating call (:meth:`record`) re-reads the file from disk before
    merging its change in and writing back atomically (write-to-temp-then-
    ``os.replace``). This bounds the lost-update window for any two writers
    touching the same ledger file -- in the web path this race is now also
    structurally impossible in-process (see ``web.jobs.IngestWorker``, the
    single serialized writer), but the ledger itself stays safe even if a
    second writer (e.g. a concurrent CLI run) shows up later.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._entries: dict[str, dict[str, Any]] = self._load()

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.is_file():
            return {}
        with self.path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        return data

    def save(self) -> None:
        _atomic_write_json(self.path, self._entries)

    def already_ingested(self, content_hash_value: str) -> bool:
        return content_hash_value in self._entries

    def get(self, content_hash_value: str) -> dict[str, Any] | None:
        return self._entries.get(content_hash_value)

    def record(
        self,
        content_hash_value: str,
        *,
        original_name: str,
        raw_path: Path,
        kind: str,
        ingested_at: datetime | None = None,
    ) -> None:
        # Serialize the whole read-merge-write against any other writer (in
        # this process) targeting the same path, then re-read from disk so
        # a writer from *outside* this process isn't clobbered either.
        with _lock_for(self.path):
            self._entries = {**self._load(), **self._entries}
            self._entries[content_hash_value] = {
                "original_name": original_name,
                "raw_path": str(raw_path),
                "kind": kind,
                "ingested_at": (ingested_at or datetime.now(timezone.utc)).isoformat(),
            }
            self.save()

    def __len__(self) -> int:
        return len(self._entries)

    def __contains__(self, content_hash_value: str) -> bool:
        return content_hash_value in self._entries

    def items(self) -> list[tuple[str, dict[str, Any]]]:
        """Return ``(content_hash, provenance)`` pairs for every ledger entry.

        Additive, read-only enumeration used by ``compile.pipeline.compile_pending``
        to discover ingested-but-not-yet-compiled sources across process
        restarts. Does not change any existing method's behavior.
        """
        return list(self._entries.items())
