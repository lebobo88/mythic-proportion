"""Phase 6: the ``local: true`` provider-selector path.

Asserts the per-vault "never touch the cloud" guarantee end-to-end across
compile, query, and graph extraction: with ``Settings.local=True`` and no
client explicitly injected, every real HTTP call the app makes must target
``localhost``/``127.0.0.1`` (Ollama) -- never AuthHub, Anthropic, or any
other host. The network layer is intercepted at ``httpx.post``/``httpx.get``
(the same choke point every real client in this package funnels through) so
a single assertion enforces the invariant regardless of which internal
client class ends up being used; the request-building/response-parsing code
in ``llm.ollama`` runs for real, only the transport is mocked.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import pytest

from mythic_proportion.compile.models import WikiPage
from mythic_proportion.compile.pipeline import compile_source
from mythic_proportion.compile.writer import write_page
from mythic_proportion.config import Settings
from mythic_proportion.graph.cache import LlmCache
from mythic_proportion.graph.extract import extract_entities_relationships
from mythic_proportion.ingest.pipeline import ingest_drop
from mythic_proportion.index.embeddings import HashEmbedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.query.client import AnswerError
from mythic_proportion.query.engine import answer_query
from mythic_proportion.vault.init import init_vault

_ALLOWED_HOSTS = {"localhost", "127.0.0.1"}


class _NetworkGuard:
    """Records every outbound host contacted and blows up loudly on any
    non-localhost host -- the enforcement mechanism for this whole file."""

    def __init__(self) -> None:
        self.hosts_contacted: list[str] = []

    def _record(self, url: str) -> None:
        host = urlparse(url).hostname or ""
        self.hosts_contacted.append(host)
        if host not in _ALLOWED_HOSTS:
            raise AssertionError(f"non-localhost network call attempted: {url!r}")

    def fake_post(self, url: str, **kwargs: Any) -> httpx.Response:
        self._record(url)
        payload = kwargs.get("json") or {}
        if "format" in payload:
            # Compile/answer structured-output call -- return minimal valid JSON.
            content = '{"pages": [], "contradictions": []}'
            if payload["format"].get("properties", {}).get("answer") is not None:
                content = '{"answer": "a local-only answer", "citations": []}'
        else:
            # Extraction call -- plain delimited-tuple completion.
            content = "##<|COMPLETE|>"
        request = httpx.Request("POST", url)
        return httpx.Response(
            200, request=request, json={"message": {"role": "assistant", "content": content}, "done": True}
        )

    def fake_get(self, url: str, **kwargs: Any) -> httpx.Response:
        self._record(url)
        request = httpx.Request("GET", url)
        return httpx.Response(200, request=request, json={"models": [{"name": "qwen2.5:7b-instruct"}]})


@pytest.fixture()
def guard(monkeypatch) -> _NetworkGuard:
    g = _NetworkGuard()
    monkeypatch.setattr("httpx.post", g.fake_post)
    monkeypatch.setattr("httpx.get", g.fake_get)
    # Sabotage any cloud credential so a stray non-local path would fail
    # loudly (raise AnswerError/CompileError) instead of silently degrading.
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return g


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Local Mode",
            body="Local mode keeps every LLM call on this machine.",
        ),
    )
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
    return vault


def _local_settings(vault: Path, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "vault_path": vault,
        "local": True,
        "llm_provider": "authhub",  # deliberately the wrong provider -- `local` must win
        "redaction_enabled": False,  # isolate the network-isolation assertion from redaction
    }
    base.update(overrides)
    return Settings(**base)


def test_query_local_true_never_calls_a_non_local_host(guard: _NetworkGuard, tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    settings = _local_settings(vault)

    answer = answer_query(vault, "what does local mode keep on this machine?", settings=settings)

    assert answer.used_llm is True
    assert answer.text == "a local-only answer"
    assert guard.hosts_contacted, "expected at least one HTTP call"
    assert all(host in _ALLOWED_HOSTS for host in guard.hosts_contacted)


def test_compile_local_true_never_calls_a_non_local_host(guard: _NetworkGuard, tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    init_vault(vault)
    (vault / "drop" / "note.md").parent.mkdir(parents=True, exist_ok=True)
    (vault / "drop" / "note.md").write_text("# A note\n\nSome content about local mode.\n", encoding="utf-8")
    report = ingest_drop(vault)
    source = report.ingested[0]

    settings = _local_settings(vault)
    result = compile_source(vault, source, settings=settings)

    assert result.pages == []  # the fake local response returns no pages
    assert guard.hosts_contacted
    assert all(host in _ALLOWED_HOSTS for host in guard.hosts_contacted)


def test_extraction_local_true_never_calls_a_non_local_host_and_yields_no_crash(
    guard: _NetworkGuard, tmp_path: Path
) -> None:
    from mythic_proportion.llm.ollama import OllamaExtractionClient

    settings = _local_settings(tmp_path)
    client = OllamaExtractionClient(base_url=settings.ollama_base_url, model=settings.ollama_model)

    with IndexStore(tmp_path, HashEmbedder(dim=16), use_vec=False) as store:
        cache = LlmCache(store.conn)
        entities, relationships, llm_calls = extract_entities_relationships(
            "Acme Corp makes widgets.", client=client, cache=cache, model=settings.ollama_model, max_gleanings=0
        )

    assert llm_calls >= 1
    assert guard.hosts_contacted
    assert all(host in _ALLOWED_HOSTS for host in guard.hosts_contacted)


def test_query_local_true_with_non_loopback_url_fails_closed_without_any_network_call(
    guard: _NetworkGuard, tmp_path: Path
) -> None:
    """Closes a prior review finding: `local: true` with a non-loopback
    `ollama_base_url` must raise before any HTTP call is made -- not
    silently egress to the remote host."""
    vault = _seed_vault(tmp_path)
    settings = _local_settings(vault, ollama_base_url="http://evil.example.com:11434")

    with pytest.raises(AnswerError, match="loopback"):
        answer_query(vault, "does a remote ollama_base_url ever get contacted?", settings=settings)

    assert guard.hosts_contacted == []


def test_compile_local_true_with_non_loopback_url_fails_closed_without_any_network_call(
    guard: _NetworkGuard, tmp_path: Path
) -> None:
    from mythic_proportion.compile.models import CompileError
    from mythic_proportion.compile.pipeline import compile_source

    vault = tmp_path / "vault"
    init_vault(vault)
    (vault / "drop" / "note.md").parent.mkdir(parents=True, exist_ok=True)
    (vault / "drop" / "note.md").write_text("# A note\n\nSome content.\n", encoding="utf-8")
    report = ingest_drop(vault)
    source = report.ingested[0]

    settings = _local_settings(vault, ollama_base_url="http://evil.example.com:11434")

    with pytest.raises(CompileError, match="loopback"):
        compile_source(vault, source, settings=settings)

    assert guard.hosts_contacted == []


def test_local_true_wins_even_when_llm_provider_is_explicitly_cloud(
    guard: _NetworkGuard, tmp_path: Path
) -> None:
    """``local=True`` overrides ``llm_provider`` unconditionally -- the
    per-vault guarantee, not a per-call opt-in."""
    vault = _seed_vault(tmp_path)
    settings = _local_settings(vault, llm_provider="anthropic")

    # No ANTHROPIC_API_KEY is set (see the `guard` fixture) -- if this ever
    # routed to the Anthropic path it would raise AnswerError here instead
    # of succeeding via Ollama.
    answer = answer_query(vault, "does local win over an explicit cloud provider?", settings=settings)
    assert answer.used_llm is True
