"""Answer a question against the vault (Phase 5; LLM-required as of the
AuthHub migration).

``answer_query`` is the single entry point every caller (CLI, tests) should
use: it ensures the SQLite hybrid-search sidecar is fresh (via
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
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from mythic_proportion.config import Settings, authhub_api_key, authhub_base_url, load_settings
from mythic_proportion.index.embeddings import get_embedder
from mythic_proportion.index.retrieve import hybrid_search
from mythic_proportion.index.store import IndexStore, SearchHit
from mythic_proportion.query.client import AnswerClient, AnswerError, AnthropicAnswerClient
from mythic_proportion.query.prompt import build_answer_prompt
from mythic_proportion.vault.layout import HOT_FILE

_CITATION_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")


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


def _read_hot(vault_root: Path) -> str:
    hot_path = vault_root / HOT_FILE
    return hot_path.read_text(encoding="utf-8") if hot_path.is_file() else ""


def answer_query(
    vault_root: Path,
    question: str,
    *,
    k: int = 8,
    use_llm: bool = True,
    client: AnswerClient | None = None,
    settings: Settings | None = None,
) -> QueryAnswer:
    """Answer ``question`` against the vault at ``vault_root``.

    ``client`` overrides automatic client selection (used by tests to inject
    a :class:`~mythic_proportion.query.client.FakeAnswerClient`). ``use_llm``
    defaults to ``True`` and synthesis is now mandatory: if no client is
    configured, or the chosen client raises,
    :class:`~mythic_proportion.query.client.AnswerError` propagates.
    """
    vault_root = Path(vault_root)
    settings = settings or load_settings(vault_root)
    embedder = get_embedder(settings)

    with IndexStore(vault_root, embedder) as store:
        # Keep the sidecar fresh before every query -- cheap for a
        # personal-vault-sized corpus, and guarantees retrieval never serves
        # stale/deleted pages.
        store.reindex(vault_root)
        hits = hybrid_search(store, question, k=k)
        body_by_path = {hit.page_path: store.get_body(hit.page_path) for hit in hits}

    if not use_llm:
        raise AnswerError("LLM synthesis is required: answer_query was called with use_llm=False")

    active_client = client if client is not None else _default_client(settings)

    hot_md = _read_hot(vault_root)
    prompt = build_answer_prompt(question=question, hot_md=hot_md, hits=hits, body_by_path=body_by_path)

    result = active_client.answer(prompt)

    citations = result.citations or _CITATION_RE.findall(result.text)
    return QueryAnswer(text=result.text, citations=citations, hits=hits, used_llm=True)
