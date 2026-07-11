"""Read-through ``llm_cache`` wrapper for GraphRAG extraction calls (Phase 3).

Every extraction LLM call (entity/relationship extraction, gleaning,
malformed-output repair, claim extraction) is routed through
:func:`read_through_complete`, keyed on ``sha256(system || user || model)``.
This is what makes re-indexing an unchanged vault free (zero new LLM calls,
all cache hits) and re-indexing a changed one cheap (only the changed text
units' prompts are new cache keys) -- see
:mod:`mythic_proportion.graph.index`.
"""

from __future__ import annotations

import hashlib
import sqlite3
from typing import Protocol, runtime_checkable


def cache_key(*, system: str, user: str, model: str) -> str:
    """``sha256(system || "\\x00" || user || "\\x00" || model)``, hex-encoded.

    The NUL separators make the key unambiguous even if ``system``/``user``
    text happens to contain the literal string used elsewhere as a
    delimiter (unlike a plain ``"||"`` join).
    """
    payload = "\x00".join((system, user, model)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class LlmCache:
    """Thin CRUD wrapper over the ``llm_cache`` table on the shared index DB."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def get(self, key: str) -> str | None:
        row = self._conn.execute(
            "SELECT response FROM llm_cache WHERE cache_key = ?", (key,)
        ).fetchone()
        return row["response"] if row is not None else None

    def set(self, key: str, response: str) -> None:
        self._conn.execute(
            "INSERT INTO llm_cache(cache_key, response) VALUES (?, ?) "
            "ON CONFLICT(cache_key) DO UPDATE SET response = excluded.response",
            (key, response),
        )
        self._conn.commit()


@runtime_checkable
class _CompletingClient(Protocol):
    def complete(self, *, system: str, user: str) -> str: ...


def read_through_complete(
    client: _CompletingClient, cache: LlmCache, *, system: str, user: str, model: str
) -> tuple[str, bool]:
    """Return ``(response, was_cache_hit)`` for one prompted-completion call.

    On a cache miss, calls ``client.complete(system=..., user=...)`` once and
    stores the result before returning it -- so a second call with the exact
    same ``(system, user, model)`` never reaches ``client`` again.
    """
    key = cache_key(system=system, user=user, model=model)
    cached = cache.get(key)
    if cached is not None:
        return cached, True
    response = client.complete(system=system, user=user)
    cache.set(key, response)
    return response, False
