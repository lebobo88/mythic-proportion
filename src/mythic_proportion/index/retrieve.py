"""Three-tier hybrid retrieval over an :class:`IndexStore` (Phase 4).

Tier 1 -- FTS5 BM25 candidate generation (always available, no embedder
required).
Tier 2 -- embed the query and cosine-rerank the BM25 candidate set (``vec0``
or the pure-Python fallback, whichever the store is using) into one blended
score.
Tier 3 -- (optional, filler-only) if fewer than ``k`` results were found,
expand one hop via ``[[wikilinks]]`` out of the top hits, lightly boosted
below anything found directly.

When the store has no embedder configured (``store.embedder is None``),
:func:`hybrid_search` degrades to BM25-only and every hit is tagged
``tier="bm25"`` -- this is the graceful "no vectors available" mode required
by the plan.
"""

from __future__ import annotations

from mythic_proportion.compile.graph import extract_links
from mythic_proportion.index.embeddings import l2_normalize
from mythic_proportion.index.store import IndexStore, SearchHit

_BM25_WEIGHT = 0.45
_VECTOR_WEIGHT = 0.55
_EXPANSION_DECAY = 0.5


def hybrid_search(store: IndexStore, query: str, k: int = 8) -> list[SearchHit]:
    """Return up to ``k`` :class:`SearchHit` results for ``query``."""
    bm25_hits = store.bm25_search(query, limit=max(k * 4, 20))

    if store.embedder is None:
        return bm25_hits[:k]

    query_vector = l2_normalize(store.embedder.embed([query])[0])

    # Seed the vector-candidate set from the BM25 hits; if BM25 found
    # nothing at all (e.g. the query has no lexical overlap with any page),
    # fall back to scoring every indexed page so vector similarity alone can
    # still surface a result.
    candidate_paths = [hit.page_path for hit in bm25_hits] or store.all_page_paths()
    vector_scores = store.vector_scores(query_vector, candidate_paths)

    bm25_by_path = {hit.page_path: hit for hit in bm25_hits}
    max_bm25_score = max((hit.score for hit in bm25_hits), default=0.0) or 1.0

    all_paths = set(candidate_paths) | set(bm25_by_path)
    combined: list[SearchHit] = []
    for path in all_paths:
        bm25_hit = bm25_by_path.get(path)
        bm25_norm = (bm25_hit.score / max_bm25_score) if bm25_hit else 0.0
        vector_score = vector_scores.get(path, 0.0)
        score = _BM25_WEIGHT * bm25_norm + _VECTOR_WEIGHT * max(vector_score, 0.0)
        title = bm25_hit.title if bm25_hit else store.get_title(path)
        snippet = bm25_hit.snippet if bm25_hit else store.get_snippet(path)
        combined.append(SearchHit(path, title, score, snippet, "hybrid"))

    combined.sort(key=lambda hit: hit.score, reverse=True)
    top = combined[:k]

    if len(top) < k:
        exclude = {hit.page_path for hit in top}
        top = top + _expand_via_wikilinks(store, top, exclude=exclude, limit=k - len(top))

    return top


def _expand_via_wikilinks(
    store: IndexStore, seeds: list[SearchHit], *, exclude: set[str], limit: int
) -> list[SearchHit]:
    """Tier 3: pull in pages one hop away via ``[[wikilinks]]`` from ``seeds``."""
    if limit <= 0 or not seeds:
        return []

    titles_to_paths = store.title_index()
    seen_targets: set[str] = set()
    expansion: list[SearchHit] = []

    for seed in seeds:
        body = store.get_body(seed.page_path)
        for link_title in extract_links(body):
            key = link_title.lower()
            if key in seen_targets:
                continue
            seen_targets.add(key)
            match = titles_to_paths.get(key)
            if match is None:
                continue
            page_path, title = match
            if page_path in exclude:
                continue
            expansion.append(
                SearchHit(page_path, title, seed.score * _EXPANSION_DECAY, store.get_snippet(page_path), "expanded")
            )
            exclude.add(page_path)
            if len(expansion) >= limit:
                return expansion

    return expansion
