"""Answer a question against the vault (Phase 5; LLM-required as of the
AuthHub migration; Phase 4 adds a ``mode`` parameter selecting a GraphRAG
retrieval strategy).

``answer_query`` is the single entry point every caller (CLI, tests) should
use. Its **default legacy path** (``mode="auto"`` with no graph data
present) is unchanged from before Phase 4: it ensures the SQLite
hybrid-search sidecar is fresh (via
:meth:`~mythic_proportion.index.store.IndexStore.reindex`), assembles context
from ``hot.md`` plus the top-``k`` :func:`~mythic_proportion.index.retrieve.hybrid_search`
hits, then synthesizes a cited answer through an injectable
:class:`~mythic_proportion.query.client.AnswerClient` (the client configured
by ``settings.llm_provider``, or one explicitly passed in -- e.g. a
:class:`~mythic_proportion.query.client.FakeAnswerClient` in tests). A
working LLM is required: if no provider is configured, or the client raises,
:class:`~mythic_proportion.query.client.AnswerError` propagates -- there is
no more offline "ranked pages" synthesis fallback here (pure retrieval still
lives in the Search tab / :func:`~mythic_proportion.index.retrieve.hybrid_search`).

Phase 4 adds ``mode: "global" | "local" | "drift" | "activation" | "auto"``
(:mod:`mythic_proportion.query.modes`): explicitly requesting one of the four
GraphRAG modes routes entirely through the graph layer instead (and through a
prompted-strict-JSON :class:`~mythic_proportion.graph.extract.ExtractionClient`,
not the tool-calling ``AnswerClient`` -- see ``query.modes``'s module
docstring). ``mode="auto"`` (the default) preserves the legacy behavior
exactly whenever the graph layer has never been populated (``entities`` is
empty) -- every pre-Phase-4 caller/test that never runs ``index-graph``
observes zero behavior change -- and only picks a GraphRAG mode once graph
data actually exists.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from mythic_proportion.config import Settings, authhub_api_key, authhub_base_url, load_settings
from mythic_proportion.graph.cache import LlmCache
from mythic_proportion.graph.extract import ExtractionClient
from mythic_proportion.graph.store import GraphStore
from mythic_proportion.index.embeddings import get_embedder
from mythic_proportion.index.retrieve import hybrid_search
from mythic_proportion.index.store import IndexStore, SearchHit
from mythic_proportion.query.client import AnswerClient, AnswerError, AnthropicAnswerClient
from mythic_proportion.query.modes import (
    ModeResult,
    activation_search,
    drift_search,
    global_search,
    local_search,
)
from mythic_proportion.query.prompt import build_answer_prompt
from mythic_proportion.vault.layout import HOT_FILE

_CITATION_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")

#: Every explicit GraphRAG mode ``answer_query`` accepts (``"auto"`` resolves
#: to one of these, or to the legacy path -- see :func:`_resolve_mode`).
GRAPH_MODES: tuple[str, ...] = ("global", "local", "drift", "activation")

_GLOBAL_KEYWORDS = ("overview", "summary", "summarize", "overall", "in general", "across the vault")


@dataclass
class QueryAnswer:
    """The full outcome of one ``answer_query`` call."""

    text: str
    citations: list[str] = field(default_factory=list)
    hits: list[SearchHit] = field(default_factory=list)
    used_llm: bool = False


def _default_client(settings: Settings) -> AnswerClient:
    """Build the client for ``settings.llm_provider``.

    Raises :class:`AnswerError` with an actionable message if the required
    credential is missing -- a working LLM is required for query synthesis as
    of the AuthHub migration; there is no longer a "return None -> degrade"
    path.
    """
    if settings.llm_provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise AnswerError(
                "LLM not configured: set ANTHROPIC_API_KEY (provider=anthropic, "
                f"model={settings.model!r})"
            )
        return AnthropicAnswerClient(model=settings.model, api_key=api_key)

    if settings.llm_provider == "authhub":
        api_key = authhub_api_key()
        base_url = authhub_base_url(settings)
        if not api_key:
            raise AnswerError(
                f"LLM not configured: set AUTHHUB_API_KEY (provider=authhub, base_url={base_url!r})"
            )
        from mythic_proportion.llm.authhub import AuthHubAnswerClient

        return AuthHubAnswerClient(
            base_url=base_url,
            api_key=api_key,
            model=settings.llm_model,
            route_alias=settings.route_alias or None,
        )

    raise AnswerError(f"LLM not configured: unknown llm_provider {settings.llm_provider!r}")


def _default_extraction_client(settings: Settings) -> ExtractionClient:
    """Build the prompted-strict-JSON :class:`ExtractionClient` GraphRAG mode
    synthesis routes through (see ``query.modes``'s module docstring for why
    this is a *different* client shape than :func:`_default_client`'s
    tool-calling :class:`AnswerClient`). Raises :class:`AnswerError` with the
    same actionable-credential-message shape as :func:`_default_client`."""
    api_key = authhub_api_key()
    if not api_key:
        raise AnswerError(
            f"LLM not configured: set AUTHHUB_API_KEY (provider=authhub, "
            f"base_url={authhub_base_url(settings)!r})"
        )
    from mythic_proportion.graph.extract import AuthHubExtractionClient

    return AuthHubExtractionClient(
        base_url=authhub_base_url(settings),
        api_key=api_key,
        model=settings.llm_model,
        route_alias=settings.route_alias or None,
    )


def _read_hot(vault_root: Path) -> str:
    hot_path = vault_root / HOT_FILE
    return hot_path.read_text(encoding="utf-8") if hot_path.is_file() else ""


def _resolve_mode(mode: str, question: str, *, has_graph_data: bool) -> str | None:
    """Resolve a caller-supplied ``mode`` into one of :data:`GRAPH_MODES`, or
    ``None`` meaning "the legacy hybrid-search + AnswerClient path".

    ``"auto"`` (the default) is the load-bearing case: it resolves to
    ``None`` whenever the graph layer has never been populated
    (``has_graph_data`` is False) -- so every caller that never runs
    ``index-graph`` observes the exact pre-Phase-4 behavior, unchanged. Once
    graph data exists, a small keyword heuristic picks GLOBAL for
    broad/overview-shaped questions and LOCAL otherwise (DRIFT/activation are
    only reachable via an explicit ``mode=`` -- "auto" never guesses either,
    since both are more expensive multi-step flows).
    """
    if mode == "auto":
        if not has_graph_data:
            return None
        lowered = question.lower()
        if any(keyword in lowered for keyword in _GLOBAL_KEYWORDS):
            return "global"
        return "local"
    if mode in GRAPH_MODES:
        return mode
    if mode == "legacy":
        return None
    raise ValueError(f"unknown query mode {mode!r}: expected one of auto|legacy|{'|'.join(GRAPH_MODES)}")


def _mode_result_to_answer(result: ModeResult) -> QueryAnswer:
    return QueryAnswer(text=result.text, citations=result.citations, hits=[], used_llm=result.used_llm)


def answer_query(
    vault_root: Path,
    question: str,
    *,
    k: int = 8,
    use_llm: bool = True,
    mode: str = "auto",
    client: AnswerClient | None = None,
    graph_client: ExtractionClient | None = None,
    settings: Settings | None = None,
) -> QueryAnswer:
    """Answer ``question`` against the vault at ``vault_root``.

    ``client`` overrides automatic client selection for the legacy path
    (used by tests to inject a
    :class:`~mythic_proportion.query.client.FakeAnswerClient`);
    ``graph_client`` does the same for the ``mode="global"|"local"|"drift"|
    "activation"`` GraphRAG paths (inject a
    :class:`~mythic_proportion.graph.extract.FakeExtractionClient`).
    ``use_llm`` defaults to ``True`` and synthesis is now mandatory: if no
    client is configured, or the chosen client raises,
    :class:`~mythic_proportion.query.client.AnswerError` propagates.

    ``mode`` selects the retrieval strategy: ``"auto"`` (default) preserves
    the exact legacy hybrid-search behavior until the graph layer has data,
    then auto-picks a GraphRAG mode; ``"legacy"`` forces the pre-Phase-4 path
    unconditionally; ``"global"``/``"local"``/``"drift"``/``"activation"``
    force one specific GraphRAG mode (see :mod:`mythic_proportion.query.modes`).
    """
    vault_root = Path(vault_root)
    settings = settings or load_settings(vault_root)
    embedder = get_embedder(settings)

    with IndexStore(vault_root, embedder) as store:
        # Keep the sidecar fresh before every query -- cheap for a
        # personal-vault-sized corpus, and guarantees retrieval never serves
        # stale/deleted pages.
        store.reindex(vault_root)

        graph_store = GraphStore(store.conn)
        has_graph_data = bool(graph_store.all_entity_ids())
        resolved_mode = _resolve_mode(mode, question, has_graph_data=has_graph_data)

        if resolved_mode is not None:
            if not use_llm:
                raise AnswerError("LLM synthesis is required: answer_query was called with use_llm=False")
            active_graph_client = (
                graph_client if graph_client is not None else _default_extraction_client(settings)
            )
            cache = LlmCache(store.conn)
            mode_result: ModeResult
            if resolved_mode == "global":
                mode_result = global_search(
                    store.conn, question, client=active_graph_client, cache=cache, model=settings.llm_model
                )
            elif resolved_mode == "local":
                mode_result = local_search(
                    store.conn,
                    question,
                    client=active_graph_client,
                    cache=cache,
                    model=settings.llm_model,
                    embedder=embedder,
                    vec_active=store.vec_active,
                )
            elif resolved_mode == "drift":
                mode_result = drift_search(
                    store.conn,
                    question,
                    client=active_graph_client,
                    cache=cache,
                    model=settings.llm_model,
                    embedder=embedder,
                    vec_active=store.vec_active,
                )
            else:
                mode_result = activation_search(
                    store.conn,
                    question,
                    client=active_graph_client,
                    cache=cache,
                    model=settings.llm_model,
                    embedder=embedder,
                    vec_active=store.vec_active,
                )
            return _mode_result_to_answer(mode_result)

        hits = hybrid_search(store, question, k=k)
        body_by_path = {hit.page_path: store.get_body(hit.page_path) for hit in hits}

    if not use_llm:
        raise AnswerError("LLM synthesis is required: answer_query was called with use_llm=False")

    active_client = client if client is not None else _default_client(settings)

    hot_md = _read_hot(vault_root)
    prompt = build_answer_prompt(question=question, hot_md=hot_md, hits=hits, body_by_path=body_by_path)

    answer_result = active_client.answer(prompt)

    citations = answer_result.citations or _CITATION_RE.findall(answer_result.text)
    return QueryAnswer(text=answer_result.text, citations=citations, hits=hits, used_llm=True)
