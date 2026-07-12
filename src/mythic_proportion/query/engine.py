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
docstring).

``mode`` has **no default** here (``None``) and its handling is a *static*
property of the call, never a runtime property of vault/graph state:
``mode=None`` (the caller omitted it entirely) always takes the exact
pre-Phase-4 legacy path, unconditionally, regardless of whether the graph
layer has data. Explicit ``mode="auto"`` is the opt-in heuristic dispatch --
it resolves to the legacy path only while the graph layer has never been
populated, then auto-picks a GraphRAG mode once graph data exists. Explicit
``mode="legacy"`` forces the legacy path unconditionally; explicit
``mode="global"|"local"|"drift"|"activation"`` forces that one GraphRAG mode
unconditionally. See ``memory/invariants.md``'s "mythic-proportion `POST
/api/query` contract -- CORRECTION" entry for the binding contract this
resolves against.
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
    """The full outcome of one ``answer_query`` call.

    ``resolved_mode`` is ``None`` whenever the legacy path was taken
    (including the omitted-``mode``/legacy-contract case) and one of
    :data:`GRAPH_MODES` otherwise. It is always populated by
    :func:`answer_query`; callers that must preserve the exact legacy
    response shape (e.g. ``web.app.api_query`` on an omitted-``mode``
    request) simply don't surface it -- this field itself is strictly
    additive and never part of the legacy contract.
    """

    text: str
    citations: list[str] = field(default_factory=list)
    hits: list[SearchHit] = field(default_factory=list)
    used_llm: bool = False
    resolved_mode: str | None = None


def _maybe_redact(client: AnswerClient, settings: Settings) -> AnswerClient:
    """Wrap ``client`` in :class:`~mythic_proportion.privacy.redact.RedactingAnswerClient`
    when redaction is enabled and available (see
    :func:`mythic_proportion.privacy.redact.get_redactor`); returns ``client``
    unchanged only when redaction is explicitly disabled.

    **Fail-closed**: if redaction is enabled but unavailable, raises
    :class:`AnswerError` rather than silently returning the unwrapped
    ``client`` -- no answer call is made with potentially-unredacted content.
    """
    from mythic_proportion.privacy.redact import RedactingAnswerClient, RedactionUnavailableError, get_redactor

    try:
        redactor = get_redactor(settings)
    except RedactionUnavailableError as exc:
        raise AnswerError(f"Redaction is enabled but unavailable: {exc}") from exc
    if redactor is None:
        return client
    return RedactingAnswerClient(client, redactor)  # type: ignore[return-value]


def _default_client(settings: Settings) -> AnswerClient:
    """Build the client for ``settings.llm_provider``.

    Raises :class:`AnswerError` with an actionable message if the required
    credential is missing -- a working LLM is required for query synthesis as
    of the AuthHub migration; there is no longer a "return None -> degrade"
    path.

    Phase 6: ``settings.local`` is checked *first* and, when ``True``,
    unconditionally routes to :class:`~mythic_proportion.llm.ollama.OllamaAnswerClient`
    regardless of ``settings.llm_provider`` -- the per-vault "never touch the
    cloud" guarantee. Explicit ``llm_provider="ollama"`` (with ``local`` left
    ``False``) does the same thing opt-in-per-provider rather than
    vault-wide. ``settings.ollama_base_url`` must be loopback-only:
    ``OllamaAnswerClient``'s own constructor enforces this unconditionally
    (``llm.ollama._OllamaBase.__init__``), so a non-loopback URL is converted
    to :class:`AnswerError` here rather than propagating as a raw
    ``OllamaConfigError``. Every real client built here is wrapped with
    :func:`_maybe_redact` before being returned.
    """
    if settings.local or settings.llm_provider == "ollama":
        from mythic_proportion.llm.ollama import OllamaAnswerClient, OllamaConfigError

        try:
            ollama_client = OllamaAnswerClient(base_url=settings.ollama_base_url, model=settings.ollama_model)
        except OllamaConfigError as exc:
            raise AnswerError(str(exc)) from exc

        return _maybe_redact(ollama_client, settings)

    if settings.llm_provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise AnswerError(
                "LLM not configured: set ANTHROPIC_API_KEY (provider=anthropic, "
                f"model={settings.model!r})"
            )
        return _maybe_redact(AnthropicAnswerClient(model=settings.model, api_key=api_key), settings)

    if settings.llm_provider == "authhub":
        api_key = authhub_api_key()
        base_url = authhub_base_url(settings)
        if not api_key:
            raise AnswerError(
                f"LLM not configured: set AUTHHUB_API_KEY (provider=authhub, base_url={base_url!r})"
            )
        from mythic_proportion.llm.authhub import AuthHubAnswerClient

        return _maybe_redact(
            AuthHubAnswerClient(
                base_url=base_url,
                api_key=api_key,
                model=settings.llm_model,
                route_alias=settings.route_alias or None,
            ),
            settings,
        )

    raise AnswerError(f"LLM not configured: unknown llm_provider {settings.llm_provider!r}")


def _maybe_redact_extraction(client: ExtractionClient, settings: Settings) -> ExtractionClient:
    """:func:`_maybe_redact`'s counterpart for :class:`ExtractionClient`.

    **Fail-closed**: raises :class:`AnswerError` (matching this module's
    other extraction-path error type -- see :func:`_default_extraction_client`)
    if redaction is enabled but unavailable, rather than silently returning
    the unwrapped ``client``.
    """
    from mythic_proportion.privacy.redact import RedactingExtractionClient, RedactionUnavailableError, get_redactor

    try:
        redactor = get_redactor(settings)
    except RedactionUnavailableError as exc:
        raise AnswerError(f"Redaction is enabled but unavailable: {exc}") from exc
    if redactor is None:
        return client
    return RedactingExtractionClient(client, redactor)  # type: ignore[return-value]


def _default_extraction_client(settings: Settings) -> ExtractionClient:
    """Build the prompted-strict-JSON :class:`ExtractionClient` GraphRAG mode
    synthesis routes through (see ``query.modes``'s module docstring for why
    this is a *different* client shape than :func:`_default_client`'s
    tool-calling :class:`AnswerClient`). Raises :class:`AnswerError` with the
    same actionable-credential-message shape as :func:`_default_client`.

    Phase 6: ``settings.local`` (or explicit ``llm_provider="ollama"``) routes
    to :class:`~mythic_proportion.llm.ollama.OllamaExtractionClient`, same as
    :func:`_default_client`. ``settings.ollama_base_url`` must be
    loopback-only, enforced by the client's own constructor and converted to
    :class:`AnswerError` here (see :func:`_default_client`'s docstring)."""
    if settings.local or settings.llm_provider == "ollama":
        from mythic_proportion.llm.ollama import OllamaConfigError, OllamaExtractionClient

        try:
            ollama_client = OllamaExtractionClient(base_url=settings.ollama_base_url, model=settings.ollama_model)
        except OllamaConfigError as exc:
            raise AnswerError(str(exc)) from exc

        return _maybe_redact_extraction(ollama_client, settings)

    api_key = authhub_api_key()
    if not api_key:
        raise AnswerError(
            f"LLM not configured: set AUTHHUB_API_KEY (provider=authhub, "
            f"base_url={authhub_base_url(settings)!r})"
        )
    from mythic_proportion.graph.extract import AuthHubExtractionClient

    return _maybe_redact_extraction(
        AuthHubExtractionClient(
            base_url=authhub_base_url(settings),
            api_key=api_key,
            model=settings.llm_model,
            route_alias=settings.route_alias or None,
        ),
        settings,
    )


def _read_hot(vault_root: Path) -> str:
    hot_path = vault_root / HOT_FILE
    return hot_path.read_text(encoding="utf-8") if hot_path.is_file() else ""


def _resolve_mode(mode: str | None, question: str, *, has_graph_data: bool) -> str | None:
    """Resolve a caller-supplied ``mode`` into one of :data:`GRAPH_MODES`, or
    ``None`` meaning "the legacy hybrid-search + AnswerClient path".

    ``mode is None`` (the caller omitted the key entirely) is the load-bearing
    legacy-contract case: it **unconditionally** returns ``None``, regardless
    of ``has_graph_data`` -- this is a static property of the call, not a
    runtime property of vault state (see the module docstring / binding
    invariant). Explicit ``mode="auto"`` is the *opt-in* heuristic: it
    resolves to ``None`` only while the graph layer has never been populated,
    then picks GLOBAL for broad/overview-shaped questions and LOCAL otherwise
    once graph data exists (DRIFT/activation are only reachable via an
    explicit ``mode=`` -- "auto" never guesses either, since both are more
    expensive multi-step flows).
    """
    if mode is None:
        return None
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


def _mode_result_to_answer(result: ModeResult, *, resolved_mode: str) -> QueryAnswer:
    return QueryAnswer(
        text=result.text,
        citations=result.citations,
        hits=[],
        used_llm=result.used_llm,
        resolved_mode=resolved_mode,
    )


def answer_query(
    vault_root: Path,
    question: str,
    *,
    k: int = 8,
    use_llm: bool = True,
    mode: str | None = None,
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

    ``mode`` selects the retrieval strategy and has **no default**:
    ``None`` (the caller omitted it entirely) unconditionally forces the
    exact pre-Phase-4 legacy path, regardless of graph state; explicit
    ``"auto"`` opts in to legacy-until-graph-data-exists heuristic dispatch;
    ``"legacy"`` forces the pre-Phase-4 path unconditionally; explicit
    ``"global"``/``"local"``/``"drift"``/``"activation"`` force one specific
    GraphRAG mode (see :mod:`mythic_proportion.query.modes`).
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
            return _mode_result_to_answer(mode_result, resolved_mode=resolved_mode)

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
