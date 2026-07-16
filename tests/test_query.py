"""Tests for the query engine and its CLI wiring (Phase 5; LLM-required as of
the AuthHub migration -- the old ``_deterministic_answer`` no-LLM fallback
has been removed from ``answer_query``)."""

from __future__ import annotations

from pathlib import Path

import pytest

from mythic_proportion.compile.models import WikiPage
from mythic_proportion.compile.writer import write_page
from mythic_proportion.config import Settings
from mythic_proportion.graph.extract import FakeExtractionClient
from mythic_proportion.graph.store import GraphStore
from mythic_proportion.index.embeddings import HashEmbedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.query.client import AnswerError, AnswerResult, FakeAnswerClient
from mythic_proportion.query.engine import answer_query
from mythic_proportion.vault.init import init_vault


def _settings(vault: Path, **overrides) -> Settings:  # noqa: ANN003
    """Redaction is on by default (``Settings.redaction_enabled=True``) and,
    with ``[privacy]``/``[privacy-full]`` installed in this dev environment,
    building a *real* default ``Redactor()`` loads an actual local
    transformer pipeline (multi-second, and the very first time, a real
    HuggingFace Hub fetch) -- see ``compile.pipeline``/``query.engine``'s
    retry fix that now applies :func:`mythic_proportion.privacy.redact.get_redactor`
    uniformly to every active client, including one injected via ``client=``/
    ``graph_client=`` (closing the fail-closed bypass a prior review found).
    These tests exercise query mechanics, not privacy, so they explicitly
    opt out of redaction here -- exactly the "explicit ``redaction_enabled=
    False``" escape hatch the fail-closed contract requires (never an
    implicit bypass via client injection). Dedicated redaction-behavior
    coverage lives in ``test_privacy_redact.py``."""
    base: dict = {"vault_path": vault, "redaction_enabled": False}
    base.update(overrides)
    return Settings(**base)


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
    answer = answer_query(vault, "anything at all", client=client, settings=_settings(vault))
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
        vault, "how does hybrid retrieval combine BM25 and vectors?", client=client, k=3, settings=_settings(vault)
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
    answer = answer_query(vault, "hybrid retrieval and the wikilink graph", client=client, settings=_settings(vault))

    assert answer.used_llm is True
    assert set(answer.citations) == {"Hybrid Retrieval", "Wikilink Graph"}


def test_client_failure_propagates_as_answer_error(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)

    def _boom(prompt):
        raise AnswerError("simulated client failure")

    client = FakeAnswerClient(_boom)
    with pytest.raises(AnswerError, match="simulated client failure"):
        answer_query(vault, "hybrid retrieval bm25 vector search", client=client, settings=_settings(vault))


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

    def _fake_answer_query(root, question, *, k=8, use_llm=True, mode="auto"):  # noqa: ANN001
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


# --------------------------------------------------------------------------
# Phase 4: `mode` wiring -- "auto" preserves legacy behavior with no graph
# data, explicit graph modes route through the graph layer's ExtractionClient.
# --------------------------------------------------------------------------


def test_omitted_mode_unconditionally_takes_the_legacy_path(tmp_path: Path) -> None:
    """CORRECTED per memory/invariants.md's "POST /api/query contract --
    CORRECTION" entry: the load-bearing regression is that omitting ``mode``
    entirely (every pre-Phase-4 caller) must ALWAYS take the exact legacy
    path -- unconditionally, never contingent on graph/communities state."""
    vault = _seed_vault(tmp_path)
    client = FakeAnswerClient(AnswerResult(text="legacy answer", citations=[]))

    answer = answer_query(vault, "hybrid retrieval bm25 vector search", client=client, settings=_settings(vault))

    assert answer.used_llm is True
    assert answer.text == "legacy answer"
    assert answer.resolved_mode is None
    assert client.calls  # the legacy tool-calling AnswerClient was actually used


def test_omitted_mode_takes_the_legacy_path_even_when_graph_data_exists(tmp_path: Path) -> None:
    """The binding invariant is a STATIC property of the call, not a runtime
    property of vault state: unlike explicit ``mode="auto"``, an omitted
    ``mode`` must stay on the legacy path even once graph data exists."""
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        graph_store = GraphStore(store.conn)
        a = graph_store.upsert_entity("A", "CONCEPT", "")
        b = graph_store.upsert_entity("B", "CONCEPT", "")
        graph_store.upsert_relationship(a, b, "related", "", 1.0)

    client = FakeAnswerClient(AnswerResult(text="still legacy", citations=[]))
    answer = answer_query(vault, "give me an overview of everything", client=client, settings=_settings(vault))

    assert answer.text == "still legacy"
    assert answer.resolved_mode is None
    assert client.calls  # legacy AnswerClient used, not the graph ExtractionClient


def test_explicit_legacy_mode_forces_legacy_path_even_with_graph_data_present(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        GraphStore(store.conn).upsert_entity("SOME ENTITY", "CONCEPT", "")

    client = FakeAnswerClient(AnswerResult(text="legacy still used", citations=[]))
    answer = answer_query(
        vault, "hybrid retrieval bm25 vector search", client=client, mode="legacy", settings=_settings(vault)
    )
    assert answer.text == "legacy still used"


def test_explicit_local_mode_routes_through_the_graph_extraction_client(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        graph_store = GraphStore(store.conn)
        a = graph_store.upsert_entity("HYBRID RETRIEVAL", "CONCEPT", "combines bm25 and vectors")
        b = graph_store.upsert_entity("BM25", "CONCEPT", "lexical search")
        graph_store.upsert_relationship(a, b, "related", "", 5.0)

    graph_client = FakeExtractionClient(
        '{"answer": "graph-based answer", "citations": ["HYBRID RETRIEVAL"]}'
    )
    answer = answer_query(
        vault, "HYBRID RETRIEVAL", mode="local", graph_client=graph_client, settings=_settings(vault)
    )

    assert answer.used_llm is True
    assert answer.text == "graph-based answer"
    assert answer.citations == ["HYBRID RETRIEVAL"]
    assert answer.hits == []
    assert graph_client.calls  # the graph ExtractionClient was used, not the legacy AnswerClient


def test_auto_mode_routes_to_global_for_an_overview_question_once_graph_data_exists(tmp_path: Path) -> None:
    """Explicit ``mode="auto"`` (opt-in heuristic dispatch) is what carries
    the state-dependent behavior; an omitted ``mode`` never does (see the
    two omitted-mode tests above)."""
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        graph_store = GraphStore(store.conn)
        a = graph_store.upsert_entity("A", "CONCEPT", "")
        b = graph_store.upsert_entity("B", "CONCEPT", "")
        graph_store.upsert_relationship(a, b, "related", "", 1.0)
        store.conn.execute(
            "INSERT INTO community_reports(level, cluster, title, summary, full_content, rating) "
            "VALUES (0, 0, 'Report', 'summary text', '', 5.0)"
        )
        store.conn.commit()

    def _fixture(system: str, user: str, idx: int) -> str:
        if "map step" in system:
            return '[{"point": "a summary point", "score": 5}]'
        return '{"answer": "global auto answer"}'

    graph_client = FakeExtractionClient(_fixture)
    answer = answer_query(
        vault,
        "give me an overview of everything",
        mode="auto",
        graph_client=graph_client,
        settings=_settings(vault),
    )

    assert answer.text == "global auto answer"
    assert answer.resolved_mode == "global"


def test_unknown_mode_raises_value_error(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with pytest.raises(ValueError, match="unknown query mode"):
        answer_query(vault, "anything at all", mode="bogus-mode")


def test_explicit_graph_mode_with_use_llm_false_raises_answer_error(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with pytest.raises(AnswerError, match="use_llm=False"):
        answer_query(vault, "anything at all", mode="local", use_llm=False)


def test_cli_query_help() -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    result = runner.invoke(app, ["query", "--help"])
    assert result.exit_code == 0, result.output
    assert "--no-llm" in result.output
