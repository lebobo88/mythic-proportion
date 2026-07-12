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
                raw = outer._pipeline(text)  # type: ignore[misc]
                results: list[Any] = []
                for token in raw:
                    label = str(token.get("entity_group") or token.get("entity") or "").upper()
                    entity_type = _OPENAI_LABEL_TO_ENTITY.get(label)
                    if entity_type is None or (entities and entity_type not in entities):
                        continue
                    results.append(
                        RecognizerResult(
                            entity_type=entity_type,
                            start=int(token["start"]),
                            end=int(token["end"]),
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
    real ``AnalyzerEngine`` and by any test double."""

    def analyze(self, text: str, language: str = "en") -> list[Any]: ...


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
        call) are left as-is rather than raising."""
        if not rehydrate_map:
            return text
        result = text
        for token, original in rehydrate_map.items():
            result = result.replace(token, original)
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
    call path."""

    def __init__(self, inner: Any, redactor: Redactor) -> None:
        self._inner = inner
        self._redactor = redactor

    def complete(self, *, system: str, user: str) -> str:
        redacted_user, rehydrate_map = self._redactor.redact(user)
        raw = self._inner.complete(system=system, user=redacted_user)
        if not rehydrate_map:
            return raw
        return self._redactor.rehydrate(raw, rehydrate_map)
