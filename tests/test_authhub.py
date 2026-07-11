"""Unit tests for the AuthHub gateway client (``mythic_proportion.llm.authhub``).

The HTTP layer is mocked via ``monkeypatch``ing ``httpx.post`` -- no live
network call is ever made. Covers: correct URL/headers/body, prompted-JSON
parsing (including ```json fences and surrounding prose), retry-then-raise
on failure, and protocol conformance with ``CompileClient``/``AnswerClient``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from mythic_proportion.compile.client import CompileClient
from mythic_proportion.compile.models import CompileError
from mythic_proportion.compile.prompt import CompilePrompt
from mythic_proportion.llm.authhub import (
    AuthHubAnswerClient,
    AuthHubCompileClient,
    extract_json_object,
)
from mythic_proportion.query.client import AnswerClient, AnswerError
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
    return {"choices": [{"message": {"content": content}}], "usage": {}}


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
# Request shape: URL / headers / body
# --------------------------------------------------------------------------


def test_compile_client_posts_correct_url_headers_and_body(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def _fake_post(url, **kwargs: Any):
        captured["url"] = url
        captured["headers"] = kwargs["headers"]
        captured["json"] = kwargs["json"]
        captured["timeout"] = kwargs["timeout"]
        content = json.dumps({"pages": [], "contradictions": []})
        return _FakeResponse(payload=_chat_payload(content))

    monkeypatch.setattr(httpx, "post", _fake_post)

    client = AuthHubCompileClient(
        base_url="http://localhost:3000/",
        api_key="ak_test123",
        model="deepseek-chat",
        route_alias="fast-route",
    )
    result = client.compile(_compile_prompt())

    assert result.pages == []
    assert captured["url"] == "http://localhost:3000/api/v1/ai/chat/completions"
    assert captured["headers"]["X-API-Key"] == "ak_test123"
    assert captured["headers"]["Content-Type"] == "application/json"
    body = captured["json"]
    assert body["model"] == "deepseek-chat"
    assert body["route_alias"] == "fast-route"
    assert body["messages"][0]["role"] == "system"
    assert "emit_wiki_pages" not in body  # no tools/tool_choice in the AuthHub contract
    assert "tools" not in body
    assert "tool_choice" not in body
    assert "response_format" not in body
    assert body["messages"][1]["role"] == "user"
    assert body["messages"][1]["content"] == "Compile this source."
    # The strict-JSON directive is appended to the system message, not sent
    # as a separate tools/response_format option.
    assert "JSON object" in body["messages"][0]["content"]


def test_route_alias_omitted_when_not_configured(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def _fake_post(url, **kwargs: Any):
        captured["json"] = kwargs["json"]
        content = json.dumps({"answer": "hi", "citations": []})
        return _FakeResponse(payload=_chat_payload(content))

    monkeypatch.setattr(httpx, "post", _fake_post)

    client = AuthHubAnswerClient(base_url="http://localhost:3000", api_key="ak_x", model="deepseek-chat")
    client.answer(_answer_prompt())

    assert "route_alias" not in captured["json"]


# --------------------------------------------------------------------------
# Prompted-JSON parsing: fences, surrounding prose, bare object
# --------------------------------------------------------------------------


def test_extract_json_object_bare() -> None:
    data = extract_json_object('{"answer": "hi", "citations": []}')
    assert data == {"answer": "hi", "citations": []}


def test_extract_json_object_with_code_fence() -> None:
    content = '```json\n{"answer": "hi", "citations": ["A"]}\n```'
    data = extract_json_object(content)
    assert data == {"answer": "hi", "citations": ["A"]}


def test_extract_json_object_with_plain_fence_no_lang() -> None:
    content = '```\n{"answer": "hi"}\n```'
    data = extract_json_object(content)
    assert data == {"answer": "hi"}


def test_extract_json_object_with_surrounding_prose() -> None:
    content = 'Sure, here is the answer:\n\n{"answer": "hi", "citations": []}\n\nHope that helps!'
    data = extract_json_object(content)
    assert data == {"answer": "hi", "citations": []}


def test_extract_json_object_with_nested_braces_in_prose() -> None:
    content = (
        'Here you go: {"pages": [{"page_type": "concept", "title": "A {curly} title", '
        '"tags": [], "body": "b"}], "contradictions": []} -- done.'
    )
    data = extract_json_object(content)
    assert data["pages"][0]["title"] == "A {curly} title"


def test_extract_json_object_raises_on_unparseable_content() -> None:
    with pytest.raises(json.JSONDecodeError):
        extract_json_object("no json here at all")


def test_compile_client_parses_fenced_json_into_compile_result(monkeypatch) -> None:
    content = (
        "```json\n"
        + json.dumps(
            {
                "pages": [
                    {"page_type": "concept", "title": "Foo", "tags": ["x"], "body": "See [[Bar]]."}
                ],
                "contradictions": ["note"],
            }
        )
        + "\n```"
    )

    def _fake_post(url, *, headers, json, timeout):  # noqa: ANN001
        return _FakeResponse(payload=_chat_payload(content))

    monkeypatch.setattr(httpx, "post", _fake_post)

    client = AuthHubCompileClient(base_url="http://localhost:3000", api_key="ak_x", model="deepseek-chat")
    result = client.compile(_compile_prompt())

    assert len(result.pages) == 1
    assert result.pages[0].title == "Foo"
    assert result.contradictions == ["note"]


def test_answer_client_parses_prose_wrapped_json_into_answer_result(monkeypatch) -> None:
    content = 'The answer is:\n\n{"answer": "It is X.", "citations": ["Some Page"]}\n\nDone.'

    def _fake_post(url, *, headers, json, timeout):  # noqa: ANN001
        return _FakeResponse(payload=_chat_payload(content))

    monkeypatch.setattr(httpx, "post", _fake_post)

    client = AuthHubAnswerClient(base_url="http://localhost:3000", api_key="ak_x", model="deepseek-chat")
    result = client.answer(_answer_prompt())

    assert result.text == "It is X."
    assert result.citations == ["Some Page"]


# --------------------------------------------------------------------------
# Retry then raise
# --------------------------------------------------------------------------


def test_compile_client_retries_then_raises_compile_error(monkeypatch) -> None:
    calls = {"count": 0}

    def _always_fail(url, *, headers, json, timeout):  # noqa: ANN001
        calls["count"] += 1
        return _FakeResponse(status_code=500)

    monkeypatch.setattr(httpx, "post", _always_fail)

    client = AuthHubCompileClient(
        base_url="http://localhost:3000", api_key="ak_x", model="deepseek-chat", max_retries=2
    )
    with pytest.raises(CompileError, match="AuthHub compile failed after retries"):
        client.compile(_compile_prompt())

    assert calls["count"] == 3  # max_retries + 1 attempts


def test_answer_client_retries_then_raises_answer_error_on_unparseable_content(monkeypatch) -> None:
    calls = {"count": 0}

    def _bad_json(url, *, headers, json, timeout):  # noqa: ANN001
        calls["count"] += 1
        return _FakeResponse(payload=_chat_payload("not json at all"))

    monkeypatch.setattr(httpx, "post", _bad_json)

    client = AuthHubAnswerClient(
        base_url="http://localhost:3000", api_key="ak_x", model="deepseek-chat", max_retries=1
    )
    with pytest.raises(AnswerError, match="AuthHub answer failed after retries"):
        client.answer(_answer_prompt())

    assert calls["count"] == 2  # max_retries + 1 attempts


def test_compile_client_succeeds_after_a_transient_failure(monkeypatch) -> None:
    calls = {"count": 0}

    success_content = json.dumps({"pages": [], "contradictions": []})

    def _fail_then_succeed(url, **kwargs: Any):
        calls["count"] += 1
        if calls["count"] == 1:
            return _FakeResponse(status_code=503)
        return _FakeResponse(payload=_chat_payload(success_content))

    monkeypatch.setattr(httpx, "post", _fail_then_succeed)

    client = AuthHubCompileClient(base_url="http://localhost:3000", api_key="ak_x", model="deepseek-chat")
    result = client.compile(_compile_prompt())

    assert result.pages == []
    assert calls["count"] == 2


# --------------------------------------------------------------------------
# Protocol conformance
# --------------------------------------------------------------------------


def test_authhub_clients_satisfy_the_protocols() -> None:
    compile_client = AuthHubCompileClient(base_url="http://localhost:3000", api_key="ak_x", model="m")
    answer_client = AuthHubAnswerClient(base_url="http://localhost:3000", api_key="ak_x", model="m")

    assert isinstance(compile_client, CompileClient)
    assert isinstance(answer_client, AnswerClient)


# --------------------------------------------------------------------------
# Missing httpx install hint
# --------------------------------------------------------------------------


def test_missing_httpx_raises_actionable_error(monkeypatch) -> None:
    import builtins

    real_import = builtins.__import__

    def _blocked_import(name, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if name == "httpx":
            raise ImportError("no module named httpx")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _blocked_import)

    client = AuthHubCompileClient(base_url="http://localhost:3000", api_key="ak_x", model="m")
    with pytest.raises(CompileError, match="pip install"):
        client.compile(_compile_prompt())
