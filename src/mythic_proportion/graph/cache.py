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


CACHE_SCHEMA_VERSION = "2"
"""Folded into every :func:`cache_key`. Bumped (1 -> 2) by the Reflexion-retry
fix for the cache-boundary PII/REDACTED_* survival defect (turn-scoped
redaction moved to be keyed on the REDACTED text, not the raw text -- see
:mod:`mythic_proportion.graph.extract`'s ``_cached_turn_call``). Bumping this
constant is what makes every ``llm_cache`` row written under the OLD
(pre-fix) code -- including rows holding fully-rehydrated real-PII response
text from the original one-shot ``complete()`` path -- permanently
unreachable under the new key space, instead of relying only on the implicit
"redacted text differs from raw text" key-basis change to keep them from
ever being blindly replayed. Bump this again for any future change to what
``cache_key``'s inputs mean."""


def cache_key(*, system: str, user: str, model: str) -> str:
    """``sha256(version || "\\x00" || system || "\\x00" || user || "\\x00" || model)``,
    hex-encoded.

    The NUL separators make the key unambiguous even if ``system``/``user``
    text happens to contain the literal string used elsewhere as a
    delimiter (unlike a plain ``"||"`` join). ``version`` is
    :data:`CACHE_SCHEMA_VERSION` -- see its docstring for why it's folded in.
    """
    payload = "\x00".join((CACHE_SCHEMA_VERSION, system, user, model)).encode("utf-8")
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
