"""The injectable query-answer client (Phase 5).

Mirrors ``compile/client.py``'s shape exactly: ``AnswerClient`` is a small
``Protocol`` — anything with a matching ``answer(prompt) -> AnswerResult``
method satisfies it. Two implementations ship here:

* :class:`FakeAnswerClient` — returns a canned, deterministic
  :class:`AnswerResult`. Used by tests; never touches the network.
* :class:`AnthropicAnswerClient` — the real thing. It **lazy-imports**
  ``anthropic`` only inside ``__init__``/``answer``, exactly like
  ``AnthropicCompileClient``, so importing this module never requires
  ``anthropic`` to be installed.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from mythic_proportion.query.prompt import AnswerPrompt

_INSTALL_HINT = "pip install 'mythic-proportion[llm]'"

#: The tool schema the real client asks Claude to answer through — a
#: structured, machine-parseable output contract rather than free-form prose.
EMIT_ANSWER_TOOL: dict[str, Any] = {
    "name": "emit_answer",
    "description": "Emit the synthesized answer to the user's question, citing pages by title.",
    "input_schema": {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "citations": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["answer"],
    },
}


@dataclass
class AnswerResult:
    """The outcome of one answer call (fake or real)."""

    text: str
    citations: list[str] = field(default_factory=list)


class AnswerError(Exception):
    """Raised when a real answer call fails after retries.

    ``query.engine.answer_query`` always catches this (and any other
    exception from a client) and falls back to a deterministic ranked-pages
    answer — it should never propagate out of the query path.
    """


@runtime_checkable
class AnswerClient(Protocol):
    """Anything that can turn an :class:`AnswerPrompt` into an :class:`AnswerResult`."""

    def answer(self, prompt: AnswerPrompt) -> AnswerResult: ...


class FakeAnswerClient:
    """A deterministic, network-free stand-in for tests.

    ``fixture`` is either a fixed :class:`AnswerResult` (returned on every
    call) or a callable that receives the :class:`AnswerPrompt` and returns
    an :class:`AnswerResult` — useful when a test wants the canned answer to
    react to which pages were retrieved.
    """

    def __init__(self, fixture: AnswerResult | Callable[[AnswerPrompt], AnswerResult]) -> None:
        self._fixture = fixture
        self.calls: list[AnswerPrompt] = []

    def answer(self, prompt: AnswerPrompt) -> AnswerResult:
        self.calls.append(prompt)
        if callable(self._fixture):
            return self._fixture(prompt)
        return AnswerResult(text=self._fixture.text, citations=list(self._fixture.citations))


def _parse_tool_input(data: dict[str, Any]) -> AnswerResult:
    return AnswerResult(text=str(data.get("answer", "")), citations=list(data.get("citations", [])))


class AnthropicAnswerClient:
    """Real Claude-backed answer client. Never imported/instantiated unless

    egress is allowed and an API key is configured — see
    ``query.engine.answer_query``.
    """

    def __init__(
        self,
        *,
        model: str,
        api_key: str | None = None,
        max_tokens: int = 2048,
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
                raise AnswerError(_INSTALL_HINT) from exc
            from anthropic import Anthropic  # type: ignore[import-not-found]

            self._client = Anthropic(api_key=self._api_key) if self._api_key else Anthropic()
        return self._client

    def answer(self, prompt: AnswerPrompt) -> AnswerResult:
        client = self._ensure_client()

        last_exc: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                response = client.messages.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    system=prompt.system,
                    messages=[{"role": "user", "content": prompt.user}],
                    tools=[EMIT_ANSWER_TOOL],
                    tool_choice={"type": "tool", "name": "emit_answer"},
                )
                for block in getattr(response, "content", []):
                    if getattr(block, "type", None) == "tool_use":
                        return _parse_tool_input(dict(block.input))
                raise AnswerError("Anthropic response contained no tool_use block")
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as AnswerError below
                last_exc = exc
                continue

        raise AnswerError(f"Anthropic answer failed after retries: {last_exc}") from last_exc
