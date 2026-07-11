"""Tests for the query engine and its CLI wiring (Phase 5; LLM-required as of
the AuthHub migration -- the old ``_deterministic_answer`` no-LLM fallback
has been removed from ``answer_query``)."""

from __future__ import annotations

from pathlib import Path

import pytest

from mythic_proportion.compile.models import WikiPage
from mythic_proportion.compile.writer import write_page
from mythic_proportion.config import Settings
from mythic_proportion.index.embeddings import HashEmbedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.query.client import AnswerError, AnswerResult, FakeAnswerClient
from mythic_proportion.query.engine import answer_query
from mythic_proportion.vault.init import init_vault


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Hybrid Retrieval",
            body=(
                "Hybrid retrieval combines BM25 sparse search with vector cosine "
                "reranking for fast, accurate results over the wiki. See "
                "[[Wikilink Graph]]."
            ),
        ),
    )
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Wikilink Graph",
            body=(
                "The knowledge graph in this vault is made entirely of "
                "[[wikilinks]] between Markdown pages, not a separate database."
            ),
        ),
    )
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Gardening Tips",
            body="Water your tomatoes daily and rotate crops each season for a healthy garden.",
        ),
    )
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        store.reindex(vault)
    return vault


# --------------------------------------------------------------------------
# LLM-required error path (no-LLM graceful degradation was removed)
# --------------------------------------------------------------------------


def test_use_llm_false_raises_answer_error(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with pytest.raises(AnswerError, match="use_llm=False"):
        answer_query(vault, "how does hybrid retrieval combine BM25 and vectors?", use_llm=False)


def test_no_client_available_raises_answer_error(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)
    vault = _seed_vault(tmp_path)
    # use_llm=True (the default) but no client injected and no provider
    # credential configured -- must raise AnswerError, not degrade.
    with pytest.raises(AnswerError, match="AUTHHUB_API_KEY"):
        answer_query(vault, "hybrid retrieval bm25 vector search")


def test_anthropic_provider_selectable_but_requires_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    vault = _seed_vault(tmp_path)
    settings = Settings(vault_path=vault, llm_provider="anthropic")
    with pytest.raises(AnswerError, match="ANTHROPIC_API_KEY"):
        answer_query(vault, "hybrid retrieval bm25 vector search", settings=settings)


def test_empty_vault_with_fake_client_returns_no_hits(tmp_path: Path) -> None:
    vault = tmp_path / "empty-vault"
    init_vault(vault)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)

    def _fixture(prompt) -> AnswerResult:
        assert prompt.hit_titles == ()
        return AnswerResult(text="No relevant pages were found in the vault.", citations=[])

    client = FakeAnswerClient(_fixture)
    answer = answer_query(vault, "anything at all", client=client)
    assert answer.hits == []
    assert answer.citations == []
    assert answer.used_llm is True


# --------------------------------------------------------------------------
# Fake LLM client path -- correct page retrieved and cited
# --------------------------------------------------------------------------


def test_fake_client_retrieves_and_cites_known_page(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)

    def _fixture(prompt):
        assert "Hybrid Retrieval" in prompt.hit_titles
        return AnswerResult(
            text="Hybrid retrieval blends BM25 and vector cosine [[Hybrid Retrieval]].",
            citations=["Hybrid Retrieval"],
        )

    client = FakeAnswerClient(_fixture)
    answer = answer_query(
        vault, "how does hybrid retrieval combine BM25 and vectors?", client=client, k=3
    )

    assert answer.used_llm is True
    assert answer.citations == ["Hybrid Retrieval"]
    assert any(hit.page_path == "wiki/concepts/hybrid-retrieval.md" for hit in answer.hits)
    assert client.calls  # the client was actually invoked


def test_fake_client_citations_parsed_from_text_when_absent(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = FakeAnswerClient(
        AnswerResult(text="See [[Hybrid Retrieval]] and [[Wikilink Graph]].", citations=[])
    )
    answer = answer_query(vault, "hybrid retrieval and the wikilink graph", client=client)

    assert answer.used_llm is True
    assert set(answer.citations) == {"Hybrid Retrieval", "Wikilink Graph"}


def test_client_failure_propagates_as_answer_error(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)

    def _boom(prompt):
        raise AnswerError("simulated client failure")

    client = FakeAnswerClient(_boom)
    with pytest.raises(AnswerError, match="simulated client failure"):
        answer_query(vault, "hybrid retrieval bm25 vector search", client=client)


# --------------------------------------------------------------------------
# CLI wiring
# --------------------------------------------------------------------------


def test_cli_query_no_llm_flag_is_rejected(tmp_path: Path) -> None:
    """--no-llm is no longer supported: LLM synthesis is required as of the
    AuthHub migration, so passing it must fail clearly rather than silently
    returning a degraded ranked-pages digest."""
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    vault = _seed_vault(tmp_path)

    result = runner.invoke(
        app, ["query", "hybrid retrieval bm25 vector search", "--vault", str(vault), "--no-llm"]
    )
    assert result.exit_code == 1
    assert "no longer supported" in result.output


def test_cli_query_missing_provider_prints_clean_error(tmp_path: Path, monkeypatch) -> None:
    """A missing AUTHHUB_API_KEY/ANTHROPIC_API_KEY surfaces as a clean,
    actionable CLI error (exit code 1), never a raw traceback."""
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    runner = CliRunner()
    vault = _seed_vault(tmp_path)

    result = runner.invoke(app, ["query", "hybrid retrieval bm25 vector search", "--vault", str(vault)])
    assert result.exit_code == 1
    assert "AUTHHUB_API_KEY" in result.output
    assert "Traceback" not in result.output


def test_cli_query_lowercase_title_is_not_swallowed_by_rich_markup(tmp_path: Path, monkeypatch) -> None:
    """Regression: a page whose title starts with a lowercase letter (e.g. a
    filename-derived title like ``aurora.md``) must render as its full
    title, not an empty ``[]``. Rich's console markup parser treats an
    unescaped `[[lowercase.dotted]]` sequence as an (unclosed) style tag and
    silently swallows the title text -- every CLI line that prints a
    `[[title]]`-shaped string must disable/escape markup. Exercised here
    through an injected fake ``answer_query`` (via monkeypatch) so the
    regression is verified independent of which LLM provider is
    configured."""
    from typer.testing import CliRunner

    from mythic_proportion.cli import app as cli_app_module
    from mythic_proportion.index.store import SearchHit

    runner = CliRunner()
    vault = tmp_path / "vault"
    result = runner.invoke(cli_app_module.app, ["init", str(vault)])
    assert result.exit_code == 0

    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="aurora.md",
            body=(
                "aurora is a lowercase-and-dotted title used to regression-test the "
                "Rich console markup swallowing bug."
            ),
        ),
    )

    def _fake_answer_query(root, question, *, k=8, use_llm=True):  # noqa: ANN001
        hit = SearchHit(
            page_path="wiki/concepts/aurora-md.md",
            title="aurora.md",
            score=1.0,
            snippet="aurora is a lowercase-and-dotted title",
            tier="bm25",
        )
        from mythic_proportion.query.engine import QueryAnswer

        return QueryAnswer(text="See [[aurora.md]].", citations=["aurora.md"], hits=[hit], used_llm=True)

    monkeypatch.setattr(cli_app_module, "answer_query", _fake_answer_query)

    result = runner.invoke(
        cli_app_module.app,
        ["query", "aurora lowercase dotted title regression", "--vault", str(vault)],
    )
    assert result.exit_code == 0, result.output
    assert "[[aurora.md]]" in result.output
    assert "- []" not in result.output


def test_cli_query_help() -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    result = runner.invoke(app, ["query", "--help"])
    assert result.exit_code == 0, result.output
    assert "--no-llm" in result.output
