"""The injectable compile client (Phase 3).

``CompileClient`` is a small ``Protocol`` — anything with a matching
``compile(prompt) -> CompileResult`` method satisfies it. Two implementations
ship here:

* :class:`FakeCompileClient` — returns a canned, deterministic
  :class:`~mythic_proportion.compile.models.CompileResult`. Used by every
  test in this package; never touches the network.
* :class:`AnthropicCompileClient` — the real thing. It **lazy-imports**
  ``anthropic`` only inside ``__init__``/``compile``, exactly like the
  Docling/MarkItDown adapters in Phase 2, so importing this module (or the
  whole ``mythic_proportion`` package) never requires ``anthropic`` to be
  installed.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol, runtime_checkable

from mythic_proportion.compile.models import CompileError, CompileResult, WikiPage, default_page_path
from mythic_proportion.compile.prompt import CompilePrompt

_INSTALL_HINT = "pip install 'mythic-proportion[llm]'"

#: The tool schema the real client asks Claude to answer through — a
#: structured, machine-parseable output contract rather than free-form prose.
EMIT_WIKI_PAGES_TOOL: dict[str, Any] = {
    "name": "emit_wiki_pages",
    "description": "Emit the compiled set of wiki pages and any contradiction notes.",
    "input_schema": {
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
    },
}


@runtime_checkable
class CompileClient(Protocol):
    """Anything that can turn a :class:`CompilePrompt` into a :class:`CompileResult`."""

    def compile(self, prompt: CompilePrompt) -> CompileResult: ...


class FakeCompileClient:
    """A deterministic, network-free stand-in for tests.

    ``fixture`` is either a fixed :class:`CompileResult` (returned, deep
    copied, on every call) or a callable that receives the
    :class:`CompilePrompt` and returns a :class:`CompileResult` — useful when
    a test wants the canned answer to react to ``existing_titles``.
    """

    def __init__(self, fixture: CompileResult | Callable[[CompilePrompt], CompileResult]) -> None:
        self._fixture = fixture
        self.calls: list[CompilePrompt] = []

    def compile(self, prompt: CompilePrompt) -> CompileResult:
        self.calls.append(prompt)
        if callable(self._fixture):
            return self._fixture(prompt)
        return self._fixture.model_copy(deep=True)


def _parse_tool_input(data: dict[str, Any]) -> CompileResult:
    pages = []
    for raw_page in data.get("pages", []):
        page_type = raw_page["page_type"]
        title = raw_page["title"]
        pages.append(
            WikiPage(
                path=default_page_path(page_type, title),
                page_type=page_type,
                title=title,
                frontmatter={"tags": raw_page.get("tags", [])},
                body=raw_page.get("body", ""),
            )
        )
    return CompileResult(pages=pages, contradictions=list(data.get("contradictions", [])))


class AnthropicCompileClient:
    """Real Claude-backed compile client. Never imported/instantiated unless

    egress is allowed and an API key is configured — see
    ``pipeline.compile_source``.
    """

    def __init__(
        self,
        *,
        model: str,
        api_key: str | None = None,
        max_tokens: int = 4096,
        max_retries: int = 2,
    ) -> None:
        self._model = model
        self._api_key = api_key
        self._max_tokens = max_tokens
        self._max_retries = max_retries
        self._client: Any | None = None

    def _ensure_client(self) -> Any:
        if self._client is None:
            try:
                import anthropic  # noqa: F401  (imported for its side effect: availability check)
            except ImportError as exc:  # pragma: no cover - exercised only when anthropic absent
                raise CompileError(_INSTALL_HINT) from exc
            from anthropic import Anthropic  # type: ignore[import-not-found]

            self._client = Anthropic(api_key=self._api_key) if self._api_key else Anthropic()
        return self._client

    def compile(self, prompt: CompilePrompt) -> CompileResult:
        client = self._ensure_client()

        last_exc: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                response = client.messages.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    system=prompt.system,
                    messages=[{"role": "user", "content": prompt.user}],
                    tools=[EMIT_WIKI_PAGES_TOOL],
                    tool_choice={"type": "tool", "name": "emit_wiki_pages"},
                )
                for block in getattr(response, "content", []):
                    if getattr(block, "type", None) == "tool_use":
                        return _parse_tool_input(dict(block.input))
                raise CompileError("Anthropic response contained no tool_use block")
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as CompileError below
                last_exc = exc
                continue

        raise CompileError(f"Anthropic compile failed after retries: {last_exc}") from last_exc
