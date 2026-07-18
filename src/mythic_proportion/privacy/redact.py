"""Local PII redaction/rehydration around the LLM provider layer (Phase 6).

Design (see ``specs/ROADMAP-BRIEF.md`` §6.1 / the Phase 6 spec section):

* **Microsoft Presidio** (``presidio-analyzer`` + ``presidio-anonymizer``,
  MIT) is the redaction *framework*: the :class:`~presidio_analyzer.AnalyzerEngine`
  finds PII spans, the :class:`~presidio_anonymizer.AnonymizerEngine` replaces
  them. The ``[privacy]`` extra pins both packages (see ``pyproject.toml``)
  and, by default, registers **two** custom recognizers alongside Presidio's
  own built-ins: :class:`SecretScanRecognizer` (regex-based, zero extra
  dependencies -- API keys/tokens/secrets) and, best-effort,
  :class:`OpenAIPrivacyFilterRecognizer`.
* The **OpenAI Privacy Filter** (Apache-2.0, ``openai/privacy-filter`` on
  Hugging Face) is wired in as a *custom Presidio recognizer*
  (:class:`OpenAIPrivacyFilterRecognizer`) rather than replacing Presidio's
  own recognizers -- it augments detection, it doesn't own the pipeline.
  **Honesty note (closing a prior review finding):** the base ``[privacy]``
  extra does **not** pull in ``torch``/``transformers`` (multi-GB, GPU-shaped
  dependencies inappropriate for a default install) -- the OpenAI Privacy
  Filter's token-classification model only actually loads when the separate,
  opt-in ``[privacy-full]`` extra (``pyproject.toml``, pinned) is installed
  *in addition to* ``[privacy]``. Without ``[privacy-full]``, redaction still
  runs for real via Presidio's own built-in recognizers plus
  :class:`SecretScanRecognizer` -- it just doesn't get the extra
  transformer-model coverage. This module never silently claims the OpenAI
  filter ran when it didn't; :func:`get_redactor`'s caller-facing contract
  only ever promises "PII was redacted" or "redaction is unavailable, fail
  closed" (see below), never a specific recognizer set.
* Redaction is **reversible**: each match is replaced with a unique,
  positional token (``[REDACTED_<ENTITY_TYPE>_<n>]``) built via Presidio's
  own ``AnonymizerEngine`` custom-operator callback (invoked once per match
  with the original matched substring), so the token -> original-text
  mapping (the "rehydrate map") is captured directly off Presidio's own
  anonymization pass rather than re-derived out-of-band.
* Both heavy dependencies (``presidio_analyzer``/``presidio_anonymizer`` and,
  for the OpenAI filter, ``torch``/``transformers``) are imported **lazily**,
  only inside :class:`Redactor.__init__`/:class:`OpenAIPrivacyFilterRecognizer.load`
  -- importing this module, or the whole ``mythic_proportion`` package, never
  requires the optional ``[privacy]`` extra to be installed.
* **Fail-closed contract (closing a prior review finding).** Every caller
  goes through :func:`get_redactor`, which now distinguishes two cases that
  used to be conflated:

  1. ``settings.redaction_enabled is False`` -- an *explicit user opt-out*.
     Returns ``None`` ("no redaction; pass content through unchanged"). This
     is the only case in which unredacted content is allowed to reach an LLM
     provider.
  2. ``settings.redaction_enabled is True`` but the ``[privacy]`` extra isn't
     installed (or fails to build for any other reason) -- redaction is
     *wanted* but *unavailable*. This now raises :class:`RedactionUnavailableError`
     instead of returning ``None``. Callers (``compile.pipeline``/
     ``query.engine``'s ``_maybe_redact*`` helpers) turn this into a
     :class:`~mythic_proportion.compile.models.CompileError`/
     :class:`~mythic_proportion.query.client.AnswerError`/
     :class:`~mythic_proportion.graph.extract.ExtractionError` *before* any
     LLM call is made -- the request never leaves the process, let alone the
     machine. Silent pass-through on missing extras was the exact defect a
     prior cross-vendor review flagged (raw PII could cross the local-to-cloud
     trust boundary silently); it is not reintroduced here.

  ``schema.md`` (the vault's page-type schema template) is deliberately
  *not* redacted: it is vault-structural configuration authored by the vault
  owner (page-type taxonomy, not per-source ingested content) and is treated
  as safe-by-construction, analogous to any other committed config file --
  only ``prompt.user`` (the actual ingested/queried content) is redacted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from mythic_proportion.config import Settings

_INSTALL_HINT = "pip install 'mythic-proportion[privacy]'"
_FULL_INSTALL_HINT = "pip install 'mythic-proportion[privacy,privacy-full]'"

#: Conservative max chunk length, in characters, fed to the OpenAI Privacy
#: Filter's ``transformers`` token-classification pipeline in a single call
#: (see :class:`OpenAIPrivacyFilterRecognizer`'s ``_Delegate.analyze``).
#:
#: **Why this fixes the OOM.** GraphRAG community-report generation
#: (``graph.reports.generate_community_reports``) can hand this recognizer
#: several-hundred-KB prompts once extraction reads full ``raw/`` source
#: documents (see commit b5ec6e1) rather than the old tiny ``wiki/``
#: summaries. Feeding that whole string into the HF pipeline in one call lets
#: the underlying transformer's attention-mask materialization
#: (``transformers/masking_utils.py``'s non-vmap ``sdpa_mask``/``eager_mask``
#: path) scale badly with sequence length, which is what produced the
#: observed ``CUDA out of memory. Tried to allocate 24.18 GiB`` crash on a
#: 12 GB GPU.
#:
#: **Why this value.** The model's own config
#: (``outer._pipeline.model.config.max_position_embeddings``) is the
#: authoritative token-length cap, but it is a *token* count, not a character
#: count, and isn't reliably present/introspectable across every
#: transformers backend/model revision without adding a hard dependency on
#: that attribute existing. Rather than risk an ``AttributeError`` on some
#: model variant, this is a hardcoded, conservative character budget instead:
#: ~2500 characters is comfortably under typical small token-classification
#: models' position-embedding limits (usually 512 tokens; English prose
#: averages ~4-5 characters/token, so 2500 chars is roughly 500-625 tokens
#: worst case, i.e. already at or near a 512-token ceiling by design -- the
#: conservative direction, favoring more/smaller chunks over risking another
#: OOM/truncation on a model with an even smaller limit).
_MAX_PIPELINE_CHUNK_CHARS = 2500


def _chunk_text_for_pipeline(text: str) -> list[tuple[int, str]]:
    """Split ``text`` into ``(start_offset, chunk)`` pairs, each chunk no
    longer than :data:`_MAX_PIPELINE_CHUNK_CHARS`, so callers can feed each
    chunk to the HF pipeline separately and remap the chunk-relative token
    offsets the pipeline returns back into ``text``'s own coordinate space
    (``start_offset + token_offset``).

    Fast path: text already at or under the limit returns a single
    ``(0, text)`` chunk -- byte-identical behavior (and thus identical
    ``RecognizerResult`` offsets) to the pre-chunking code for every input
    that previously worked fine, so no regression for normal-sized inputs.

    Splitting prefers whitespace boundaries close to (but not over) the
    limit, to avoid slicing through the middle of a word -- and, by
    extension, the middle of a short PII span. **Known limitation
    (deliberately not engineered further, see module docstring guidance):**
    if a PII entity happens to straddle a chunk boundary anyway, it may go
    undetected in the half of it visible to each side, or be detected with a
    boundary-truncated span. Names/emails/phone numbers are all short
    relative to a several-thousand-character chunk, so this is a
    low-probability edge case, not a systematic detection hole.
    """
    if len(text) <= _MAX_PIPELINE_CHUNK_CHARS:
        return [(0, text)]

    chunks: list[tuple[int, str]] = []
    pos = 0
    n = len(text)
    while pos < n:
        end = min(pos + _MAX_PIPELINE_CHUNK_CHARS, n)
        if end < n:
            # Prefer to back off to the nearest preceding whitespace run so
            # we don't split mid-word (and thus mid-entity). Only look back
            # within this chunk's own span, and only bother if we find
            # whitespace reasonably close to the hard limit -- otherwise
            # (e.g. one giant unbroken token) just hard-split at the limit.
            split_at = text.rfind(" ", pos, end)
            if split_at == -1:
                split_at = text.rfind("\n", pos, end)
            if split_at != -1 and split_at > pos:
                end = split_at + 1  # include the whitespace char in this chunk
        chunk = text[pos:end]
        if chunk:
            chunks.append((pos, chunk))
        pos = end
    return chunks


class RedactionUnavailableError(RuntimeError):
    """Raised by :func:`get_redactor` when redaction is *enabled* in
    settings but cannot actually be performed (the ``[privacy]`` extra isn't
    installed, or ``Redactor`` construction otherwise fails).

    This is deliberately a distinct exception from "redaction disabled"
    (which is a normal, non-error ``None`` return) -- callers must treat
    this as a hard failure and refuse to call any LLM provider with
    unredacted content, never silently degrade to pass-through.
    """

#: The eight PII categories the OpenAI Privacy Filter's token classifier
#: masks (see the Phase 6 spec section / ROADMAP-BRIEF §6.1). Used both as
#: the recognizer's declared ``supported_entities`` and to translate the
#: model's raw token-classification labels into Presidio entity names.
OPENAI_FILTER_ENTITIES: tuple[str, ...] = (
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "LOCATION",
    "URL",
    "DATE_TIME",
    "ACCOUNT",
    "SECRET",
)

#: Presidio's own built-in recognizers already cover a useful subset of
#: these under slightly different canonical names; this maps the OpenAI
#: Privacy Filter's raw label vocabulary onto Presidio-style entity names so
#: downstream code (token naming, allow-lists) never has to special-case the
#: filter's label spelling.
_OPENAI_LABEL_TO_ENTITY: dict[str, str] = {
    "PERSON": "PERSON",
    "EMAIL": "EMAIL_ADDRESS",
    "PHONE": "PHONE_NUMBER",
    "ADDRESS": "LOCATION",
    "URL": "URL",
    "DATE": "DATE_TIME",
    "ACCOUNT": "ACCOUNT",
    "SECRET": "SECRET",
}


@dataclass(frozen=True)
class PiiSpan:
    """A single detected-PII span, duck-type-compatible with Presidio's own
    ``RecognizerResult`` (``entity_type``/``start``/``end``/``score``) so
    :class:`Redactor` never has to import ``presidio_analyzer`` just to type
    a return value, and tests can build these directly without any heavy
    dependency installed."""

    entity_type: str
    start: int
    end: int
    score: float = 1.0


class OpenAIPrivacyFilterRecognizer:
    """A Presidio ``EntityRecognizer`` wrapping the ``openai/privacy-filter``
    token-classification model (Apache-2.0, ~1.5B total/50M active params,
    CPU/laptop-capable -- see the module docstring).

    Subclasses ``presidio_analyzer.EntityRecognizer`` lazily: the base class
    itself is only imported inside :meth:`__init__`, and the actual
    ``transformers`` pipeline (which pulls in ``torch``) is only built inside
    :meth:`load`, which Presidio's ``AnalyzerEngine`` calls once, lazily, the
    *first time this recognizer's* ``analyze`` *is needed* -- not at
    registration/construction time (see
    ``presidio_analyzer.AnalyzerEngine.analyze``: it calls
    ``recognizer.load()`` inline, inside the same per-recognizer loop that
    calls ``recognizer.analyze()``, with no surrounding ``try/except`` of its
    own).

    **Fail-open-on-this-recognizer-only, not fail-crash (fixes a prior
    review finding).** Because Presidio itself does not catch a failing
    ``load()``, an earlier version of this class raised ``RuntimeError``
    straight out of ``load()`` when ``torch``/``transformers`` (the opt-in
    ``[privacy-full]`` extra) were missing -- which meant the *first* call to
    :meth:`Redactor.redact` would crash the *entire* analysis pass (not just
    skip this one recognizer) the moment ``[privacy]`` was installed without
    ``[privacy-full]``, even though the module docstring's "honesty note"
    already promised that combination degrades gracefully to Presidio's
    builtins + :class:`SecretScanRecognizer`. ``load`` now instead marks
    itself unavailable and returns normally; ``analyze`` then short-circuits
    to an empty result list whenever the pipeline never came up, so a
    missing ``[privacy-full]`` costs this one recognizer's coverage, not the
    whole redaction pass.
    """

    def __init__(self, *, model_name: str = "openai/privacy-filter") -> None:
        try:
            from presidio_analyzer import EntityRecognizer  # noqa: F401
        except ImportError as exc:  # pragma: no cover - exercised only without presidio
            raise RuntimeError(f"OpenAIPrivacyFilterRecognizer requires presidio: {_INSTALL_HINT}") from exc

        self._model_name = model_name
        self._pipeline: Any | None = None
        #: True once :meth:`_Delegate.load` has tried and failed to import
        #: torch/transformers -- lets :meth:`_Delegate.analyze` short-circuit
        #: to "no results from this recognizer" instead of calling a
        #: ``None`` pipeline.
        self.model_unavailable: bool = False
        self._delegate = self._build_delegate()

    def _build_delegate(self) -> Any:
        from presidio_analyzer import EntityRecognizer

        model_name = self._model_name
        outer = self

        class _Delegate(EntityRecognizer):  # type: ignore[misc]
            def __init__(self) -> None:
                super().__init__(
                    supported_entities=list(OPENAI_FILTER_ENTITIES),
                    name="OpenAIPrivacyFilterRecognizer",
                )

            def load(self) -> None:
                if outer._pipeline is not None or outer.model_unavailable:
                    return
                try:
                    import torch  # noqa: F401
                    from transformers import pipeline
                except ImportError:
                    # [privacy-full] not installed -- degrade to "this
                    # recognizer finds nothing" rather than raising, so
                    # Presidio's outer analyze() loop (which does not
                    # protect recognizer.load() with its own try/except)
                    # does not crash the whole pass. Presidio's own
                    # built-ins + SecretScanRecognizer still run for real.
                    outer.model_unavailable = True
                    return
                try:
                    outer._pipeline = pipeline("token-classification", model=model_name)
                except Exception:
                    # Retry fix: `torch`/`transformers` being importable does
                    # not guarantee the model actually loads (e.g. no
                    # cached/downloadable weights in a sandboxed/offline
                    # environment -- exactly this dev environment's shape,
                    # since torch/transformers ARE installed here but the
                    # model may not be reachable). `EntityRecognizer.__init__`
                    # calls `load()` synchronously at construction time (see
                    # this class's docstring), so an uncaught failure here
                    # would crash *every* `Redactor()` construction, not just
                    # degrade this one recognizer -- deliberately broad
                    # ``except Exception`` (not just ``ImportError``) to
                    # cover HTTP/OSError/ValueError model-loading failures,
                    # not only missing-package failures.
                    outer.model_unavailable = True

            def analyze(self, text: str, entities: list[str], nlp_artifacts: Any = None) -> list[Any]:
                from presidio_analyzer import RecognizerResult

                if outer._pipeline is None and not outer.model_unavailable:
                    self.load()
                if outer._pipeline is None:
                    return []
                results: list[Any] = []
                for chunk_offset, chunk_text in _chunk_text_for_pipeline(text):
                    if not chunk_text:
                        continue
                    raw = outer._pipeline(chunk_text)  # type: ignore[misc]
                    for token in raw:
                        label = str(token.get("entity_group") or token.get("entity") or "").upper()
                        entity_type = _OPENAI_LABEL_TO_ENTITY.get(label)
                        if entity_type is None or (entities and entity_type not in entities):
                            continue
                        results.append(
                            RecognizerResult(
                                entity_type=entity_type,
                                # Remap chunk-relative offsets back into the
                                # ORIGINAL full-text coordinate space -- see
                                # _chunk_text_for_pipeline's docstring.
                                start=chunk_offset + int(token["start"]),
                                end=chunk_offset + int(token["end"]),
                                score=float(token.get("score", 0.9)),
                            )
                        )
                return results

        return _Delegate()

    # -- EntityRecognizer surface, delegated ------------------------------

    def load(self) -> None:
        self._delegate.load()

    def analyze(self, text: str, entities: list[str], nlp_artifacts: Any = None) -> list[Any]:
        return self._delegate.analyze(text, entities, nlp_artifacts)

    @property
    def presidio_recognizer(self) -> Any:
        """The real ``presidio_analyzer.EntityRecognizer`` instance to register
        with an ``AnalyzerEngine``'s ``RecognizerRegistry``."""
        return self._delegate


#: Regex patterns for common secret/credential formats -- deliberately
#: conservative (favors false negatives over false positives on ordinary
#: prose) and dependency-free, so it ships as a real, always-available part
#: of the base ``[privacy]`` extra rather than an aspirational claim gated
#: behind ``torch``/``transformers``. Closes the "no custom secret-scan
#: recognizer actually exists" review finding.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("OPENAI_API_KEY", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("AWS_ACCESS_KEY", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GITHUB_TOKEN", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("SLACK_TOKEN", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("GENERIC_BEARER_TOKEN", re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}\b")),
    ("PRIVATE_KEY_BLOCK", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
)


class SecretScanRecognizer:
    """A Presidio ``EntityRecognizer`` that finds API keys/tokens/secrets via
    regex -- no ``torch``/``transformers`` required, so it's part of the base
    ``[privacy]`` extra's real, always-shipped coverage (unlike
    :class:`OpenAIPrivacyFilterRecognizer`, which needs the additional
    opt-in ``[privacy-full]`` extra to actually load its model)."""

    def __init__(self) -> None:
        try:
            from presidio_analyzer import EntityRecognizer  # noqa: F401
        except ImportError as exc:  # pragma: no cover - exercised only without presidio
            raise RuntimeError(f"SecretScanRecognizer requires presidio: {_INSTALL_HINT}") from exc
        self._delegate = self._build_delegate()

    def _build_delegate(self) -> Any:
        from presidio_analyzer import EntityRecognizer, RecognizerResult

        class _Delegate(EntityRecognizer):  # type: ignore[misc]
            def __init__(self) -> None:
                super().__init__(supported_entities=["SECRET"], name="SecretScanRecognizer")

            def load(self) -> None:  # pragma: no cover - no model to load
                return None

            def analyze(self, text: str, entities: list[str], nlp_artifacts: Any = None) -> list[Any]:
                if entities and "SECRET" not in entities:
                    return []
                results: list[Any] = []
                for _label, pattern in _SECRET_PATTERNS:
                    for match in pattern.finditer(text):
                        results.append(
                            RecognizerResult(
                                entity_type="SECRET",
                                start=match.start(),
                                end=match.end(),
                                score=0.95,
                            )
                        )
                return results

        return _Delegate()

    def load(self) -> None:
        self._delegate.load()

    def analyze(self, text: str, entities: list[str], nlp_artifacts: Any = None) -> list[Any]:
        return self._delegate.analyze(text, entities, nlp_artifacts)

    @property
    def presidio_recognizer(self) -> Any:
        return self._delegate


@runtime_checkable
class Analyzer(Protocol):
    """Anything that can find PII spans in text -- satisfied by Presidio's
    real ``AnalyzerEngine`` and by any test double.

    ``language`` intentionally has no default here (pre-existing mypy
    finding, fixed as part of Section 6.2(d)'s cheap-fix cleanup):
    Presidio's real ``AnalyzerEngine.analyze`` declares ``language`` as a
    required parameter in its own type stub, so a Protocol default would
    structurally overpromise what the real engine actually accepts -- every
    real call site in this module already passes ``language`` explicitly
    (see :meth:`Redactor.redact`), so this changes no runtime behavior."""

    def analyze(self, text: str, language: str) -> list[Any]: ...


class Redactor:
    """Reversible PII redact/rehydrate around one piece of text.

    Real construction (:func:`get_redactor`) lazily builds a Presidio
    ``AnalyzerEngine`` (optionally with :class:`OpenAIPrivacyFilterRecognizer`
    registered alongside Presidio's own built-in recognizers) and an
    ``AnonymizerEngine``. Tests inject a fake ``analyzer``/``anonymizer_factory``
    pair instead, so redaction round-trip logic can be exercised without
    ``presidio``/``torch`` installed.
    """

    def __init__(
        self,
        *,
        analyzer: Analyzer | None = None,
        language: str = "en",
        enable_openai_filter: bool = True,
    ) -> None:
        self._language = language
        self._analyzer = analyzer if analyzer is not None else self._build_analyzer(enable_openai_filter)

    def _build_analyzer(self, enable_openai_filter: bool) -> Analyzer:
        try:
            from presidio_analyzer import AnalyzerEngine
        except ImportError as exc:  # pragma: no cover - exercised only without presidio
            raise RuntimeError(f"Redactor requires presidio-analyzer: {_INSTALL_HINT}") from exc

        engine = AnalyzerEngine()

        # Always registered -- zero extra dependencies beyond the base
        # [privacy] extra (see SecretScanRecognizer's docstring).
        engine.registry.add_recognizer(SecretScanRecognizer().presidio_recognizer)

        if enable_openai_filter:
            try:
                openai_recognizer = OpenAIPrivacyFilterRecognizer()
            except RuntimeError:
                # torch/transformers (the opt-in [privacy-full] extra) not
                # installed -- fall back to Presidio's own built-in
                # recognizers + SecretScanRecognizer only, never a hard
                # failure. See the module docstring's honesty note: this
                # module never claims the OpenAI filter ran when it didn't.
                pass
            else:
                engine.registry.add_recognizer(openai_recognizer.presidio_recognizer)
        return engine

    def redact(self, text: str) -> tuple[str, dict[str, str]]:
        """Return ``(redacted_text, rehydrate_map)``.

        ``rehydrate_map`` maps each unique ``[REDACTED_<TYPE>_<n>]`` token
        back to the exact original substring it replaced -- pass it to
        :meth:`rehydrate` to reverse the operation.
        """
        if not text:
            return text, {}

        results = self._analyzer.analyze(text=text, language=self._language)
        if not results:
            return text, {}

        rehydrate_map: dict[str, str] = {}
        counters: dict[str, int] = {}

        def _operator_for(entity_type: str) -> Any:
            def _replace(original_value: str, **_kwargs: Any) -> str:
                counters[entity_type] = counters.get(entity_type, 0) + 1
                token = f"[REDACTED_{entity_type}_{counters[entity_type]}]"
                rehydrate_map[token] = original_value
                return token

            return _replace

        entity_types = sorted({getattr(r, "entity_type") for r in results})

        try:
            from presidio_anonymizer import AnonymizerEngine
            from presidio_anonymizer.entities import OperatorConfig
        except ImportError as exc:  # pragma: no cover - exercised only without presidio
            raise RuntimeError(f"Redactor requires presidio-anonymizer: {_INSTALL_HINT}") from exc

        operators = {
            entity_type: OperatorConfig("custom", {"lambda": _operator_for(entity_type)})
            for entity_type in entity_types
        }
        anonymized = AnonymizerEngine().anonymize(text=text, analyzer_results=results, operators=operators)
        return anonymized.text, rehydrate_map

    @staticmethod
    def rehydrate(text: str, rehydrate_map: dict[str, str]) -> str:
        """Reverse :meth:`redact`: replace every ``[REDACTED_...]`` token in
        ``text`` with its original value. Tokens with no entry in
        ``rehydrate_map`` (e.g. the model echoed a token from a different
        call) are left as-is rather than raising.

        Real LLMs frequently fail to echo the exact bracketed token
        (``[REDACTED_<TYPE>_<n>]``) byte-for-byte when copying it into a
        short structured field, e.g. an extracted entity name -- they
        commonly (a) drop the surrounding brackets, (b) turn the
        underscores inside ``<TYPE>`` into spaces, and/or (c) fuse the
        token directly against adjacent text with no separator. To stay
        robust to all three without over-matching, this does two passes
        per token: an exact literal fast-path first (cheap, and the only
        thing well-behaved output needs), then -- only for tokens the
        exact pass didn't find -- a permissive regex pass that tolerates
        missing brackets and underscore/space equivalence within
        ``<TYPE>`` while still matching only the token's own span (never
        consuming adjacent, unrelated characters)."""
        if not rehydrate_map:
            return text
        result = text

        # Exact fast-path: literal bracketed token, byte-for-byte.
        remaining: dict[str, str] = {}
        for token, original in rehydrate_map.items():
            if token in result:
                result = result.replace(token, original)
            else:
                remaining[token] = original
        if not remaining:
            return result

        # Permissive fallback pass, for tokens the exact pass missed.
        # Sort by descending token length so a longer/more-specific token
        # (e.g. "[REDACTED_US_DRIVER_LICENSE_1]") can't be partially
        # shadowed by a shorter one sharing a prefix before it gets a
        # chance to match its own full span.
        _TOKEN_RE = re.compile(r"^\[?REDACTED_(?P<type>[A-Z0-9_]+)_(?P<index>\d+)\]?$")
        for token in sorted(remaining, key=len, reverse=True):
            original = remaining[token]
            match = _TOKEN_RE.match(token)
            if not match:
                # Not a well-formed token to begin with -- nothing to
                # permissively match against; leave text untouched for it.
                continue
            entity_type, index = match.group("type"), match.group("index")
            # Within the type, underscores may have become one-or-more
            # whitespace characters; brackets are optional.
            type_pattern = r"[ _]+".join(re.escape(part) for part in entity_type.split("_"))
            pattern = re.compile(
                r"\[?REDACTED[ _]+" + type_pattern + r"[ _]+" + re.escape(index) + r"\]?"
            )

            # A small named function, not a lambda with a default-argument
            # loop-variable-capture trick (pre-existing mypy finding, fixed
            # as part of Section 6.2(d)'s cheap-fix cleanup: mypy couldn't
            # infer the lambda's parameter/return types). Explicit
            # annotations here are unambiguous, and the closure still
            # captures the correct per-iteration `original` via the default
            # argument, exactly as the lambda did.
            def _replace_match(_match: re.Match[str], _original: str = original) -> str:
                return _original

            result = pattern.sub(_replace_match, result, count=1)
        return result


def is_privacy_extra_installed() -> bool:
    """True if ``presidio_analyzer``/``presidio_anonymizer`` are importable.

    Never imports ``torch``/``transformers`` -- the OpenAI-filter recognizer
    is an additional, independently-optional layer on top of Presidio, not a
    hard requirement of the ``[privacy]`` extra itself."""
    try:
        import presidio_analyzer  # noqa: F401
        import presidio_anonymizer  # noqa: F401
    except ImportError:
        return False
    return True


def get_redactor(settings: Settings) -> Redactor | None:
    """Resolve ``settings.redaction_enabled`` into a concrete :class:`Redactor`.

    * ``settings.redaction_enabled is False`` (explicit user opt-out) ->
      returns ``None`` -- "no redaction; pass content through unchanged" is
      allowed *only* in this case.
    * ``settings.redaction_enabled is True`` (the default) but the
      ``[privacy]`` extra isn't installed, or :class:`Redactor` construction
      otherwise fails -> raises :class:`RedactionUnavailableError`. This is a
      **fail-closed** contract, not graceful degradation: a vault with
      redaction "on" by default and no extras installed must never silently
      send unredacted content to an LLM provider. Callers
      (``compile.pipeline``/``query.engine``) catch this and refuse the LLM
      call entirely, converting it into the caller's own error type.

    Unlike :func:`~mythic_proportion.index.embeddings.get_embedder` (which
    degrades to :class:`~mythic_proportion.index.embeddings.HashEmbedder`
    because *not* embedding is never a privacy/safety regression), redaction
    unavailability is safety-relevant, so this function does not mirror that
    "return ``None`` -> degrade gracefully" shape when the extra is missing.
    """
    if not settings.redaction_enabled:
        return None
    if not is_privacy_extra_installed():
        raise RedactionUnavailableError(
            "redaction_enabled=True but the 'privacy' extra isn't installed "
            f"({_INSTALL_HINT}); refusing to send unredacted content to any LLM "
            "provider. Either install the extra, or explicitly disable redaction "
            "(redaction_enabled=False) to opt out."
        )
    try:
        return Redactor()
    except RuntimeError as exc:
        raise RedactionUnavailableError(str(exc)) from exc


# ---------------------------------------------------------------------------
# redact -> LLM -> rehydrate wrappers around the provider layer
# ---------------------------------------------------------------------------


class RedactingCompileClient:
    """Wraps a :class:`~mythic_proportion.compile.client.CompileClient` with a
    redact -> compile -> rehydrate call path.

    Only the user-supplied source text (``prompt.user``, which embeds the
    ingested source content) is redacted; ``prompt.system`` is a static
    instruction template with no PII. Every string field of the returned
    :class:`~mythic_proportion.compile.models.CompileResult` (page titles,
    bodies, contradiction notes) is rehydrated before being handed back, so
    the on-disk wiki page always contains the real PII again -- only the
    *outbound* request to the LLM ever carried the redacted form.
    """

    def __init__(self, inner: Any, redactor: Redactor) -> None:
        self._inner = inner
        self._redactor = redactor

    def compile(self, prompt: Any) -> Any:
        from dataclasses import replace as dc_replace

        redacted_user, rehydrate_map = self._redactor.redact(prompt.user)
        redacted_prompt = dc_replace(prompt, user=redacted_user)
        result = self._inner.compile(redacted_prompt)
        if not rehydrate_map:
            return result

        rehydrated_pages = []
        for page in result.pages:
            fm = dict(page.frontmatter)
            if isinstance(fm.get("tags"), list):
                fm["tags"] = [self._redactor.rehydrate(t, rehydrate_map) for t in fm["tags"]]
            rehydrated_pages.append(
                page.model_copy(
                    update={
                        "title": self._redactor.rehydrate(page.title, rehydrate_map),
                        "body": self._redactor.rehydrate(page.body, rehydrate_map),
                        "frontmatter": fm,
                    }
                )
            )
        rehydrated_contradictions = [
            self._redactor.rehydrate(c, rehydrate_map) for c in result.contradictions
        ]
        return result.__class__(
            pages=rehydrated_pages,
            contradictions=rehydrated_contradictions,
            links_created=list(getattr(result, "links_created", [])),
        )


class RedactingAnswerClient:
    """Wraps an :class:`~mythic_proportion.query.client.AnswerClient` with a
    redact -> answer -> rehydrate call path."""

    def __init__(self, inner: Any, redactor: Redactor) -> None:
        self._inner = inner
        self._redactor = redactor

    def answer(self, prompt: Any) -> Any:
        from dataclasses import replace as dc_replace

        redacted_user, rehydrate_map = self._redactor.redact(prompt.user)
        redacted_prompt = dc_replace(prompt, user=redacted_user)
        result = self._inner.answer(redacted_prompt)
        if not rehydrate_map:
            return result
        return result.__class__(
            text=self._redactor.rehydrate(result.text, rehydrate_map),
            citations=[self._redactor.rehydrate(c, rehydrate_map) for c in result.citations],
        )


class RedactingExtractionClient:
    """Wraps a GraphRAG :class:`~mythic_proportion.graph.extract.ExtractionClient`
    (``complete(system, user) -> str``) with a redact -> complete -> rehydrate
    call path.

    **Turn-scoping (closes a PII cloud-egress leak).** :meth:`complete` is a
    one-shot redact/rehydrate cycle -- correct for a single call, but GraphRAG
    extraction is not always a single call: the repair round-trip
    (:func:`mythic_proportion.graph.extract._parse_with_one_repair`) and the
    gleaning recall loop (:func:`mythic_proportion.graph.extract.extract_entities_relationships`)
    both splice a *prior completion's text* into a *new* outbound prompt for
    the next round. If that prior text had already been rehydrated back to
    real PII (as :meth:`complete` does), it re-enters the redaction pipeline
    from scratch on the next call -- and Presidio measurably under-detects
    PII in pipe-delimited-tuple-formatted text, so real names/emails could
    reach the cloud LLM essentially unmasked on any repair/gleaning round.

    :meth:`complete_turn` fixes this at the root: it redacts and calls, but
    deliberately never rehydrates -- the returned text (and every character
    of it that a caller later splices into a follow-up prompt) stays in
    redacted-token form for the entire multi-round turn. Every newly-found
    PII span is merged into the caller-supplied ``turn_map`` (shared across
    all rounds of one turn), and only :meth:`rehydrate_turn`, called exactly
    once at the very end of the whole turn (after the final round's tuples
    have been parsed), is allowed to bring real PII back. See
    ``graph.extract._start_turn``/``_finish_turn`` for the orchestration
    side of this contract.

    **Cache-boundary note (closes a cache-hit PII/placeholder-survival
    bug).** :meth:`redact_for_turn`/:meth:`complete_raw` are the two
    primitives :meth:`complete_turn` composes -- split out so a caller (see
    ``graph.extract._cached_turn_call``) can put the llm_cache lookup
    strictly BETWEEN redaction and the network call. This matters because
    redaction is a deterministic, purely-local, non-network function of its
    input text: replaying :meth:`redact_for_turn` for the exact same text on
    a cache HIT reproduces the identical redacted text/map that produced the
    already-cached response, so ``turn_map`` still gets populated -- and
    :meth:`rehydrate_turn` still runs correctly -- even when the underlying
    LLM call itself is skipped. Without this split, a cache hit would bypass
    :meth:`complete_turn` entirely, leaving ``turn_map`` empty and any
    ``[REDACTED_*]`` token in the cached response unrehydrated forever.
    """

    def __init__(self, inner: Any, redactor: Redactor) -> None:
        self._inner = inner
        self._redactor = redactor

    def complete(self, *, system: str, user: str) -> str:
        """One-shot redact -> complete -> rehydrate. Safe only for a caller
        that makes exactly one completion call per redact/rehydrate cycle --
        never splice this method's return value into a later outbound
        prompt (use :meth:`complete_turn` instead for multi-round turns)."""
        redacted_user, rehydrate_map = self._redactor.redact(user)
        raw = self._inner.complete(system=system, user=redacted_user)
        if not rehydrate_map:
            return raw
        return self._redactor.rehydrate(raw, rehydrate_map)

    def redact_for_turn(self, text: str, turn_map: dict[str, str]) -> str:
        """Redact ``text`` LOCALLY (no network call), merging any newly-found
        PII spans into the shared ``turn_map`` (mutated in place), and return
        the redacted text. ``text`` may itself already contain
        ``[REDACTED_*]`` tokens spliced in from an earlier round of the same
        turn -- that's expected and safe (they simply won't match any new PII
        span). See the class docstring's "cache-boundary note" for why this
        is split out from :meth:`complete_turn`."""
        redacted_text, new_map = self._redactor.redact(text)
        turn_map.update(new_map)
        return redacted_text

    def complete_raw(self, *, system: str, user: str) -> str:
        """Call the wrapped inner client directly with NO redact/rehydrate.
        Only safe once ``user`` has already been redacted (e.g. via
        :meth:`redact_for_turn`) by the caller."""
        return self._inner.complete(system=system, user=user)

    def complete_turn(self, *, system: str, user: str, turn_map: dict[str, str]) -> str:
        """Redact ``user`` (via :meth:`redact_for_turn`) then call the inner
        client (via :meth:`complete_raw`), returning the RAW completion
        WITHOUT rehydrating. Convenience composition of the two primitives
        above for a caller that doesn't need cache-boundary control."""
        redacted_user = self.redact_for_turn(user, turn_map)
        return self.complete_raw(system=system, user=redacted_user)

    def rehydrate_turn(self, text: str, turn_map: dict[str, str]) -> str:
        """Reverse every ``[REDACTED_*]`` token in ``text`` using the
        accumulated ``turn_map`` -- call exactly once, at the very end of a
        :meth:`complete_turn`-orchestrated extraction turn."""
        return self._redactor.rehydrate(text, turn_map)
