"""Unit tests for the fully-local Ollama client (``mythic_proportion.llm.ollama``).

Mirrors ``test_authhub.py``'s shape: the HTTP layer is mocked via
``monkeypatch``ing ``httpx.post``/``httpx.get`` for every correctness
assertion (request shape, structured-outputs ``format`` schema, response
parsing, retry-then-raise) -- no real request/response handling is bypassed,
only the transport. A final, separately-gated section does one real live
smoke-check against a local Ollama daemon when reachable (``is_ollama_reachable()``),
skipping cleanly otherwise -- this environment DID have a reachable local
Ollama daemon at test-authoring time (see the Phase 6 stage summary for the
live-reachability note), but the test degrades gracefully wherever it runs.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from mythic_proportion.compile.models import CompileError
from mythic_proportion.compile.prompt import CompilePrompt
from mythic_proportion.graph.extract import ExtractionError
from mythic_proportion.llm.ollama import (
    ANSWER_JSON_SCHEMA,
    COMPILE_JSON_SCHEMA,
    OllamaAnswerClient,
    OllamaCompileClient,
    OllamaConfigError,
    OllamaExtractionClient,
    is_loopback_url,
    is_ollama_reachable,
    require_loopback_url,
)
from mythic_proportion.query.client import AnswerError
from mythic_proportion.query.prompt import AnswerPrompt


class _FakeResponse:
    def __init__(self, *, status_code: int = 200, payload: dict[str, Any] | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("POST", "http://example.invalid")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)

    def json(self) -> dict[str, Any]:
        return self._payload


def _chat_payload(content: str) -> dict[str, Any]:
    return {"message": {"role": "assistant", "content": content}, "done": True}


def _compile_prompt() -> CompilePrompt:
    return CompilePrompt(
        system="You are the compile step.",
        user="Compile this source.",
        source_hash="abc123",
        existing_titles=(),
    )


def _answer_prompt() -> AnswerPrompt:
    return AnswerPrompt(
        system="You are the query step.",
        user="Answer this question.",
        question="What is this?",
        hit_titles=("Some Page",),
    )


# --------------------------------------------------------------------------
# Request shape: URL / structured-outputs `format` schema / no network host
# --------------------------------------------------------------------------


def test_compile_request_hits_local_chat_endpoint_with_json_schema_format(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def _fake_post(url: str, *, json: dict[str, Any], timeout: float) -> _FakeResponse:
        captured["url"] = url
        captured["body"] = json
        return _FakeResponse(payload=_chat_payload('{"pages": [], "contradictions": []}'))

    monkeypatch.setattr("httpx.post", _fake_post)

    client = OllamaCompileClient(base_url="http://localhost:11434", model="qwen2.5:7b-instruct")
    result = client.compile(_compile_prompt())

    assert captured["url"] == "http://localhost:11434/api/chat"
    assert captured["body"]["model"] == "qwen2.5:7b-instruct"
    assert captured["body"]["format"] == COMPILE_JSON_SCHEMA
    assert captured["body"]["messages"][0] == {"role": "system", "content": "You are the compile step."}
    assert captured["body"]["messages"][1] == {"role": "user", "content": "Compile this source."}
    assert result.pages == []


def test_answer_request_uses_answer_json_schema(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def _fake_post(url: str, *, json: dict[str, Any], timeout: float) -> _FakeResponse:
        captured["body"] = json
        return _FakeResponse(payload=_chat_payload('{"answer": "hi", "citations": []}'))

    monkeypatch.setattr("httpx.post", _fake_post)

    client = OllamaAnswerClient()
    result = client.answer(_answer_prompt())

    assert captured["body"]["format"] == ANSWER_JSON_SCHEMA
    assert result.text == "hi"


def test_extraction_request_has_no_format_schema(monkeypatch) -> None:
    """Extraction output is delimited tuples, not JSON -- no `format` key."""
    captured: dict[str, Any] = {}

    def _fake_post(url: str, *, json: dict[str, Any], timeout: float) -> _FakeResponse:
        captured["body"] = json
        return _FakeResponse(payload=_chat_payload("entity<|>Acme<|>ORG<|>a company<|COMPLETE|>"))

    monkeypatch.setattr("httpx.post", _fake_post)

    client = OllamaExtractionClient()
    raw = client.complete(system="sys", user="extract from this")

    assert "format" not in captured["body"]
    assert raw == "entity<|>Acme<|>ORG<|>a company<|COMPLETE|>"


def test_only_localhost_is_ever_contacted_by_default() -> None:
    client = OllamaAnswerClient()
    assert client._base_url == "http://localhost:11434"  # noqa: SLF001


# --------------------------------------------------------------------------
# Loopback enforcement -- closes a prior review finding: `local: true` (or
# any Ollama client) must never be constructible against a non-loopback
# `ollama_base_url`, proving the fail-closed behavior rather than merely
# checking the *default* URL is localhost.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        ("http://localhost:11434", True),
        ("http://127.0.0.1:11434", True),
        ("http://[::1]:11434", True),
        ("http://example.com:11434", False),
        ("http://192.168.1.50:11434", False),
        ("https://ollama.mycompany.internal", False),
        ("not a url", False),
        ("", False),
    ],
)
def test_is_loopback_url(url: str, expected: bool) -> None:
    assert is_loopback_url(url) is expected


def test_require_loopback_url_raises_on_non_loopback() -> None:
    with pytest.raises(OllamaConfigError, match="loopback"):
        require_loopback_url("http://evil.example.com:11434", context="test")


def test_require_loopback_url_passes_on_loopback() -> None:
    require_loopback_url("http://127.0.0.1:11434", context="test")  # must not raise


@pytest.mark.parametrize("client_cls", [OllamaCompileClient, OllamaAnswerClient, OllamaExtractionClient])
def test_ollama_client_construction_rejects_non_loopback_base_url(client_cls) -> None:
    """Defense-in-depth: every Ollama* client's own constructor refuses a
    non-loopback base_url, regardless of caller-side checks -- this is the
    construction-time half of the loopback-enforcement contract (the
    config-set-time half lives in test_web_config.py /
    test_post_config_rejects_non_loopback_ollama_base_url_under_local_true)."""
    with pytest.raises(OllamaConfigError, match="loopback"):
        client_cls(base_url="http://some-remote-host.example.com:11434")


def test_ollama_client_construction_accepts_loopback_base_url() -> None:
    OllamaAnswerClient(base_url="http://127.0.0.1:11434")  # must not raise


# --------------------------------------------------------------------------
# Response parsing (real parsing code -- only the transport is mocked)
# --------------------------------------------------------------------------


def test_compile_parses_fenced_json_response(monkeypatch) -> None:
    content = '```json\n{"pages": [{"page_type": "concept", "title": "T", "body": "B"}], "contradictions": []}\n```'

    def _fake_post(url: str, *, json: dict[str, Any], timeout: float) -> _FakeResponse:
        return _FakeResponse(payload=_chat_payload(content))

    monkeypatch.setattr("httpx.post", _fake_post)

    client = OllamaCompileClient()
    result = client.compile(_compile_prompt())
    assert result.pages[0].title == "T"


def test_answer_retries_then_raises_answer_error(monkeypatch) -> None:
    calls = {"n": 0}

    def _fake_post(url: str, *, json: dict[str, Any], timeout: float) -> _FakeResponse:
        calls["n"] += 1
        return _FakeResponse(status_code=500)

    monkeypatch.setattr("httpx.post", _fake_post)

    client = OllamaAnswerClient(max_retries=2)
    with pytest.raises(AnswerError):
        client.answer(_answer_prompt())
    assert calls["n"] == 3  # initial attempt + 2 retries


def test_extraction_retries_then_raises_extraction_error(monkeypatch) -> None:
    def _fake_post(url: str, *, json: dict[str, Any], timeout: float) -> _FakeResponse:
        return _FakeResponse(status_code=500)

    monkeypatch.setattr("httpx.post", _fake_post)

    client = OllamaExtractionClient(max_retries=1)
    with pytest.raises(ExtractionError):
        client.complete(system="s", user="u")


def test_compile_raises_compile_error_when_httpx_missing(monkeypatch) -> None:
    client = OllamaCompileClient(max_retries=0)
    monkeypatch.setattr(
        "mythic_proportion.llm.ollama._OllamaBase._ensure_httpx",
        lambda self: (_ for _ in ()).throw(CompileError("pip install 'mythic-proportion[local]'")),
    )
    with pytest.raises(CompileError, match="local"):
        client.compile(_compile_prompt())


# --------------------------------------------------------------------------
# is_ollama_reachable -- never raises, degrades to False
# --------------------------------------------------------------------------


def test_is_ollama_reachable_true_on_200(monkeypatch) -> None:
    monkeypatch.setattr("httpx.get", lambda url, timeout: _FakeResponse(status_code=200))
    assert is_ollama_reachable() is True


def test_is_ollama_reachable_false_on_connection_error(monkeypatch) -> None:
    def _raise(url: str, timeout: float) -> Any:
        raise ConnectionError("daemon not running")

    monkeypatch.setattr("httpx.get", _raise)
    assert is_ollama_reachable() is False


# --------------------------------------------------------------------------
# Live smoke-check (separately gated, real network, skips cleanly)
# --------------------------------------------------------------------------


def test_live_ollama_smoke_check_if_reachable() -> None:
    """Best-effort live check: if a local Ollama daemon is actually running,
    exercise one real structured-output round trip end-to-end against
    whatever model is currently pulled. Skips (does not fail) if Ollama
    isn't reachable, or has no models pulled -- this is an opportunistic
    smoke-check, not a hard CI requirement."""
    if not is_ollama_reachable():
        pytest.skip("no local Ollama daemon reachable at localhost:11434")

    try:
        tags = httpx.get("http://localhost:11434/api/tags", timeout=2.0).json()
        models = [m["name"] for m in tags.get("models", [])]
    except Exception:
        pytest.skip("could not list local Ollama models")
    if not models:
        pytest.skip("Ollama is reachable but has no models pulled")

    client = OllamaAnswerClient(model=models[0], max_retries=0, timeout=30.0)
    prompt = AnswerPrompt(
        system="Reply with strict JSON only.",
        user="Say hello in one short sentence.",
        question="Say hello.",
        hit_titles=(),
    )
    try:
        result = client.answer(prompt)
    except AnswerError as exc:
        pytest.skip(f"live Ollama call failed (model may not support structured outputs): {exc}")
    assert isinstance(result.text, str)
