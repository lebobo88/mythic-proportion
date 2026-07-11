"""The AuthHub-gateway LLM client (real, provider-generic).

AuthHub is an OpenAI-compatible multi-provider proxy: one HTTP contract
(``POST {base_url}/api/v1/ai/chat/completions``) in front of many backend
model providers (defaulting, in this project, to a DeepSeek model). This
module provides two small classes -- :class:`AuthHubCompileClient` and
:class:`AuthHubAnswerClient` -- that satisfy
:class:`~mythic_proportion.compile.client.CompileClient` and
:class:`~mythic_proportion.query.client.AnswerClient` respectively, exactly
like :class:`~mythic_proportion.compile.client.AnthropicCompileClient` and
:class:`~mythic_proportion.query.client.AnthropicAnswerClient` do for the
Anthropic provider.

The AuthHub chat-completions endpoint has **no** ``tools``/``tool_choice``/
``response_format`` request option, so structured output can't be obtained
via tool-use the way the Anthropic clients do it. Instead, both clients
append a strict-JSON instruction to the system prompt asking the model to
reply with exactly one JSON object matching the same schema the Anthropic
clients' tool inputs use, then parse ``choices[0].message.content`` back into
that shape -- reusing the exact same ``_parse_tool_input`` helpers the
Anthropic clients rely on, so the two providers can never drift on output
shape.

``httpx`` is **lazy-imported** inside ``_ensure_httpx``, exactly like
``anthropic`` is lazy-imported in ``compile/client.py``/``query/client.py``,
so importing this module never requires the optional ``authhub`` extra to be
installed.
"""

from __future__ import annotations

import json
import re
from typing import Any

from mythic_proportion.compile.client import _parse_tool_input as _parse_compile_input
from mythic_proportion.compile.models import CompileError, CompileResult
from mythic_proportion.compile.prompt import CompilePrompt
from mythic_proportion.query.client import AnswerError, AnswerResult
from mythic_proportion.query.client import _parse_tool_input as _parse_answer_input
from mythic_proportion.query.prompt import AnswerPrompt

_INSTALL_HINT = "pip install 'mythic-proportion[authhub]'"

_CHAT_COMPLETIONS_PATH = "/api/v1/ai/chat/completions"

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)

_COMPILE_JSON_DIRECTIVE = (
    "\n\nRespond with EXACTLY ONE JSON object and nothing else -- no prose, "
    "no markdown code fences, no explanation before or after it. The object "
    "must match this shape exactly:\n"
    '{"pages": [{"page_type": "source|entity|concept|session", "title": '
    '"<title>", "tags": ["<tag>", ...], "body": "<markdown body>"}], '
    '"contradictions": ["<note>", ...]}'
)

_ANSWER_JSON_DIRECTIVE = (
    "\n\nRespond with EXACTLY ONE JSON object and nothing else -- no prose, "
    "no markdown code fences, no explanation before or after it. The object "
    "must match this shape exactly:\n"
    '{"answer": "<answer text, may include [[wikilink]] citations>", '
    '"citations": ["<page title>", ...]}'
)


def extract_json_object(content: str) -> dict[str, Any]:
    """Best-effort recovery of a single JSON object from ``content``.

    Handles three shapes a chat model commonly returns despite being told to
    emit raw JSON: a bare JSON object, one wrapped in a ```json ... ``` (or
    plain ``` ... ```) fence, and one surrounded by extra prose (in which
    case the first balanced ``{...}`` span is extracted). Raises
    ``json.JSONDecodeError`` if nothing in ``content`` parses as JSON.
    """
    text = content.strip()

    fence_match = _JSON_FENCE_RE.search(text)
    if fence_match:
        text = fence_match.group(1).strip()

    try:
        result: Any = json.loads(text)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    if start == -1:
        raise json.JSONDecodeError("no '{' found in content", text, 0)

    depth = 0
    in_string = False
    escape = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start : idx + 1]
                parsed: Any = json.loads(candidate)
                if isinstance(parsed, dict):
                    return parsed
                raise json.JSONDecodeError("balanced object did not decode to a dict", text, start)

    raise json.JSONDecodeError("no balanced '{...}' object found in content", text, start)


class _AuthHubBase:
    """Shared HTTP plumbing for the AuthHub compile/answer clients."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        route_alias: str | None = None,
        max_tokens: int,
        max_retries: int = 2,
        timeout: float = 60.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._route_alias = route_alias
        self._max_tokens = max_tokens
        self._max_retries = max_retries
        self._timeout = timeout
        self._httpx: Any | None = None

    def _error_type(self) -> type[Exception]:  # pragma: no cover - overridden by subclasses
        raise NotImplementedError

    def _ensure_httpx(self) -> Any:
        if self._httpx is None:
            try:
                import httpx  # noqa: F401  (imported for its side effect: availability check)
            except ImportError as exc:  # pragma: no cover - exercised only when httpx absent
                raise self._error_type()(_INSTALL_HINT) from exc
            import httpx as _httpx

            self._httpx = _httpx
        return self._httpx

    def _post_once(self, *, system: str, user: str, json_directive: str) -> str:
        """One HTTP round trip; raises on any transport/HTTP/JSON-shape error."""
        httpx = self._ensure_httpx()

        url = f"{self._base_url}{_CHAT_COMPLETIONS_PATH}"
        headers = {"X-API-Key": self._api_key, "Content-Type": "application/json"}
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system + json_directive},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
            "max_tokens": self._max_tokens,
        }
        if self._route_alias:
            body["route_alias"] = self._route_alias

        response = httpx.post(url, headers=headers, json=body, timeout=self._timeout)
        response.raise_for_status()
        data = response.json()
        return str(data["choices"][0]["message"]["content"])


class AuthHubCompileClient(_AuthHubBase):
    """AuthHub-gateway ``CompileClient`` -- structured output via prompted JSON.

    Satisfies :class:`~mythic_proportion.compile.client.CompileClient`.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        route_alias: str | None = None,
        max_tokens: int = 4096,
        max_retries: int = 2,
        timeout: float = 60.0,
    ) -> None:
        super().__init__(
            base_url=base_url,
            api_key=api_key,
            model=model,
            route_alias=route_alias,
            max_tokens=max_tokens,
            max_retries=max_retries,
            timeout=timeout,
        )

    def _error_type(self) -> type[Exception]:
        return CompileError

    def compile(self, prompt: CompilePrompt) -> CompileResult:
        last_exc: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                content = self._post_once(
                    system=prompt.system, user=prompt.user, json_directive=_COMPILE_JSON_DIRECTIVE
                )
                data = extract_json_object(content)
                return _parse_compile_input(data)
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as CompileError below
                last_exc = exc
                continue

        raise CompileError(f"AuthHub compile failed after retries: {last_exc}") from last_exc


class AuthHubAnswerClient(_AuthHubBase):
    """AuthHub-gateway ``AnswerClient`` -- structured output via prompted JSON.

    Satisfies :class:`~mythic_proportion.query.client.AnswerClient`; mirrors
    :class:`AuthHubCompileClient` exactly (see the module docstring).
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        route_alias: str | None = None,
        max_tokens: int = 2048,
        max_retries: int = 2,
        timeout: float = 60.0,
    ) -> None:
        super().__init__(
            base_url=base_url,
            api_key=api_key,
            model=model,
            route_alias=route_alias,
            max_tokens=max_tokens,
            max_retries=max_retries,
            timeout=timeout,
        )

    def _error_type(self) -> type[Exception]:
        return AnswerError

    def answer(self, prompt: AnswerPrompt) -> AnswerResult:
        last_exc: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                content = self._post_once(
                    system=prompt.system, user=prompt.user, json_directive=_ANSWER_JSON_DIRECTIVE
                )
                data = extract_json_object(content)
                return _parse_answer_input(data)
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as AnswerError below
                last_exc = exc
                continue

        raise AnswerError(f"AuthHub answer failed after retries: {last_exc}") from last_exc
