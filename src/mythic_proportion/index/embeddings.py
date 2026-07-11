"""Pluggable embedding backends for the hybrid index (Phase 4).

Every retrieval component depends only on the :class:`Embedder` Protocol, not
on a concrete backend, so the vector-search half of the index degrades
gracefully instead of hard-requiring a model download:

* :class:`HashEmbedder` -- deterministic, dependency-free, offline. This is
  the backend every Phase-4 test uses, and the zero-dependency default the
  rest of the app falls back to.
* :class:`FastEmbedEmbedder` -- a real local-model backend. Imports
  ``fastembed`` lazily (inside ``__init__``, never at module import time) so
  the base install never requires the extra.

:func:`get_embedder` is the factory both :class:`~mythic_proportion.index.store.IndexStore`
and the CLI use to turn ``Settings.embeddings_backend`` into a concrete
``Embedder | None`` (``None`` meaning "run BM25-only").
"""

from __future__ import annotations

import hashlib
import math
from typing import Protocol, runtime_checkable

from mythic_proportion.config import Settings


@runtime_checkable
class Embedder(Protocol):
    """Anything that can turn text into fixed-width, L2-normalized vectors."""

    dim: int

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def l2_normalize(vector: list[float]) -> list[float]:
    """Return ``vector`` scaled to unit length (unchanged if already zero)."""
    norm = math.sqrt(sum(component * component for component in vector))
    if norm == 0.0:
        return list(vector)
    return [component / norm for component in vector]


class HashEmbedder:
    """Deterministic, dependency-free embedder (feature hashing trick).

    Each text is whitespace-tokenized; every token is hashed into one of
    ``dim`` signed buckets (a standard hashing-trick embedding) and the
    resulting vector is L2-normalized. The same input text always produces
    the same vector, with no model weights, no network access, and no
    third-party dependency -- which is exactly what makes it safe to run in
    every Phase-4 test regardless of what is or isn't installed on the host.
    """

    def __init__(self, dim: int = 64) -> None:
        if dim <= 0:
            raise ValueError("dim must be a positive integer")
        self.dim = dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        for token in text.lower().split():
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            bucket = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[bucket] += sign
        return l2_normalize(vector)


class FastEmbedEmbedder:
    """Real local embedding model via the optional ``fastembed`` package.

    ``fastembed`` is imported lazily inside ``__init__`` (never at module
    scope), so simply importing this module -- or this whole package -- never
    requires the ``[embeddings]`` extra to be installed.
    """

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5") -> None:
        try:
            from fastembed import TextEmbedding
        except ImportError as exc:  # pragma: no cover - exercised only when installed
            raise RuntimeError(
                "FastEmbedEmbedder requires the 'embeddings' extra: "
                "pip install 'mythic-proportion[embeddings]'"
            ) from exc
        self._model = TextEmbedding(model_name=model_name)
        probe = list(self._model.embed(["dimension probe"]))
        self.dim = len(probe[0])

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [l2_normalize(list(vector)) for vector in self._model.embed(texts)]


def get_embedder(settings: Settings) -> Embedder | None:
    """Resolve ``settings.embeddings_backend`` into a concrete embedder.

    * ``"none"`` / ``"off"`` / ``"disabled"`` -> ``None`` (BM25-only mode).
    * ``"fastembed"`` -> :class:`FastEmbedEmbedder`, falling back to
      :class:`HashEmbedder` if the optional dependency isn't installed (the
      index must never hard-fail for lack of an optional extra).
    * anything else (including the ``"local"`` default) -> :class:`HashEmbedder`,
      today's zero-dependency local backend.
    """
    backend = settings.embeddings_backend
    if backend in ("none", "off", "disabled"):
        return None
    if backend == "fastembed":
        try:
            return FastEmbedEmbedder()
        except RuntimeError:
            return HashEmbedder()
    return HashEmbedder()
