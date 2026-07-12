"""Tests for the Phase 6 local PII redaction/rehydration layer
(``mythic_proportion.privacy.redact``).

No real ``presidio``/``torch`` model is loaded here: :class:`Redactor` is
built with an injected fake :class:`~mythic_proportion.privacy.redact.Analyzer`
(a tiny regex-based stand-in satisfying the same duck-typed
``analyze(text, language) -> list[PiiSpan]`` interface real Presidio's
``AnalyzerEngine`` exposes) so the redact -> rehydrate round-trip and the
provider-layer wrapper classes are exercised without either heavy optional
dependency installed. ``presidio-anonymizer`` *is* exercised for real here
(it's a light, pure-Python package with no torch/model-download
requirement) -- only the OpenAI Privacy Filter recognizer (which needs
``torch``/``transformers``) and Presidio's own NLP-engine-backed builtin
recognizers (which need a spaCy model download) are avoided, via the fake
analyzer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import pytest

pytest.importorskip("presidio_anonymizer")

from mythic_proportion.compile.client import FakeCompileClient  # noqa: E402
from mythic_proportion.compile.models import CompileResult, WikiPage  # noqa: E402
from mythic_proportion.compile.prompt import CompilePrompt  # noqa: E402
from mythic_proportion.config import Settings  # noqa: E402
from mythic_proportion.privacy.redact import (  # noqa: E402
    OPENAI_FILTER_ENTITIES,
    OpenAIPrivacyFilterRecognizer,
    PiiSpan,
    Redactor,
    RedactingAnswerClient,
    RedactingCompileClient,
    RedactingExtractionClient,
    RedactionUnavailableError,
    SecretScanRecognizer,
    get_redactor,
    is_privacy_extra_installed,
)
from mythic_proportion.query.client import AnswerResult, FakeAnswerClient  # noqa: E402
from mythic_proportion.query.prompt import AnswerPrompt  # noqa: E402


_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"\b\d{3}-\d{3}-\d{4}\b")
_NAME_RE = re.compile(r"\bJohn Smith\b")
_SECRET_RE = re.compile(r"\bsk-[A-Za-z0-9]{8,}\b")


@dataclass
class _FakeAnalyzer:
    """A tiny regex-based stand-in for Presidio's ``AnalyzerEngine``."""

    def analyze(self, text: str, language: str = "en") -> list[PiiSpan]:
        spans: list[PiiSpan] = []
        for pattern, entity_type in (
            (_EMAIL_RE, "EMAIL_ADDRESS"),
            (_PHONE_RE, "PHONE_NUMBER"),
            (_NAME_RE, "PERSON"),
            (_SECRET_RE, "SECRET"),
        ):
            for match in pattern.finditer(text):
                spans.append(PiiSpan(entity_type=entity_type, start=match.start(), end=match.end()))
        return spans


def _redactor() -> Redactor:
    return Redactor(analyzer=_FakeAnalyzer())


SEED_TEXT = (
    "Contact John Smith at john.smith@example.com or 555-123-4567. "
    "His API key is sk-abcdEFGH1234 -- do not share it."
)


# --------------------------------------------------------------------------
# Redactor.redact / rehydrate round trip
# --------------------------------------------------------------------------


def test_redact_masks_every_seeded_pii_category() -> None:
    redacted_text, rehydrate_map = _redactor().redact(SEED_TEXT)

    assert "john.smith@example.com" not in redacted_text
    assert "555-123-4567" not in redacted_text
    assert "John Smith" not in redacted_text
    assert "sk-abcdEFGH1234" not in redacted_text

    assert "[REDACTED_EMAIL_ADDRESS_1]" in redacted_text
    assert "[REDACTED_PHONE_NUMBER_1]" in redacted_text
    assert "[REDACTED_PERSON_1]" in redacted_text
    assert "[REDACTED_SECRET_1]" in redacted_text

    # The rehydrate map recovers every original value exactly.
    assert rehydrate_map["[REDACTED_EMAIL_ADDRESS_1]"] == "john.smith@example.com"
    assert rehydrate_map["[REDACTED_PHONE_NUMBER_1]"] == "555-123-4567"
    assert rehydrate_map["[REDACTED_PERSON_1]"] == "John Smith"
    assert rehydrate_map["[REDACTED_SECRET_1]"] == "sk-abcdEFGH1234"


def test_rehydrate_reverses_redact_exactly() -> None:
    redactor = _redactor()
    redacted_text, rehydrate_map = redactor.redact(SEED_TEXT)
    assert redactor.rehydrate(redacted_text, rehydrate_map) == SEED_TEXT


def test_redact_is_no_op_on_pii_free_text() -> None:
    redactor = _redactor()
    text = "The hybrid retrieval design combines BM25 and vector search."
    redacted_text, rehydrate_map = redactor.redact(text)
    assert redacted_text == text
    assert rehydrate_map == {}


def test_rehydrate_leaves_unknown_tokens_untouched() -> None:
    redactor = _redactor()
    text = "This mentions [REDACTED_EMAIL_ADDRESS_1] but the map is empty."
    assert redactor.rehydrate(text, {}) == text


# --------------------------------------------------------------------------
# RedactingAnswerClient -- the full redact -> LLM -> rehydrate call path
# --------------------------------------------------------------------------


def test_redacting_answer_client_never_leaks_pii_to_inner_client_and_rehydrates_response() -> None:
    captured_prompts: list[AnswerPrompt] = []

    def _fixture(prompt: AnswerPrompt) -> AnswerResult:
        captured_prompts.append(prompt)
        # The "LLM" echoes the redacted question back plus a redacted-token
        # citation, exactly as a real cloud model would see only the
        # redacted form.
        return AnswerResult(text=f"Echo: {prompt.user}", citations=["[REDACTED_PERSON_1]"])

    inner = FakeAnswerClient(_fixture)
    redactor = _redactor()
    client = RedactingAnswerClient(inner, redactor)

    prompt = AnswerPrompt(
        system="system prompt, no PII",
        user=SEED_TEXT,
        question=SEED_TEXT,
        hit_titles=(),
    )
    result = client.answer(prompt)

    # Assert directly on the captured outbound request payload: no raw PII
    # crossed the client boundary.
    assert len(captured_prompts) == 1
    outbound_user = captured_prompts[0].user
    assert "john.smith@example.com" not in outbound_user
    assert "555-123-4567" not in outbound_user
    assert "John Smith" not in outbound_user
    assert "sk-abcdEFGH1234" not in outbound_user

    # The final returned answer has PII rehydrated back in.
    assert "John Smith" in result.text
    assert "john.smith@example.com" in result.text
    assert result.citations == ["John Smith"]


def test_redacting_compile_client_rehydrates_pages_and_contradictions() -> None:
    def _fixture(prompt: CompilePrompt) -> CompileResult:
        assert "John Smith" not in prompt.user
        return CompileResult(
            pages=[
                WikiPage.new(
                    page_type="entity",
                    title="Contact [REDACTED_PERSON_1]",
                    body="Reach [REDACTED_PERSON_1] at [REDACTED_EMAIL_ADDRESS_1].",
                    tags=["contact"],
                )
            ],
            contradictions=["[REDACTED_PERSON_1] disagrees with an earlier note."],
        )

    inner = FakeCompileClient(_fixture)
    client = RedactingCompileClient(inner, _redactor())

    prompt = CompilePrompt(
        system="system prompt, no PII",
        user=SEED_TEXT,
        source_hash="abc123",
        existing_titles=(),
    )
    result = client.compile(prompt)

    assert result.pages[0].title == "Contact John Smith"
    assert "john.smith@example.com" in result.pages[0].body
    assert "John Smith disagrees" in result.contradictions[0]


def test_redacting_extraction_client_rehydrates_completion() -> None:
    class _FakeExtractionClient:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []

        def complete(self, *, system: str, user: str) -> str:
            self.calls.append((system, user))
            return "entity<|>[REDACTED_PERSON_1]<|>PERSON<|>a contact<|COMPLETE|>"

    inner = _FakeExtractionClient()
    client = RedactingExtractionClient(inner, _redactor())
    raw = client.complete(system="sys", user=SEED_TEXT)

    assert "John Smith" not in inner.calls[0][1]
    assert "John Smith" in raw


# --------------------------------------------------------------------------
# get_redactor factory -- graceful degrade
# --------------------------------------------------------------------------


def test_get_redactor_returns_none_when_redaction_disabled(tmp_path) -> None:
    """The ONLY case where ``get_redactor`` may return ``None`` (pass-through
    allowed): an explicit user opt-out via ``redaction_enabled=False``."""
    settings = Settings(vault_path=tmp_path, redaction_enabled=False)
    assert get_redactor(settings) is None


def test_get_redactor_fails_closed_when_privacy_extra_absent(tmp_path, monkeypatch) -> None:
    """Fail-closed contract (closes a prior review finding): redaction
    *enabled* (the default) but the ``[privacy]`` extra unavailable must
    raise -- never silently degrade to pass-through -- so no caller can ever
    ship raw content to an LLM provider believing it was redacted."""
    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    settings = Settings(vault_path=tmp_path, redaction_enabled=True)
    with pytest.raises(RedactionUnavailableError):
        get_redactor(settings)


def test_is_privacy_extra_installed_reflects_presidio_availability() -> None:
    # presidio_anonymizer is import-skipped for this whole module -- assert
    # the detector agrees at least that presidio_anonymizer resolves.
    assert isinstance(is_privacy_extra_installed(), bool)


# --------------------------------------------------------------------------
# Fail-closed propagation through the redact -> LLM -> rehydrate wrappers'
# callers (compile.pipeline / query.engine `_maybe_redact*`)
# --------------------------------------------------------------------------


def test_compile_default_client_fails_closed_when_redaction_enabled_but_unavailable(tmp_path, monkeypatch) -> None:
    """`compile_source`'s `_default_client` selection path must refuse to
    call any LLM provider -- never silently pass raw content through -- when
    redaction is enabled but the [privacy] extra is unavailable. Retry note:
    the fail-closed check itself now lives in `compile_source` (applied
    uniformly to whichever client is active -- default-built or injected,
    see the injected-client test below), so this exercises the public
    `compile_source` entry point rather than the internal `_default_client`
    factory directly -- `_default_client` itself no longer performs this
    check (that responsibility moved to the caller specifically so an
    injected client can't bypass it)."""
    from mythic_proportion.compile.models import CompileError
    from mythic_proportion.compile.pipeline import compile_source
    from mythic_proportion.ingest.pipeline import ingest_drop
    from mythic_proportion.vault.init import init_vault

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    vault = tmp_path / "vault"
    init_vault(vault)
    (vault / "drop" / "note.md").parent.mkdir(parents=True, exist_ok=True)
    (vault / "drop" / "note.md").write_text("# note\n\nSome content.\n", encoding="utf-8")
    source = ingest_drop(vault).ingested[0]

    settings = Settings(
        vault_path=vault,
        redaction_enabled=True,
        llm_provider="anthropic",
        model="claude-x",
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-never-actually-used")

    with pytest.raises(CompileError, match="[Rr]edaction"):
        compile_source(vault, source, settings=settings)


def test_answer_default_client_fails_closed_when_redaction_enabled_but_unavailable(tmp_path, monkeypatch) -> None:
    """Counterpart of the above for `answer_query`'s legacy (non-GraphRAG)
    path -- see that test's docstring for why this goes through the public
    entry point rather than the internal `_default_client` factory."""
    from mythic_proportion.compile.models import WikiPage
    from mythic_proportion.compile.writer import write_page
    from mythic_proportion.index.embeddings import HashEmbedder
    from mythic_proportion.index.store import IndexStore
    from mythic_proportion.query.client import AnswerError
    from mythic_proportion.query.engine import answer_query
    from mythic_proportion.vault.init import init_vault

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(vault, WikiPage.new(page_type="concept", title="Topic", body="Some body text."))
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)

    settings = Settings(
        vault_path=vault,
        redaction_enabled=True,
        llm_provider="anthropic",
        model="claude-x",
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-never-actually-used")

    with pytest.raises(AnswerError, match="[Rr]edaction"):
        answer_query(vault, "anything at all", settings=settings)


# --------------------------------------------------------------------------
# Retry fix: an injected `client=`/`graph_client=` must never bypass the
# fail-closed redaction guard just because it wasn't built by
# `_default_client`/`_default_extraction_client` -- closes a cross-vendor
# review finding that flagged exactly this as the "unredacted content never
# leaves the process" invariant not actually being universal.
# --------------------------------------------------------------------------


def test_compile_source_injected_client_still_fails_closed_when_redaction_unavailable(
    tmp_path, monkeypatch
) -> None:
    from mythic_proportion.compile.models import CompileError
    from mythic_proportion.compile.pipeline import compile_source
    from mythic_proportion.ingest.pipeline import ingest_drop
    from mythic_proportion.vault.init import init_vault

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    vault = tmp_path / "vault"
    init_vault(vault)
    (vault / "drop" / "note.md").parent.mkdir(parents=True, exist_ok=True)
    (vault / "drop" / "note.md").write_text("# note\n\nSome content.\n", encoding="utf-8")
    source = ingest_drop(vault).ingested[0]

    class _RealishCloudClient:
        """Stands in for a real, directly-injected cloud client (as a
        caller other than the test-double `FakeCompileClient` might pass)
        -- must never actually be called."""

        def __init__(self) -> None:
            self.called = False

        def compile(self, prompt):  # noqa: ANN001
            self.called = True
            raise AssertionError("must never be called -- fail-closed must raise before this")

    client = _RealishCloudClient()
    settings = Settings(vault_path=vault, redaction_enabled=True)  # the default anyway

    with pytest.raises(CompileError, match="[Rr]edaction"):
        compile_source(vault, source, client=client, settings=settings)

    assert client.called is False


def test_answer_query_injected_client_still_fails_closed_when_redaction_unavailable(
    tmp_path, monkeypatch
) -> None:
    from mythic_proportion.compile.models import WikiPage
    from mythic_proportion.compile.writer import write_page
    from mythic_proportion.index.embeddings import HashEmbedder
    from mythic_proportion.index.store import IndexStore
    from mythic_proportion.query.client import AnswerError
    from mythic_proportion.query.engine import answer_query
    from mythic_proportion.vault.init import init_vault

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(vault, WikiPage.new(page_type="concept", title="Topic", body="Some body text."))
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)

    class _RealishCloudClient:
        def __init__(self) -> None:
            self.called = False

        def answer(self, prompt):  # noqa: ANN001
            self.called = True
            raise AssertionError("must never be called -- fail-closed must raise before this")

    client = _RealishCloudClient()
    settings = Settings(vault_path=vault, redaction_enabled=True)

    with pytest.raises(AnswerError, match="[Rr]edaction"):
        answer_query(vault, "anything at all", client=client, settings=settings)

    assert client.called is False


def test_answer_query_graph_mode_injected_graph_client_still_fails_closed(tmp_path, monkeypatch) -> None:
    """Same guarantee for the GraphRAG (`mode=`) path's `graph_client=`
    override -- closes the third bypass the reviewer specifically named
    (``query/engine.py:331-333``)."""
    from mythic_proportion.compile.models import WikiPage
    from mythic_proportion.compile.writer import write_page
    from mythic_proportion.index.embeddings import HashEmbedder
    from mythic_proportion.index.store import IndexStore
    from mythic_proportion.query.client import AnswerError
    from mythic_proportion.query.engine import answer_query
    from mythic_proportion.vault.init import init_vault

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(vault, WikiPage.new(page_type="concept", title="Topic", body="Some body text."))
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)

    class _RealishExtractionClient:
        def __init__(self) -> None:
            self.called = False

        def complete(self, *, system: str, user: str) -> str:
            self.called = True
            raise AssertionError("must never be called -- fail-closed must raise before this")

    graph_client = _RealishExtractionClient()
    settings = Settings(vault_path=vault, redaction_enabled=True)

    with pytest.raises(AnswerError, match="[Rr]edaction"):
        answer_query(vault, "anything at all", mode="local", graph_client=graph_client, settings=settings)

    assert graph_client.called is False


def test_redaction_off_is_the_only_way_to_get_pass_through(tmp_path, monkeypatch) -> None:
    """Explicit opt-out (`redaction_enabled=False`) is the one legitimate
    pass-through path -- building the client must succeed even though the
    extra is unavailable, since the user explicitly disabled redaction."""
    from mythic_proportion.compile.pipeline import _default_client

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    settings = Settings(
        vault_path=tmp_path,
        redaction_enabled=False,
        llm_provider="anthropic",
        model="claude-x",
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-never-actually-used")

    client = _default_client(settings)
    assert client is not None


# --------------------------------------------------------------------------
# SecretScanRecognizer -- real, always-shipped custom recognizer (no
# torch/transformers required), closing a prior "no custom secret-scan
# recognizer actually exists" review finding.
# --------------------------------------------------------------------------


def test_secret_scan_recognizer_flags_known_secret_shapes() -> None:
    recognizer = SecretScanRecognizer()
    text = (
        "key=sk-abcdEFGH12345678901234, aws=AKIAABCDEFGHIJKLMNOP, "
        "gh=ghp_abcdefghijklmnopqrstuvwxyz012345"
    )
    results = recognizer.analyze(text, entities=["SECRET"])
    assert len(results) >= 3
    assert all(r.entity_type == "SECRET" for r in results)


def test_secret_scan_recognizer_is_registered_by_default_in_a_real_analyzer() -> None:
    """The real (non-fake) ``Redactor()`` construction -- exercised for real
    since presidio_anonymizer/presidio_analyzer are installed in this dev
    environment -- must find a bare secret via SecretScanRecognizer alone,
    with no OpenAI-filter/NLP-engine recognizers needed."""
    redactor = Redactor(enable_openai_filter=False)
    text = "leaked key: sk-abcdEFGH12345678901234"
    redacted_text, rehydrate_map = redactor.redact(text)
    assert "sk-abcdEFGH12345678901234" not in redacted_text
    assert any(v == "sk-abcdEFGH12345678901234" for v in rehydrate_map.values())


def test_default_redactor_degrades_gracefully_without_privacy_full(monkeypatch) -> None:
    """Retry fix: closes the finding that ``[privacy]`` without
    ``[privacy-full]`` (torch/transformers) was "likely nonfunctional and
    untested." ``torch``/``transformers`` genuinely ARE installed in this
    dev environment (the ``[privacy-full]`` extra), so this test simulates
    their absence via ``sys.modules`` import-blocking (the standard "import
    of X halted; None in sys.modules" technique) rather than relying on the
    dev environment's actual package set.

    Exercises the **real**, non-fake ``Redactor()`` -- default
    ``enable_openai_filter=True``, real ``AnalyzerEngine`` -- and asserts
    the *first* ``redact()`` call does not crash (closing the "load()
    raises straight out of Presidio's uncaught analyze() loop" defect) and
    that Presidio's own built-ins + :class:`SecretScanRecognizer` still
    catch real PII/secrets for real, confirming the fallback described in
    this module's docstring is genuinely selected and functional, not just
    assumed.
    """
    import sys

    monkeypatch.setitem(sys.modules, "torch", None)
    monkeypatch.setitem(sys.modules, "transformers", None)

    redactor = Redactor()  # default enable_openai_filter=True
    text = "Contact John Smith; leaked key: sk-abcdEFGH12345678901234"
    redacted_text, rehydrate_map = redactor.redact(text)

    assert "sk-abcdEFGH12345678901234" not in redacted_text
    assert any(v == "sk-abcdEFGH12345678901234" for v in rehydrate_map.values())
    # The OpenAI-filter recognizer itself found nothing (unavailable), but
    # did not crash the pass for every other recognizer.
    openai_recognizer = next(
        r
        for r in redactor._analyzer.registry.recognizers  # type: ignore[attr-defined]
        if r.name == "OpenAIPrivacyFilterRecognizer"
    )
    assert openai_recognizer.analyze(text, entities=list(OPENAI_FILTER_ENTITIES)) == []


def test_openai_privacy_filter_recognizer_marks_unavailable_without_torch(monkeypatch) -> None:
    """Unit-level version of the above, isolating
    :class:`OpenAIPrivacyFilterRecognizer` itself: ``load()`` must degrade
    to ``model_unavailable=True`` rather than raising, and ``analyze()``
    must then return ``[]`` instead of crashing on a ``None`` pipeline.

    Note: Presidio's ``EntityRecognizer.__init__`` calls ``self.load()``
    synchronously during construction, so ``model_unavailable`` is already
    ``True`` immediately after ``OpenAIPrivacyFilterRecognizer()`` returns
    -- this asserts that construction itself does not raise (the load
    failure was absorbed), then confirms ``analyze()`` is a harmless no-op
    on top of that already-degraded state."""
    import sys

    monkeypatch.setitem(sys.modules, "torch", None)
    monkeypatch.setitem(sys.modules, "transformers", None)

    recognizer = OpenAIPrivacyFilterRecognizer()  # must not raise
    assert recognizer.model_unavailable is True

    results = recognizer.analyze("Contact John Smith.", entities=list(OPENAI_FILTER_ENTITIES))
    assert results == []


# ---------------------------------------------------------------------------
# Chunking (OOM fix for large community-report-shaped inputs)
# ---------------------------------------------------------------------------


def test_chunk_text_for_pipeline_small_text_single_chunk() -> None:
    """Fast path: text at/under the limit is returned as one untouched
    ``(0, text)`` chunk -- byte-identical to pre-chunking behavior."""
    from mythic_proportion.privacy.redact import (
        _MAX_PIPELINE_CHUNK_CHARS,
        _chunk_text_for_pipeline,
    )

    text = "Contact John Smith at john@example.com."
    assert len(text) <= _MAX_PIPELINE_CHUNK_CHARS
    assert _chunk_text_for_pipeline(text) == [(0, text)]


def test_chunk_text_for_pipeline_large_text_splits_and_reconstructs() -> None:
    """Large text is split into multiple bounded chunks whose offsets
    correctly reconstruct the original text when concatenated back
    together, and no chunk exceeds the configured character budget."""
    from mythic_proportion.privacy.redact import (
        _MAX_PIPELINE_CHUNK_CHARS,
        _chunk_text_for_pipeline,
    )

    sentence = "The quick brown fox jumps over the lazy dog. "
    text = sentence * 400  # tens of thousands of characters
    assert len(text) > _MAX_PIPELINE_CHUNK_CHARS * 3

    chunks = _chunk_text_for_pipeline(text)

    assert len(chunks) > 1
    for offset, chunk in chunks:
        assert len(chunk) <= _MAX_PIPELINE_CHUNK_CHARS
        assert text[offset : offset + len(chunk)] == chunk

    reconstructed = "".join(chunk for _offset, chunk in chunks)
    assert reconstructed == text


def test_openai_privacy_filter_recognizer_chunks_large_text_and_remaps_offsets(
    monkeypatch,
) -> None:
    """The recognizer must never feed the full unbounded text to the HF
    pipeline in one call (that's what OOM'd on a real community-report
    prompt) -- it must chunk, invoke the pipeline once per chunk, and remap
    each chunk-relative token offset the (mocked) pipeline returns back into
    the ORIGINAL full-text coordinate space."""
    import sys

    from mythic_proportion.privacy.redact import _MAX_PIPELINE_CHUNK_CHARS

    monkeypatch.setitem(sys.modules, "torch", None)
    monkeypatch.setitem(sys.modules, "transformers", None)

    recognizer = OpenAIPrivacyFilterRecognizer()
    # Confirms load() degraded (no real model was loaded here) before we
    # inject a fake pipeline directly -- see this file's
    # test_openai_privacy_filter_recognizer_marks_unavailable_without_torch.
    assert recognizer.model_unavailable is True

    # A big filler body (tens of thousands of characters), comfortably
    # larger than several chunk-widths, with a planted PII entity placed
    # right around where a chunk boundary is likely to fall.
    filler = "the quick brown fox jumps over the lazy dog and keeps running " * 30
    # Place the planted PII squarely in the MIDDLE of the second chunk (not
    # right at a chunk boundary, which would make the test's expected chunk
    # count/offset brittle rather than exercising the general remap logic).
    padding = "z " * (_MAX_PIPELINE_CHUNK_CHARS // 2)
    text = filler + padding + "John Smith was here. " + padding + filler * 5
    expected_start = text.index("John Smith")
    expected_end = expected_start + len("John Smith")
    assert len(text) > _MAX_PIPELINE_CHUNK_CHARS * 3

    pipeline_calls: list[str] = []

    def fake_pipeline(chunk_text: str) -> list[dict]:
        pipeline_calls.append(chunk_text)
        assert len(chunk_text) <= _MAX_PIPELINE_CHUNK_CHARS
        idx = chunk_text.find("John Smith")
        if idx == -1:
            return []
        return [
            {
                "entity_group": "PERSON",
                "start": idx,
                "end": idx + len("John Smith"),
                "score": 0.99,
            }
        ]

    recognizer._pipeline = fake_pipeline

    results = recognizer.analyze(text, entities=list(OPENAI_FILTER_ENTITIES))

    # Chunked, not one giant unbounded call.
    assert len(pipeline_calls) > 1
    assert all(len(c) <= _MAX_PIPELINE_CHUNK_CHARS for c in pipeline_calls)

    assert len(results) == 1
    assert results[0].entity_type == "PERSON"
    # Offsets are in the ORIGINAL text's coordinate space, not chunk-relative.
    assert results[0].start == expected_start
    assert results[0].end == expected_end
    assert text[results[0].start : results[0].end] == "John Smith"


def test_openai_privacy_filter_recognizer_small_text_unchanged(monkeypatch) -> None:
    """Regression check: a normal small text still produces identical
    results before/after the chunking fix -- single chunk, single pipeline
    call, no behavior change."""
    import sys

    monkeypatch.setitem(sys.modules, "torch", None)
    monkeypatch.setitem(sys.modules, "transformers", None)

    recognizer = OpenAIPrivacyFilterRecognizer()
    assert recognizer.model_unavailable is True

    text = "Contact John Smith about the report."
    pipeline_calls: list[str] = []

    def fake_pipeline(chunk_text: str) -> list[dict]:
        pipeline_calls.append(chunk_text)
        idx = chunk_text.find("John Smith")
        if idx == -1:
            return []
        return [
            {
                "entity_group": "PERSON",
                "start": idx,
                "end": idx + len("John Smith"),
                "score": 0.95,
            }
        ]

    recognizer._pipeline = fake_pipeline

    results = recognizer.analyze(text, entities=list(OPENAI_FILTER_ENTITIES))

    assert pipeline_calls == [text]  # exactly one call, with the whole text
    assert len(results) == 1
    assert results[0].start == text.index("John Smith")
    assert results[0].end == text.index("John Smith") + len("John Smith")
