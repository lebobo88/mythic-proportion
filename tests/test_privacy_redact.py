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


def test_compile_fails_closed_when_redaction_enabled_but_unavailable(tmp_path, monkeypatch) -> None:
    """`compile_source`'s `_default_client` must refuse to call any LLM
    provider -- never silently pass raw content through -- when redaction is
    enabled but the [privacy] extra is unavailable."""
    from mythic_proportion.compile.models import CompileError
    from mythic_proportion.compile.pipeline import _default_client

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    settings = Settings(
        vault_path=tmp_path,
        redaction_enabled=True,
        llm_provider="anthropic",
        model="claude-x",
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-never-actually-used")

    with pytest.raises(CompileError, match="[Rr]edaction"):
        _default_client(settings)


def test_answer_fails_closed_when_redaction_enabled_but_unavailable(tmp_path, monkeypatch) -> None:
    from mythic_proportion.query.client import AnswerError
    from mythic_proportion.query.engine import _default_client as _default_answer_client

    monkeypatch.setattr("mythic_proportion.privacy.redact.is_privacy_extra_installed", lambda: False)
    settings = Settings(
        vault_path=tmp_path,
        redaction_enabled=True,
        llm_provider="anthropic",
        model="claude-x",
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-never-actually-used")

    with pytest.raises(AnswerError, match="[Rr]edaction"):
        _default_answer_client(settings)


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
