"""Entity + relationship extraction over one text unit (Phase 3).

:func:`extract_entities_relationships` is the orchestrator: build the
delimited-tuple prompt (``tuples.build_extract_graph_prompt``), run it
through a read-through ``llm_cache`` (``cache.read_through_complete``),
parse the response (``tuples.parse_tuple_records``), attempt exactly one
repair round-trip if parsing yields nothing from non-empty output, then run
a bounded gleaning ("did I miss any?") recall loop. Persistent per-chunk
failure never raises -- it degrades to an empty result so
:mod:`mythic_proportion.graph.index` can skip that one chunk and keep going
(skip-a-chunk-not-abort, per the brief).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from mythic_proportion.graph.cache import LlmCache, read_through_complete
from mythic_proportion.graph.tuples import (
    COMPLETION_DELIM,
    build_extract_graph_prompt,
    build_gleaning_prompt,
    build_repair_prompt,
    normalize_entity_type,
    normalize_title,
    parse_tuple_records,
)

_INSTALL_HINT = "pip install 'mythic-proportion[authhub]'"


class ExtractionError(Exception):
    """Raised by a real extraction client on an unrecoverable transport/HTTP error."""


@dataclass
class ExtractedEntity:
    title: str
    type: str
    description: str


@dataclass
class ExtractedRelationship:
    source: str
    target: str
    description: str
    weight: float


@runtime_checkable
class ExtractionClient(Protocol):
    """Anything that can turn a (system, user) prompt pair into raw completion text."""

    def complete(self, *, system: str, user: str) -> str: ...


class FakeExtractionClient:
    """Deterministic, network-free extraction client -- every test in this
    package uses this, never a real provider.

    ``fixture`` may be:

    * a fixed string, returned on every call;
    * a list of strings, consumed one per call (the last is repeated once exhausted);
    * a callable ``(system, user, call_index) -> str`` for content-aware fixtures.
    """

    def __init__(self, fixture: str | list[str] | object) -> None:
        self._fixture = fixture
        self.calls: list[tuple[str, str]] = []

    def complete(self, *, system: str, user: str) -> str:
        idx = len(self.calls)
        self.calls.append((system, user))
        if callable(self._fixture):
            return self._fixture(system, user, idx)  # type: ignore[misc]
        if isinstance(self._fixture, list):
            if not self._fixture:
                return COMPLETION_DELIM
            return self._fixture[min(idx, len(self._fixture) - 1)]
        return str(self._fixture)


class AuthHubExtractionClient:
    """Real AuthHub-gateway extraction client.

    Reuses the exact same HTTP plumbing as
    :class:`mythic_proportion.llm.authhub._AuthHubBase` (lazy ``httpx``
    import, retries, ``route_alias`` forwarding) but with an empty JSON
    directive, since extraction output is prompted delimited tuples, not
    JSON -- see ``tuples.build_extract_graph_prompt``/``build_claims_prompt``.
    Never imported/instantiated unless a caller explicitly builds one (the
    CLI's ``index-graph`` command), so importing this module never requires
    the optional ``authhub`` extra.
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
        from mythic_proportion.llm.authhub import _AuthHubBase

        class _Base(_AuthHubBase):
            def _error_type(self) -> type[Exception]:
                return ExtractionError

        self._base = _Base(
            base_url=base_url,
            api_key=api_key,
            model=model,
            route_alias=route_alias,
            max_tokens=max_tokens,
            max_retries=max_retries,
            timeout=timeout,
        )

    def complete(self, *, system: str, user: str) -> str:
        last_exc: Exception | None = None
        for _attempt in range(self._base._max_retries + 1):  # noqa: SLF001 - same-module-family access
            try:
                return self._base._post_once(system=system, user=user, json_directive="")  # noqa: SLF001
            except Exception as exc:  # noqa: BLE001 - retried; re-raised as ExtractionError below
                last_exc = exc
                continue
        raise ExtractionError(f"AuthHub extraction failed after retries: {last_exc}") from last_exc


class _RawCaller:
    """Adapts a :class:`~mythic_proportion.privacy.redact.RedactingExtractionClient`'s
    ``.complete_raw()`` into the plain :class:`ExtractionClient` ``.complete()``
    shape, so :func:`~mythic_proportion.graph.cache.read_through_complete` can
    call it uniformly on a cache miss without knowing about redaction at all.
    ``user`` passed in here must already be redacted (see
    :func:`_cached_turn_call`) -- this wrapper performs NO redaction itself.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def complete(self, *, system: str, user: str) -> str:
        return self._inner.complete_raw(system=system, user=user)


def _start_turn(client: ExtractionClient) -> tuple[ExtractionClient, dict[str, str]]:
    """Start one multi-round extraction turn. Returns ``(client, turn_map)``
    unchanged/empty respectively -- ``client`` is returned as-is (no
    wrapping); every call within the turn instead goes through
    :func:`_cached_turn_call`, which redacts explicitly. Kept as a tiny
    named entry point (rather than inlining ``{}``) purely so call sites
    read the same as before this fix."""
    return client, {}


def _finish_turn(client: ExtractionClient, text: str, turn_map: dict[str, str]) -> str:
    """Rehydrate ``text`` using ``turn_map`` -- the ONE point in an
    extraction turn where redacted text is allowed to become real PII again.
    Call this per final field (entity title/description, relationship
    description, claim description, ...) after all repair/gleaning rounds
    are done and the response has been parsed into records -- never on raw
    completion text that might still get spliced into another prompt. A
    no-op (returns ``text`` unchanged) for a non-redacting client or an
    empty ``turn_map``.
    """
    from mythic_proportion.privacy.redact import RedactingExtractionClient

    if not turn_map or not isinstance(client, RedactingExtractionClient):
        return text
    return client.rehydrate_turn(text, turn_map)


def _cached_turn_call(
    client: ExtractionClient,
    cache: LlmCache,
    turn_map: dict[str, str],
    *,
    system: str,
    user: str,
    model: str,
) -> tuple[str, bool]:
    """One cached completion call within a turn-scoped extraction turn.

    Redaction happens FIRST, locally, unconditionally (no network call) --
    merging any newly-found PII spans into the shared ``turn_map`` -- and
    the llm_cache lookup/store is keyed on the REDACTED text, not the raw
    text. This is deliberately different from a naive "cache wraps
    complete_turn()" design: it fixes a Reflexion-retry-flagged defect where
    a cache HIT skipped the client call entirely, so ``turn_map`` never got
    populated and any ``[REDACTED_*]`` token already baked into the cached
    response could never be rehydrated, surviving all the way into a
    persisted entity/relationship/claim record.

    Because :meth:`~mythic_proportion.privacy.redact.RedactingExtractionClient.redact_for_turn`
    is a deterministic, purely-local function of its input text, calling it
    again for the exact same ``user`` text on a cache HIT reproduces the
    identical redacted text/map that produced the already-cached response --
    so ``turn_map`` ends up correctly populated whether this call is a hit
    or a miss, and the cached response (redacted-space text) is exactly what
    a follow-up round's prompt should splice in, no re-redaction needed.

    For a non-redacting ``client`` this degenerates to the original
    behavior: ``user`` passes through unchanged, ``turn_map`` stays empty,
    and this is exactly ``read_through_complete(client, cache, ...)``.
    """
    from mythic_proportion.privacy.redact import RedactingExtractionClient

    if isinstance(client, RedactingExtractionClient):
        redacted_user = client.redact_for_turn(user, turn_map)
        return read_through_complete(_RawCaller(client), cache, system=system, user=redacted_user, model=model)
    return read_through_complete(client, cache, system=system, user=user, model=model)


def _parse_with_one_repair(
    raw_text: str,
    *,
    client: ExtractionClient,
    cache: LlmCache,
    model: str,
    turn_map: dict[str, str],
) -> tuple[list[list[str]], int]:
    """Parse ``raw_text``; on a parse failure (non-empty input, zero records
    out), attempt exactly one repair round-trip, then give up (empty list,
    never raises). Returns ``(records, llm_calls_made)``."""
    records = parse_tuple_records(raw_text)
    if records or not raw_text.strip():
        return records, 0

    repair_user = build_repair_prompt(raw_text)
    repaired, hit = _cached_turn_call(
        client,
        cache,
        turn_map,
        system="Repair malformed delimited-tuple output. Output only the corrected tuples.",
        user=repair_user,
        model=model,
    )
    return parse_tuple_records(repaired), (0 if hit else 1)


def extract_entities_relationships(
    text: str,
    *,
    client: ExtractionClient,
    cache: LlmCache,
    model: str = "mock",
    max_gleanings: int = 1,
) -> tuple[list[ExtractedEntity], list[ExtractedRelationship], int]:
    """Extract entities/relationships from one text unit.

    Returns ``(entities, relationships, llm_calls)`` where ``llm_calls``
    counts only cache *misses* -- i.e. actual ``client.complete``
    invocations -- so callers/tests can assert idempotency: re-running this
    with an unchanged cache (same text/model) makes zero calls.
    """
    system, user = build_extract_graph_prompt(text)
    llm_calls = 0

    # Turn-scoped redaction (closes a PII cloud-egress leak -- see
    # `RedactingExtractionClient`'s docstring / `_start_turn`/`_finish_turn`
    # above): every completion made via `_cached_turn_call` for the rest of
    # this function stays in redacted-text space, no matter how many
    # repair/gleaning rounds it takes, and -- per the cache-boundary fix --
    # `turn_map` gets populated on a cache HIT exactly as it would on a
    # cache MISS. Real PII is only reconstituted once, per final field, at
    # the very end via `_finish_turn`.
    call_client, turn_map = _start_turn(client)

    response, hit = _cached_turn_call(call_client, cache, turn_map, system=system, user=user, model=model)
    if not hit:
        llm_calls += 1

    all_records, repair_calls = _parse_with_one_repair(
        response, client=call_client, cache=cache, model=model, turn_map=turn_map
    )
    llm_calls += repair_calls

    running_transcript = response
    for _ in range(max_gleanings):
        glean_user = f"{user}\n\n---\nYour previous output:\n{running_transcript}\n\n{build_gleaning_prompt()}"
        glean_response, glean_hit = _cached_turn_call(
            call_client, cache, turn_map, system=system, user=glean_user, model=model
        )
        if not glean_hit:
            llm_calls += 1

        stripped = glean_response.strip()
        if not stripped or stripped == COMPLETION_DELIM:
            break

        glean_records, glean_repair_calls = _parse_with_one_repair(
            glean_response, client=call_client, cache=cache, model=model, turn_map=turn_map
        )
        llm_calls += glean_repair_calls
        if not glean_records:
            break
        all_records.extend(glean_records)
        running_transcript = glean_response

    entities: list[ExtractedEntity] = []
    relationships: list[ExtractedRelationship] = []
    seen_entities: set[tuple[str, str]] = set()

    for fields in all_records:
        kind = fields[0].lower()
        if kind == "entity" and len(fields) >= 4:
            title = normalize_title(_finish_turn(client, fields[1], turn_map))
            if not title:
                continue
            entity_type = normalize_entity_type(fields[2])
            key = (title, entity_type)
            if key in seen_entities:
                continue
            seen_entities.add(key)
            description = _finish_turn(client, fields[3], turn_map)
            entities.append(ExtractedEntity(title=title, type=entity_type, description=description))
        elif kind == "relationship" and len(fields) >= 4:
            source = normalize_title(_finish_turn(client, fields[1], turn_map))
            target = normalize_title(_finish_turn(client, fields[2], turn_map))
            if not source or not target:
                continue
            description = _finish_turn(client, fields[3], turn_map)
            weight = 1.0
            if len(fields) >= 5:
                try:
                    weight = float(fields[4])
                except ValueError:
                    weight = 1.0
            relationships.append(
                ExtractedRelationship(source=source, target=target, description=description, weight=weight)
            )

    return entities, relationships, llm_calls
