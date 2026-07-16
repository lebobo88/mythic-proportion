"""Phase 6 follow-up: ``effective_allow_egress`` is actually enforced.

ADR-0005 S4 defines ``effective_allow_egress = allow_egress AND NOT local``
as "the" single derived control at the cloud-provider trust boundary, but an
independent verification pass found the computation was dead -- nothing in
the provider selector ever consulted it, so setting ``allow_egress=False``
on a ``local=False`` vault had no effect at all. These tests close that gap:
the cloud-provider branches (``anthropic``/``authhub``) of both
``query.engine``'s and ``compile.pipeline``'s selectors must fail closed
with an actionable error instead of ever constructing a cloud client once
``effective_allow_egress`` resolves ``False`` -- this is asserted with a
valid credential present, so the test proves the *egress* gate fires, not
merely the pre-existing missing-credential gate.

``allow_egress`` defaults to ``True`` (preserving this app's pre-existing
default of reaching a configured cloud provider without an extra opt-in --
see :class:`~mythic_proportion.config.Settings`'s docstring), so all of
these tests set it explicitly to ``False``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mythic_proportion.compile.models import CompileError
from mythic_proportion.compile.pipeline import _default_client as compile_default_client
from mythic_proportion.compile.pipeline import compile_source
from mythic_proportion.config import Settings, effective_allow_egress
from mythic_proportion.compile.writer import write_page
from mythic_proportion.compile.models import WikiPage
from mythic_proportion.ingest.pipeline import ingest_drop
from mythic_proportion.index.embeddings import HashEmbedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.query.client import AnswerError
from mythic_proportion.query.engine import _default_client as query_default_client
from mythic_proportion.query.engine import _default_extraction_client, answer_query
from mythic_proportion.vault.init import init_vault


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(vault, WikiPage.new(page_type="concept", title="Topic", body="Some body text."))
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
    return vault


# --------------------------------------------------------------------------
# effective_allow_egress precedence (ADR-0005 S4)
# --------------------------------------------------------------------------


def test_effective_allow_egress_precedence(tmp_path: Path) -> None:
    assert effective_allow_egress(Settings(vault_path=tmp_path)) is True  # default: True, local False
    assert effective_allow_egress(Settings(vault_path=tmp_path, allow_egress=False)) is False
    assert effective_allow_egress(Settings(vault_path=tmp_path, allow_egress=True, local=True)) is False
    assert effective_allow_egress(Settings(vault_path=tmp_path, allow_egress=False, local=True)) is False


# --------------------------------------------------------------------------
# query.engine._default_client / _default_extraction_client
# --------------------------------------------------------------------------


def test_answer_default_client_anthropic_blocked_when_allow_egress_false(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-never-actually-used")
    settings = Settings(
        vault_path=tmp_path, llm_provider="anthropic", allow_egress=False, redaction_enabled=False
    )
    with pytest.raises(AnswerError, match="[Ee]gress"):
        query_default_client(settings)


def test_answer_default_client_authhub_blocked_when_allow_egress_false(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "fake-key-never-actually-used")
    settings = Settings(vault_path=tmp_path, allow_egress=False, redaction_enabled=False)
    with pytest.raises(AnswerError, match="[Ee]gress"):
        query_default_client(settings)


def test_extraction_default_client_blocked_when_allow_egress_false(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "fake-key-never-actually-used")
    settings = Settings(vault_path=tmp_path, allow_egress=False, redaction_enabled=False)
    with pytest.raises(AnswerError, match="[Ee]gress"):
        _default_extraction_client(settings)


def test_answer_query_end_to_end_blocked_when_allow_egress_false(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "fake-key-never-actually-used")
    vault = _seed_vault(tmp_path)
    settings = Settings(vault_path=vault, allow_egress=False, redaction_enabled=False)
    with pytest.raises(AnswerError, match="[Ee]gress"):
        answer_query(vault, "anything at all", settings=settings)


# --------------------------------------------------------------------------
# compile.pipeline._default_client
# --------------------------------------------------------------------------


def test_compile_default_client_anthropic_blocked_when_allow_egress_false(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-never-actually-used")
    settings = Settings(
        vault_path=tmp_path, llm_provider="anthropic", allow_egress=False, redaction_enabled=False
    )
    with pytest.raises(CompileError, match="[Ee]gress"):
        compile_default_client(settings)


def test_compile_source_end_to_end_blocked_when_allow_egress_false(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "fake-key-never-actually-used")
    vault = tmp_path / "vault"
    init_vault(vault)
    (vault / "drop" / "note.md").parent.mkdir(parents=True, exist_ok=True)
    (vault / "drop" / "note.md").write_text("# A note\n\nSome content.\n", encoding="utf-8")
    source = ingest_drop(vault).ingested[0]

    settings = Settings(vault_path=vault, allow_egress=False, redaction_enabled=False)
    with pytest.raises(CompileError, match="[Ee]gress"):
        compile_source(vault, source, settings=settings)


# --------------------------------------------------------------------------
# local=True always wins regardless of allow_egress (never reaches a cloud
# branch at all, so the egress gate is moot -- Ollama is selected instead)
# --------------------------------------------------------------------------


def test_local_true_never_reaches_the_egress_gate(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    settings = Settings(vault_path=tmp_path, local=True, allow_egress=True, redaction_enabled=False)
    from mythic_proportion.llm.ollama import OllamaAnswerClient

    client = query_default_client(settings)
    assert isinstance(client, OllamaAnswerClient)
