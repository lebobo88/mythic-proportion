"""A fully-local Ollama LLM client (Phase 6).

Targets a local Ollama daemon's OpenAI-compatible-style HTTP surface at
``http://localhost:11434`` by default. Structured JSON output (for the
compile/answer clients, which need a specific JSON shape back) uses Ollama's
native **structured-outputs** feature -- passing a JSON Schema as the
request's ``format`` field -- rather than prompted-JSON-and-hope, exactly
like ``ai_docs``/the Phase 6 spec calls for: "guaranteed-valid extraction
JSON" via ``format=<JSON Schema>``, not best-effort parsing.

Recommended model: **Qwen2.5-7B-Instruct** (``qwen2.5:7b-instruct`` in the
Ollama model registry) -- trained for structured output, ~4.7GB at Q4_K_M,
CPU/consumer-GPU friendly. ``Settings.ollama_model`` defaults to it.

Three client classes ship here, mirroring ``llm/authhub.py``'s shape exactly:

* :class:`OllamaCompileClient` -- satisfies
  :class:`~mythic_proportion.compile.client.CompileClient`.
* :class:`OllamaAnswerClient` -- satisfies
  :class:`~mythic_proportion.query.client.AnswerClient`.
* :class:`OllamaExtractionClient` -- satisfies
  :class:`~mythic_proportion.graph.extract.ExtractionClient` (plain-text
  completion, no ``format`` schema -- GraphRAG extraction output is
  delimited tuples, not JSON, exactly like ``AuthHubExtractionClient``).

``httpx`` is lazy-imported inside ``_ensure_httpx`` (never at module scope),
so importing this module never requires the optional ``[local]`` extra.
This is a real, working integration: every request/response code path below
executes against an actual HTTP call -- only the transport itself is mocked
in tests that can't assume a live Ollama daemon is reachable in CI.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from mythic_proportion.compile.client import _parse_tool_input as _parse_compile_input
from mythic_proportion.compile.models import CompileError, CompileResult
from mythic_proportion.compile.prompt import CompilePrompt
from mythic_proportion.graph.extract import ExtractionError
from mythic_proportion.llm.authhub import extract_json_object
from mythic_proportion.query.client import AnswerError, AnswerResult
from mythic_proportion.query.client import _parse_tool_input as _parse_answer_input
from mythic_proportion.query.prompt import AnswerPrompt

_INSTALL_HINT = "pip install 'mythic-proportion[local]'"

DEFAULT_BASE_URL = "http://localhost:11434"
DEFAULT_MODEL = "qwen2.5:7b-instruct"

_CHAT_PATH = "/api/chat"
_TAGS_PATH = "/api/tags"

#: JSON Schema for the compile step's structured output -- the exact shape
#: ``compile.client._parse_tool_input`` already knows how to consume.
COMPILE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "pages": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "page_type": {
                        "type": "string",
                        "enum": ["source", "entity", "concept", "session"],
                    },
                    "title": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "body": {"type": "string"},
                },
                "required": ["page_type", "title", "body"],
            },
        },
        "contradictions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["pages"],
}

#: JSON Schema for the answer step's structured output -- the exact shape
#: ``query.client._parse_tool_input`` already knows how to consume.
ANSWER_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "citations": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["answer"],
}


#: Hostnames treated as "this machine" for the ``local: true`` "never touch
#: the cloud" guarantee. IPv6 loopback is normalized to ``::1`` by
#: ``urlparse().hostname`` regardless of whether the URL spells it
#: ``http://[::1]:11434`` or bare ``::1``.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


class OllamaConfigError(ValueError):
    """Raised when an Ollama-related configuration violates a safety
    invariant -- currently: a non-loopback ``ollama_base_url`` while
    ``Settings.local`` is ``True``. Closes a prior review finding where
    ``local: true`` with a remote URL could egress prompts off-host."""


def is_loopback_url(url: str) -> bool:
    """True if ``url``'s host is a loopback address (``localhost``/
    ``127.0.0.1``/``::1``). Never raises: an unparseable/empty ``url``
    simply isn't loopback."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in _LOOPBACK_HOSTS


def require_loopback_url(url: str, *, context: str = "local mode") -> None:
    """Raise :class:`OllamaConfigError` if ``url`` is not loopback-only.

    Enforced at **both** of the two places a non-loopback URL could sneak
    in under ``local: true``: config-set time
    (``web.app``'s ``POST /api/config``) and client-construction time
    (``compile.pipeline``/``query.engine``'s ``_default_client`` factories,
    right before an ``Ollama*Client`` is actually built).
    """
    if not is_loopback_url(url):
        raise OllamaConfigError(
            f"{context} requires ollama_base_url to be loopback-only "
            f"(localhost/127.0.0.1/::1), got {url!r} -- refusing to let a "
            "local-mode vault egress prompts to a non-local host"
        )


def is_ollama_reachable(base_url: str = DEFAULT_BASE_URL, *, timeout: float = 1.0) -> bool:
    """Best-effort local reachability probe (``GET {base_url}/api/tags``).

    Never raises: any transport error (daemon not running, no ``httpx``
    installed, etc.) is treated as "not reachable". Used by callers/tests
    that want to opportunistically live-smoke-check Ollama without making it
    a hard requirement.
    """
    try:
        import httpx
    except ImportError:
        return False
    try:
        response = httpx.get(f"{base_url.rstrip('/')}{_TAGS_PATH}", timeout=timeout)
        return response.status_code == 200
    except Exception:  # noqa: BLE001 - any transport failure means "not reachable"
        return False


class _OllamaBase:
    """Shared HTTP plumbing for the Ollama compile/answer/extraction clients."""

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        max_tokens: int = 4096,
        max_retries: int = 2,
        timeout: float = 120.0,
    ) -> None:
        # Defense-in-depth: every Ollama* client is, by definition, "the
        # fully-local provider" -- refuse to even construct one against a
        # non-loopback host, on top of the caller-side `require_loopback_url`
        # checks in `compile.pipeline`/`query.engine`/`cli.app` (which guard
        # `settings.local` specifically). This closes the gap for the
        # `llm_provider="ollama"` (non-`local`) path too.
        require_loopback_url(base_url, context="OllamaClient construction")
        self._base_url = base_url.rstrip("/")
        self._model = model
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

    def _post_once(
        self, *, system: str, user: str, json_schema: dict[str, Any] | None
    ) -> str:
        """One HTTP round trip against Ollama's ``/api/chat``; raises on any
        transport/HTTP/response-shape error."""
        httpx = self._ensure_httpx()

        url = f"{self._base_url}{_CHAT_PATH}"
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "options": {"temperature": 0.2, "num_predict": self._max_tokens},
        }
        if json_schema is not None:
            # Ollama's structured-outputs feature: a JSON Schema in `format`
            # constrains generation so the response is *mechanically*
            # guaranteed to be valid JSON matching this shape -- no
            # prompted-JSON-and-hope, no repair round-trip needed.
            body["format"] = json_schema

        response = httpx.post(url, json=body, timeout=self._timeout)
        response.raise_for_status()
        data = response.json()
        message = data.get("message") or {}
        content = message.get("content")
        if content is None:
            raise self._error_type()(f"Ollama response contained no message.content: {data!r}")
        return str(content)


class OllamaCompileClient(_OllamaBase):
    """Fully-local Ollama ``CompileClient`` -- structured output via
    Ollama's native JSON-Schema ``format``. Satisfies
    :class:`~mythic_proportion.compile.client.CompileClient`."""

    def _error_type(self) -> type[Exception]:
        return CompileError

    def compile(self, prompt: CompilePrompt) -> CompileResult:
        last_exc: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                content = self._post_once(
                    system=prompt.system, user=prompt.user, json_schema=COMPILE_JSON_SCHEMA
                )
                data = extract_json_object(content)
                return _parse_compile_input(data)
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as CompileError below
                last_exc = exc
                continue

        raise CompileError(f"Ollama compile failed after retries: {last_exc}") from last_exc


class OllamaAnswerClient(_OllamaBase):
    """Fully-local Ollama ``AnswerClient`` -- structured output via Ollama's
    native JSON-Schema ``format``. Satisfies
    :class:`~mythic_proportion.query.client.AnswerClient`."""

    def _error_type(self) -> type[Exception]:
        return AnswerError

    def answer(self, prompt: AnswerPrompt) -> AnswerResult:
        last_exc: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                content = self._post_once(
                    system=prompt.system, user=prompt.user, json_schema=ANSWER_JSON_SCHEMA
                )
                data = extract_json_object(content)
                return _parse_answer_input(data)
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as AnswerError below
                last_exc = exc
                continue

        raise AnswerError(f"Ollama answer failed after retries: {last_exc}") from last_exc


class OllamaExtractionClient(_OllamaBase):
    """Fully-local Ollama GraphRAG extraction client -- plain-text
    completion, no ``format`` schema (extraction output is delimited
    tuples, not JSON -- see ``graph.tuples``). Satisfies
    :class:`~mythic_proportion.graph.extract.ExtractionClient`."""

    def _error_type(self) -> type[Exception]:
        return ExtractionError

    def complete(self, *, system: str, user: str) -> str:
        last_exc: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                return self._post_once(system=system, user=user, json_schema=None)
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as ExtractionError below
                last_exc = exc
                continue

        raise ExtractionError(f"Ollama extraction failed after retries: {last_exc}") from last_exc
