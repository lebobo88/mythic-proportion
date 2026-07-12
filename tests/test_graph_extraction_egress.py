"""Integration test for the GraphRAG PII cloud-egress gate (Phase 3/4 bugfix,
DEFECT 4 -- "redaction/rehydration failure on repair & gleaning rounds").

Drives a genuinely multi-round extraction turn (initial call -> repair ->
gleaning -> gleaning-repair) through :class:`RedactingExtractionClient`,
using a deterministic mocked "LLM" that deliberately forces every one of
those rounds, with real PII (name/email/phone) planted in the source text.

This pins the fix for the defect where the repair/gleaning loops in
``graph.extract``/``graph.claims`` spliced an ALREADY-REHYDRATED (real-PII)
prior completion into a new outbound prompt, which then got redacted FRESH
on the next call -- and Presidio measurably under-detects PII in
pipe-delimited-tuple-formatted text, so real PII could reach "the LLM"
(the mocked inner client here, standing in for the cloud provider) on any
repair/gleaning round.

No real ``presidio``/``torch`` model is loaded: :class:`Redactor` is built
with the same tiny regex-based fake analyzer pattern
``tests/test_privacy_redact.py`` already uses (duplicated here rather than
imported, to keep this module runnable standalone and avoid coupling two
test modules' internals together).
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import pytest

pytest.importorskip("presidio_anonymizer")

from mythic_proportion.graph.cache import LlmCache  # noqa: E402
from mythic_proportion.graph.claims import extract_claims  # noqa: E402
from mythic_proportion.graph.extract import extract_entities_relationships  # noqa: E402
from mythic_proportion.privacy.redact import PiiSpan, Redactor, RedactingExtractionClient  # noqa: E402

_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "src" / "mythic_proportion" / "index" / "schema.sql"

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"\b\d{3}-\d{3}-\d{4}\b")
_NAME_RE = re.compile(r"\bJohn Smith\b")

PLANTED_NAME = "John Smith"
PLANTED_EMAIL = "john.smith@example.com"
PLANTED_PHONE = "555-123-4567"

SOURCE_TEXT = f"Contact {PLANTED_NAME} at {PLANTED_EMAIL} or {PLANTED_PHONE}. He is the primary owner."

_PII_SUBSTRINGS = (PLANTED_NAME, PLANTED_EMAIL, PLANTED_PHONE)


@dataclass
class _FakeAnalyzer:
    """Tiny regex-based stand-in for Presidio's ``AnalyzerEngine`` -- same
    shape as ``tests/test_privacy_redact.py``'s fixture."""

    def analyze(self, text: str, language: str = "en") -> list[PiiSpan]:
        spans: list[PiiSpan] = []
        for pattern, entity_type in ((_EMAIL_RE, "EMAIL_ADDRESS"), (_PHONE_RE, "PHONE_NUMBER"), (_NAME_RE, "PERSON")):
            for match in pattern.finditer(text):
                spans.append(PiiSpan(entity_type=entity_type, start=match.start(), end=match.end()))
        return spans


def _redactor() -> Redactor:
    return Redactor(analyzer=_FakeAnalyzer())


def _memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return conn


class _CapturingInnerClient:
    """Stands in for the real cloud LLM -- every ``complete()`` call it
    receives IS the literal outbound payload that would cross the
    local-to-cloud trust boundary. Captures every call for assertion and
    replays a scripted response sequence to deterministically force a
    repair round AND a gleaning round (with its own repair round)."""

    def __init__(self, responses: list[str]) -> None:
        self._responses = responses
        self.calls: list[tuple[str, str]] = []

    def complete(self, *, system: str, user: str) -> str:
        idx = len(self.calls)
        self.calls.append((system, user))
        return self._responses[min(idx, len(self._responses) - 1)]

    def assert_never_leaked_pii(self) -> None:
        for _system, user in self.calls:
            for needle in _PII_SUBSTRINGS:
                assert needle not in user, f"outbound payload leaked PII {needle!r}: {user!r}"


def test_extraction_turn_repair_and_gleaning_never_leak_pii_and_final_records_are_clean() -> None:
    # Round 1 (initial extraction call): malformed, unparseable output --
    # forces a repair round-trip (`_parse_with_one_repair`).
    # Round 2 (repair): a well-formed entity record that echoes back the
    # REDACTED_PERSON/EMAIL tokens the model actually saw (it never saw the
    # real name/email -- only the wrapper's redacted form).
    # Round 3 (gleaning "did I miss any?" call): another malformed output --
    # forces a SECOND repair round-trip, this time inside the gleaning loop.
    # Round 4 (gleaning-repair): a well-formed relationship record, again
    # only ever referencing REDACTED_* tokens.
    responses = [
        "sorry, I could not find any entities in that text",
        '("entity"<|>[REDACTED_PERSON_1]<|>PERSON<|>Reachable at [REDACTED_EMAIL_ADDRESS_1])<|COMPLETE|>',
        "nothing well-formed to add here either, my apologies",
        (
            '("entity"<|>[REDACTED_PERSON_1]<|>PERSON<|>Also reachable at [REDACTED_PHONE_NUMBER_1])##'
            '("relationship"<|>[REDACTED_PERSON_1]<|>[REDACTED_EMAIL_ADDRESS_1]<|>owns<|>5)<|COMPLETE|>'
        ),
    ]
    inner = _CapturingInnerClient(responses)
    client = RedactingExtractionClient(inner, _redactor())
    conn = _memory_conn()
    cache = LlmCache(conn)

    entities, relationships, llm_calls = extract_entities_relationships(
        SOURCE_TEXT, client=client, cache=cache, model="mock", max_gleanings=1
    )

    # (a) No cloud-outbound text at ANY point during the turn (initial,
    # repair, or gleaning) may contain unredacted PII.
    inner.assert_never_leaked_pii()
    assert llm_calls == len(responses)  # every round was a genuine cache miss

    # (b) No REDACTED_* placeholder may survive into the final persisted
    # entity/relationship record -- and the real PII must have come back.
    for entity in entities:
        assert "REDACTED_" not in entity.title
        assert "REDACTED_" not in entity.description
    for relationship in relationships:
        assert "REDACTED_" not in relationship.source
        assert "REDACTED_" not in relationship.target
        assert "REDACTED_" not in relationship.description

    assert any(PLANTED_NAME.upper() in e.title for e in entities)
    assert any(PLANTED_EMAIL in e.description or PLANTED_PHONE in e.description for e in entities)


def test_extract_claims_repair_round_never_leaks_pii_and_final_claims_are_clean() -> None:
    """Same defect, exercised via `extract_claims`'s (shared) repair path --
    `_parse_with_one_repair` is reused verbatim by both extraction paths, so
    this pins the fix there too."""
    responses = [
        "no claims found, sorry about that",
        (
            '("claim"<|>[REDACTED_PERSON_1]<|>NONE<|>CONTACT<|>TRUE<|>NONE<|>NONE<|>'
            "Reachable at [REDACTED_EMAIL_ADDRESS_1] or [REDACTED_PHONE_NUMBER_1])<|COMPLETE|>"
        ),
    ]
    inner = _CapturingInnerClient(responses)
    client = RedactingExtractionClient(inner, _redactor())
    conn = _memory_conn()
    cache = LlmCache(conn)

    claims, llm_calls = extract_claims(SOURCE_TEXT, ["JOHN SMITH"], client=client, cache=cache, model="mock")

    inner.assert_never_leaked_pii()
    assert llm_calls == len(responses)

    assert claims  # the repair round-trip produced a usable claim
    for claim in claims:
        assert "REDACTED_" not in claim.subject
        assert "REDACTED_" not in claim.description
        if claim.object:
            assert "REDACTED_" not in claim.object
    assert any(PLANTED_EMAIL in c.description or PLANTED_PHONE in c.description for c in claims)
