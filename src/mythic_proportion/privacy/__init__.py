"""Local PII redaction/rehydration layer for cloud LLM calls — scaffolded in
Phase 0, populated in Phase 6 (see :mod:`mythic_proportion.privacy.redact`).

Nothing is imported eagerly here: :mod:`mythic_proportion.privacy.redact`
lazy-imports ``presidio_analyzer``/``presidio_anonymizer`` (and, for the
OpenAI Privacy Filter recognizer, ``torch``/``transformers``) only inside
its own classes/factory function, so importing this package never requires
the optional ``[privacy]`` extra.
"""

from __future__ import annotations
