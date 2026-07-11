"""Tests for the compile step (Phase 3): golden, dedup/conflict, and the
LLM-required error path (post-AuthHub-migration; the old no-LLM
graceful-degradation fallback has been removed from ``compile_source``).

No `anthropic`/`httpx` real network call is made anywhere in this file —
every LLM call is a :class:`FakeCompileClient` fixture.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from mythic_proportion.compile.client import FakeCompileClient
from mythic_proportion.compile.graph import existing_page_titles, extract_links, read_page_title, resolve_graph
from mythic_proportion.compile.models import CompileError, CompileResult, WikiPage
from mythic_proportion.compile.pipeline import CompiledLedger, compile_pending, compile_source
from mythic_proportion.compile.writer import parse_page, write_page
from mythic_proportion.config import Settings
from mythic_proportion.ingest.models import IngestedSource
from mythic_proportion.ingest.pipeline import ingest_drop
from mythic_proportion.vault.init import init_vault
from mythic_proportion.vault.layout import HOT_FILE, INDEX_FILE


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    return vault


def _fake_registry() -> dict:
    return {
        "document": lambda path: f"# parsed document: {Path(path).name}\n",
        "image": lambda path: f"# parsed image: {Path(path).name}\n",
        "artifact": lambda path: f"# parsed artifact: {Path(path).name}\n",
    }


def _make_source(vault: Path, name: str, content: bytes) -> IngestedSource:
    """Drop + ingest one file, returning its IngestedSource (Phase 2 pipeline)."""
    (vault / "drop" / name).write_bytes(content)
    report = ingest_drop(vault, parser_registry=_fake_registry())
    matches = [s for s in report.ingested if s.original_name == name]
    assert matches, f"expected {name} to be ingested"
    return matches[0]


def _settings(vault: Path, allow_egress: bool = False) -> Settings:
    return Settings(vault_path=vault, allow_egress=allow_egress)


# --------------------------------------------------------------------------
# Golden test
# --------------------------------------------------------------------------


def test_golden_fake_client_writes_pages_resolves_stubs_updates_index_and_hot(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    source = _make_source(vault, "report.pdf", b"%PDF-1.4 fake pdf bytes about Acme Corp and Widgets")

    canned = CompileResult(
        pages=[
            WikiPage.new(
                page_type="source",
                title="Acme Quarterly Report",
                body="Summary of the report. See [[Acme Corp]] and [[Widget Strategy]].",
                tags=["report"],
            ),
            WikiPage.new(
                page_type="entity",
                title="Acme Corp",
                body="A company mentioned in [[Acme Quarterly Report]].",
            ),
        ],
        contradictions=[],
    )
    client = FakeCompileClient(canned)

    result = compile_source(vault, source, client=client, settings=_settings(vault))

    assert len(result.pages) == 2
    # Widget Strategy was linked but never authored -> becomes a dangling-link stub.
    assert "Widget Strategy" in result.links_created

    source_page = vault / "wiki" / "sources" / "acme-quarterly-report.md"
    entity_page = vault / "wiki" / "entities" / "acme-corp.md"
    stub_page = vault / "wiki" / "concepts" / "widget-strategy.md"
    assert source_page.is_file()
    assert entity_page.is_file()
    assert stub_page.is_file()

    fm, body = parse_page(stub_page.read_text(encoding="utf-8"))
    assert fm["type"] == "concept"
    assert "stub" in fm["tags"]
    assert "# Widget Strategy" in body

    index_text = (vault / INDEX_FILE).read_text(encoding="utf-8")
    assert "[[Acme Quarterly Report]]" in index_text
    assert "[[Widget Strategy]]" in index_text
    assert "backlinks" in index_text

    hot_text = (vault / HOT_FILE).read_text(encoding="utf-8")
    assert "Acme Quarterly Report" in hot_text or "Acme Corp" in hot_text


def test_golden_client_receives_prompt_with_schema_and_source(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    source = _make_source(vault, "note.txt", b"hello world")

    client = FakeCompileClient(CompileResult(pages=[]))
    compile_source(vault, source, client=client, settings=_settings(vault))

    assert len(client.calls) == 1
    prompt = client.calls[0]
    assert "note.txt" in prompt.user
    assert prompt.source_hash == source.content_hash
    assert "schema" in prompt.system.lower()


# --------------------------------------------------------------------------
# Dedup / conflict test
# --------------------------------------------------------------------------


def test_recompiling_overlapping_source_reuses_entity_page_and_records_contradiction(
    tmp_path: Path,
) -> None:
    vault = _seed_vault(tmp_path)

    first_source = _make_source(vault, "first.txt", b"first source about Acme Corp")
    first_result_data = CompileResult(
        pages=[
            WikiPage.new(page_type="entity", title="Acme Corp", body="Acme Corp is a startup."),
        ],
    )
    compile_source(vault, first_source, client=FakeCompileClient(first_result_data), settings=_settings(vault))

    entity_page = vault / "wiki" / "entities" / "acme-corp.md"
    assert entity_page.is_file()
    assert len(existing_page_titles(vault)) == 1

    second_source = _make_source(vault, "second.txt", b"second source, contradicts: Acme Corp is public")
    second_result_data = CompileResult(
        pages=[
            WikiPage.new(
                page_type="entity",
                title="Acme Corp",
                body="Updated: Acme Corp is actually a public company. See [[Acme Corp]].",
            ),
        ],
        contradictions=["Acme Corp was described as a startup in one source and public in another."],
    )
    result = compile_source(
        vault, second_source, client=FakeCompileClient(second_result_data), settings=_settings(vault)
    )

    # Still exactly one entity page -- reused, not duplicated.
    entity_pages = list((vault / "wiki" / "entities").glob("*.md"))
    entity_pages = [p for p in entity_pages if not p.name.endswith(".lock")]
    assert len(entity_pages) == 1

    assert result.contradictions == [
        "Acme Corp was described as a startup in one source and public in another."
    ]

    fm, body = parse_page(entity_page.read_text(encoding="utf-8"))
    assert "public company" in body


def test_writer_appends_merge_note_instead_of_overwriting_human_edit(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    page = WikiPage.new(page_type="concept", title="Hybrid Retrieval", body="Original compiled body.")
    write_page(vault, page)

    full_path = vault / "wiki" / "concepts" / "hybrid-retrieval.md"
    fm, body = parse_page(full_path.read_text(encoding="utf-8"))
    # Simulate a human hand-edit: append text without updating compiled_hash.
    edited = body + "\n\nA human added this sentence by hand.\n"
    from mythic_proportion.compile.writer import render_frontmatter

    full_path.write_text(render_frontmatter(fm) + "\n" + edited, encoding="utf-8")

    outcome = write_page(
        vault,
        WikiPage.new(page_type="concept", title="Hybrid Retrieval", body="A machine-proposed rewrite."),
    )
    assert outcome.action == "merged"

    final_text = full_path.read_text(encoding="utf-8")
    assert "A human added this sentence by hand." in final_text
    assert "[!merge]" in final_text
    # The machine's proposed rewrite was NOT applied verbatim over the human edit.
    assert "A machine-proposed rewrite." not in final_text


# --------------------------------------------------------------------------
# LLM-required error path (no-LLM graceful degradation was removed)
# --------------------------------------------------------------------------


def test_no_provider_configured_raises_compile_error(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = _seed_vault(tmp_path)
    source = _make_source(vault, "diagram.png", b"\x89PNG fake png bytes")

    # No client override and no AUTHHUB_API_KEY/ANTHROPIC_API_KEY configured
    # -> compile_source must raise CompileError, not silently degrade to a
    # stub page.
    with pytest.raises(CompileError, match="AUTHHUB_API_KEY"):
        compile_source(vault, source, settings=_settings(vault))

    # No page was written for the failed source.
    assert list((vault / "wiki" / "sources").glob("*.md")) == []


def test_client_that_raises_propagates_as_compile_error(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    source = _make_source(vault, "bad.txt", b"whatever")

    class ExplodingClient:
        def compile(self, prompt):  # noqa: ANN001, ANN201
            raise CompileError("simulated API failure")

    with pytest.raises(CompileError, match="simulated API failure"):
        compile_source(vault, source, client=ExplodingClient(), settings=_settings(vault))


def test_anthropic_provider_selectable_but_requires_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    vault = _seed_vault(tmp_path)
    source = _make_source(vault, "another.txt", b"whatever")

    settings = Settings(vault_path=vault, llm_provider="anthropic")
    with pytest.raises(CompileError, match="ANTHROPIC_API_KEY"):
        compile_source(vault, source, settings=settings)


# --------------------------------------------------------------------------
# compile_pending
# --------------------------------------------------------------------------


def test_compile_pending_compiles_sources_not_yet_compiled(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    _make_source(vault, "one.json", b'{"a": 1}')
    _make_source(vault, "two.json", b'{"b": 2}')

    def _fixture(prompt) -> CompileResult:
        return CompileResult(
            pages=[WikiPage.new(page_type="source", title=f"Compiled {prompt.source_hash[:8]}", body="body")]
        )

    client = FakeCompileClient(_fixture)
    results = compile_pending(vault, client=client, settings=_settings(vault))
    assert len(results) == 2
    for result in results:
        assert len(result.pages) == 1

    # Running again compiles nothing new (already recorded in compiled ledger).
    results_again = compile_pending(vault, client=client, settings=_settings(vault))
    assert results_again == []


def test_compile_pending_with_no_provider_configured_raises(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)
    vault = _seed_vault(tmp_path)
    _make_source(vault, "three.json", b'{"c": 3}')

    with pytest.raises(CompileError):
        compile_pending(vault, settings=_settings(vault))


def test_compiled_ledger_records_and_reports(tmp_path: Path) -> None:
    ledger = CompiledLedger(tmp_path / "compiled.json")
    assert not ledger.already_compiled("abc")
    ledger.record("abc", compiled_at=datetime.now(timezone.utc))
    assert ledger.already_compiled("abc")

    reloaded = CompiledLedger(tmp_path / "compiled.json")
    assert reloaded.already_compiled("abc")


def test_compiled_ledger_record_survives_concurrent_writers(tmp_path: Path) -> None:
    """Regression for the ledger write race: several `CompiledLedger`
    instances (mirroring the pre-worker web path, where `compile_source`
    built a fresh `CompiledLedger` per call) each recording a distinct entry
    "concurrently" must not clobber each other -- every entry must survive.
    `record()` now re-reads the file before merging its own entry in and
    writes atomically, so no writer's entry is lost even though each instance
    started from an independent in-memory snapshot."""
    import threading

    path = tmp_path / "compiled.json"
    n = 20
    barrier = threading.Barrier(n)

    def _write(i: int) -> None:
        ledger = CompiledLedger(path)  # each thread's own instance/snapshot
        barrier.wait()  # maximize actual overlap
        ledger.record(f"hash-{i}", compiled_at=datetime.now(timezone.utc))

    threads = [threading.Thread(target=_write, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    final = CompiledLedger(path)
    for i in range(n):
        assert final.already_compiled(f"hash-{i}"), f"hash-{i} was lost to the write race"


# --------------------------------------------------------------------------
# graph.py helpers
# --------------------------------------------------------------------------


def test_extract_links_and_read_page_title(tmp_path: Path) -> None:
    assert extract_links("See [[Foo Bar]] and [[Baz|alias]] and [[Qux#section]].") == [
        "Foo Bar",
        "Baz",
        "Qux",
    ]

    vault = _seed_vault(tmp_path)
    page = WikiPage.new(page_type="concept", title="My Concept", body="Body text.")
    write_page(vault, page)
    assert read_page_title(vault / page.path) == "My Concept"


def test_resolve_graph_is_idempotent_when_no_new_links(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    page = WikiPage.new(page_type="concept", title="Solo Concept", body="No links here.")
    write_page(vault, page)

    result1 = resolve_graph(vault)
    result2 = resolve_graph(vault)
    assert result1.stub_titles == []
    assert result2.stub_titles == []
    assert result1.page_count == result2.page_count == 1


def test_lint_zero_broken_links_after_golden_compile(tmp_path: Path) -> None:
    """Cheap stand-in for the Phase 5 lint check: after resolve_graph, every
    [[link]] in every page resolves to an existing page (no dangling links)."""
    vault = _seed_vault(tmp_path)
    source = _make_source(vault, "linky.txt", b"content")
    canned = CompileResult(
        pages=[
            WikiPage.new(page_type="source", title="Linky Source", body="Links to [[Orphan Concept]]."),
        ]
    )
    compile_source(vault, source, client=FakeCompileClient(canned), settings=_settings(vault))

    all_titles = {t.lower() for t in existing_page_titles(vault)}
    for md_path in (vault / "wiki").rglob("*.md"):
        if md_path.name == "log.md":
            continue
        _fm, body = parse_page(md_path.read_text(encoding="utf-8"))
        for link in extract_links(body):
            assert link.lower() in all_titles, f"dangling link {link!r} in {md_path}"
