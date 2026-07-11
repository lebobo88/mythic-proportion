"""End-to-end suite (Phase 6): fresh vault -> init -> drop 3 mixed sources ->
ingest (fake parsers + FakeCompileClient) -> reindex -> query (fake LLM
client, injected around the CLI boundary via monkeypatch) -> lint, all on one
vault, entirely offline.

Ingest/compile use injected fakes (exactly like test_pipeline.py/test_compile.py)
so this test never requires Docling/MarkItDown/Anthropic/httpx to be
installed -- the CLI's `reindex`/`query`/`lint` verbs are exercised for real
via `typer.testing.CliRunner` since none of those three need any optional
dependency to run offline (query now needs an injected fake client since
LLM synthesis is mandatory as of the AuthHub migration).
"""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from mythic_proportion.cli import app as cli_app_module
from mythic_proportion.cli.app import app
from mythic_proportion.compile.client import FakeCompileClient
from mythic_proportion.compile.models import CompileResult, WikiPage
from mythic_proportion.compile.pipeline import compile_source
from mythic_proportion.config import load_settings
from mythic_proportion.ingest.pipeline import ingest_drop
from mythic_proportion.query.client import AnswerResult, FakeAnswerClient
from mythic_proportion.query.engine import answer_query as real_answer_query

runner = CliRunner()


def _fake_parser_registry() -> dict:
    """Document/image parsers stand in for Docling; artifact uses the real,
    always-available deterministic reader (no external dependency)."""
    from mythic_proportion.ingest.markitdown_adapter import read_artifact_as_markdown

    return {
        "document": lambda path: (
            "# Mythic Proportion Field Notes\n\n"
            "The Mythic Proportion vault uses hybrid retrieval to answer questions "
            "by combining BM25 sparse search with vector cosine reranking.\n"
        ),
        "image": lambda path: (
            "# Screenshot of the Obsidian Graph View\n\n"
            "A screenshot showing the Obsidian graph view with colour-coded nodes "
            "for sources, entities, and concepts.\n"
        ),
        "artifact": read_artifact_as_markdown,
    }


def _fixture_pages_for(prompt) -> CompileResult:
    """A deterministic FakeCompileClient fixture: one page per source, whose
    body carries the full prompt (including the source's own parsed
    markdown) so a later query for a keyword from that source retrieves the
    compiled page back. Every page links to one shared concept page (auto-
    created as a stub by ``compile.graph.resolve_graph``) so no page in the
    resulting vault is an orphan -- matching what a real multi-page compile
    would produce (every source page links out to at least one shared
    entity/concept)."""
    body = prompt.user + "\n\nSee also [[Mythic Proportion Vault]].\n"
    page = WikiPage.new(
        page_type="source",
        title=f"Compiled: {prompt.source_hash[:12]}",
        body=body,
        tags=["e2e"],
    )
    return CompileResult(pages=[page], contradictions=[], links_created=[])


def test_cold_start_e2e_init_ingest_reindex_query_lint(tmp_path: Path, monkeypatch) -> None:
    # 1. init a fresh vault
    vault = tmp_path / "e2e-vault"
    result = runner.invoke(app, ["init", str(vault)])
    assert result.exit_code == 0, result.output

    # 2. drop 3 mixed fixture files: a document, a fake image, an artifact
    doc = vault / "drop" / "field-notes.txt"
    image = vault / "drop" / "graph-view.png"
    artifact = vault / "drop" / "settings.json"
    doc.write_text("plain-text stand-in for a real document", encoding="utf-8")
    image.write_bytes(b"\x89PNG fake image bytes for the e2e fixture")
    artifact.write_text('{"embeddings_backend": "local"}', encoding="utf-8")

    # 3. ingest (fake parsers so no Docling/MarkItDown install is required)
    ingest_report = ingest_drop(vault, parser_registry=_fake_parser_registry())
    assert len(ingest_report.ingested) == 3
    assert not ingest_report.errors
    assert list((vault / "drop").iterdir()) == []  # drop/ fully emptied

    kinds = {s.original_name: s.kind for s in ingest_report.ingested}
    assert kinds["field-notes.txt"] == "document"
    assert kinds["graph-view.png"] == "image"
    assert kinds["settings.json"] == "artifact"

    # 4. compile each ingested source with a FakeCompileClient (no API key needed)
    settings = load_settings(vault)
    client = FakeCompileClient(_fixture_pages_for)
    for source in ingest_report.ingested:
        compile_result = compile_source(vault, source, client=client, settings=settings)
        assert compile_result.pages  # every source produced at least one page
    assert len(client.calls) == 3

    wiki_pages = list((vault / "wiki" / "sources").glob("*.md"))
    assert len(wiki_pages) == 3

    # 5. reindex (real CLI command -- offline, no API key needed)
    result = runner.invoke(app, ["reindex", "--vault", str(vault)])
    assert result.exit_code == 0, result.output
    assert "Reindexed" in result.output

    # 6. query for a keyword unique to the document-kind source, via an
    # injected FakeAnswerClient (LLM synthesis is now mandatory) monkeypatched
    # in at the CLI boundary -- exactly like the compile step's
    # FakeCompileClient above, this keeps the whole suite network-free.
    def _fixture(prompt) -> AnswerResult:
        return AnswerResult(text="Hybrid retrieval synthesized answer.", citations=list(prompt.hit_titles[:1]))

    def _query_with_fake_client(root, question, *, k=8, use_llm=True, mode="auto"):  # noqa: ANN001
        return real_answer_query(
            root, question, k=k, use_llm=use_llm, mode=mode, client=FakeAnswerClient(_fixture)
        )

    monkeypatch.setattr(cli_app_module, "answer_query", _query_with_fake_client)
    result = runner.invoke(
        app,
        ["query", "hybrid retrieval BM25 vector reranking", "--vault", str(vault)],
    )
    assert result.exit_code == 0, result.output
    assert "used_llm=True" in result.output

    # 7. lint is clean
    result = runner.invoke(app, ["lint", str(vault)])
    assert result.exit_code == 0, result.output
    assert "clean" in result.output.lower()


def test_cold_start_e2e_reports_clean_errors_with_no_provider_configured(
    tmp_path: Path, monkeypatch
) -> None:
    """The same cold-start flow, but relying on automatic client selection
    (no injected fake clients) with no AUTHHUB_API_KEY/ANTHROPIC_API_KEY set.
    Per the "LLM required" contract, compile and query no longer degrade:
    ingest still exits 0 with a clean per-source compile error (no stub page
    written), and `query` exits 1 with an actionable error, never a
    traceback. Reindex/lint remain fully offline and unaffected."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = tmp_path / "no-provider-vault"
    result = runner.invoke(app, ["init", str(vault)])
    assert result.exit_code == 0, result.output

    (vault / "drop" / "notes.json").write_text('{"key": "value"}', encoding="utf-8")

    result = runner.invoke(app, ["ingest", str(vault)])
    assert result.exit_code == 0, result.output
    assert "Ingested: 1" in result.output
    assert "Compiling: 1" in result.output
    assert "AUTHHUB_API_KEY" in result.output
    assert "Traceback" not in result.output

    # No page was written for the failed compile.
    stub_pages = list((vault / "wiki" / "sources").glob("*.md"))
    assert len(stub_pages) == 0

    result = runner.invoke(app, ["reindex", "--vault", str(vault)])
    assert result.exit_code == 0, result.output

    result = runner.invoke(app, ["query", "notes", "--vault", str(vault)])
    assert result.exit_code == 1
    assert "AUTHHUB_API_KEY" in result.output
    assert "Traceback" not in result.output

    # lint remains fully offline and clean (nothing was ever written).
    result = runner.invoke(app, ["lint", str(vault)])
    assert result.exit_code == 0, result.output
    assert "clean" in result.output.lower()
