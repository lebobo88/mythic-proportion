"""Delimited-tuple prompts + parser for GraphRAG extraction (Phase 3).

Adapts the *structure* of Microsoft GraphRAG's MIT-licensed
``extract_graph``/``summarize_descriptions``/``extract_claims`` prompts --
the ``("entity"<|>NAME<|>TYPE<|>DESC)##("relationship"<|>A<|>B<|>DESC<|>
strength)<|COMPLETE|>`` delimited-tuple output format -- rather than nested
JSON, because it is far more drift-robust for small/local models and trivial
to parse with a ``split``. Everything downstream (:mod:`.extract`,
:mod:`.claims`) calls into :func:`parse_tuple_records` here so the two
extraction paths can never drift on parsing behavior.
"""

from __future__ import annotations

import re

TUPLE_DELIM = "<|>"
RECORD_DELIM = "##"
COMPLETION_DELIM = "<|COMPLETE|>"

#: Constrained per the brief ("constrain `type` to a small enum") -- keeps
#: extraction from drifting into an unbounded, hard-to-dedup type vocabulary.
ENTITY_TYPES: frozenset[str] = frozenset(
    {"PERSON", "ORGANIZATION", "LOCATION", "EVENT", "CONCEPT", "OTHER"}
)

CLAIM_STATUSES: frozenset[str] = frozenset({"TRUE", "FALSE", "SUSPECTED"})

_FENCE_RE = re.compile(r"```(?:\w+)?\s*(.*?)```", re.DOTALL)


def strip_markdown_fences(text: str) -> str:
    """Return the inside of a ```...``` fence if present, else ``text`` unchanged."""
    text = text.strip()
    match = _FENCE_RE.search(text)
    if match:
        return match.group(1).strip()
    return text


def _split_balanced_records(text: str) -> list[str]:
    """Split ``text`` on top-level ``##`` only -- i.e. never inside an open
    ``(...)`` pair -- so a record delimiter appearing inside a description
    can't fracture that record. This is the "balanced-delimiter scan"."""
    records: list[str] = []
    depth = 0
    current: list[str] = []
    i = 0
    n = len(text)
    delim_len = len(RECORD_DELIM)
    while i < n:
        ch = text[i]
        if ch == "(":
            depth += 1
            current.append(ch)
            i += 1
        elif ch == ")":
            depth = max(0, depth - 1)
            current.append(ch)
            i += 1
        elif depth == 0 and text[i : i + delim_len] == RECORD_DELIM:
            records.append("".join(current))
            current = []
            i += delim_len
        else:
            current.append(ch)
            i += 1
    if current:
        records.append("".join(current))
    return [r.strip() for r in records if r.strip()]


def parse_tuple_records(raw_text: str) -> list[list[str]]:
    """Parse delimited-tuple model output into ``[[record_type, field, ...], ...]``.

    Survives markdown code fences, a trailing ``<|COMPLETE|>`` sentinel (and
    anything after it -- ignored), and malformed/truncated records (which are
    simply dropped, not raised) -- callers decide whether zero records back
    from otherwise-non-empty input constitutes a parse failure worth a repair
    round-trip (see :mod:`.extract`).
    """
    text = strip_markdown_fences(raw_text)
    complete_idx = text.find(COMPLETION_DELIM)
    if complete_idx != -1:
        text = text[:complete_idx]

    records: list[list[str]] = []
    for raw_record in _split_balanced_records(text):
        record = raw_record.strip()
        if "(" not in record:
            # Not tuple-shaped at all (e.g. a stray prose sentence with no
            # `(`) -- never a record, however non-empty its text is.
            continue
        if record.startswith("(") and record.endswith(")"):
            record = record[1:-1]
        else:
            # Truncated/malformed record -- missing one or both parens.
            # Best-effort: take the span between the first "(" and the last
            # ")" if both are present and well-ordered, else everything
            # after the first "(" (a record truncated mid-stream, with no
            # closing paren at all yet).
            start = record.find("(")
            end = record.rfind(")")
            record = record[start + 1 : end] if end > start else record[start + 1 :]
        fields = [field.strip().strip('"') for field in record.split(TUPLE_DELIM)]
        if fields and fields[0]:
            records.append(fields)
    return records


def normalize_title(title: str) -> str:
    """Normalize an entity/subject/object title for dedup: strip + uppercase.

    ``entities.UNIQUE(title, type)`` depends on every producer of a title
    (extraction, claims, the reader in ``graph.store``) normalizing
    identically -- this is the single function that does it.
    """
    return title.strip().upper()


def normalize_entity_type(raw_type: str) -> str:
    """Coerce a model-produced type string into :data:`ENTITY_TYPES`, defaulting to ``"OTHER"``."""
    candidate = raw_type.strip().upper()
    return candidate if candidate in ENTITY_TYPES else "OTHER"


def normalize_claim_status(raw_status: str) -> str:
    """Coerce a model-produced claim status into :data:`CLAIM_STATUSES`, defaulting to ``"SUSPECTED"``."""
    candidate = raw_status.strip().upper()
    return candidate if candidate in CLAIM_STATUSES else "SUSPECTED"


def build_extract_graph_prompt(text: str) -> tuple[str, str]:
    """System/user prompt pair for one entity+relationship extraction pass."""
    system = (
        "You are an information-extraction assistant building a knowledge graph "
        "from personal-wiki text. Identify every named entity and every "
        "relationship between entities in the given text.\n\n"
        f"Entity `TYPE` MUST be exactly one of: {', '.join(sorted(ENTITY_TYPES))}.\n\n"
        "Output ONLY delimited-tuple records -- nothing else, no prose, no "
        "markdown code fences. Two record shapes, separated by "
        f"{RECORD_DELIM}:\n"
        f'("entity"{TUPLE_DELIM}<NAME>{TUPLE_DELIM}<TYPE>{TUPLE_DELIM}<DESCRIPTION>)\n'
        f'("relationship"{TUPLE_DELIM}<SOURCE_NAME>{TUPLE_DELIM}<TARGET_NAME>'
        f"{TUPLE_DELIM}<DESCRIPTION>{TUPLE_DELIM}<STRENGTH 1-10>)\n\n"
        f"When you have listed everything, output exactly {COMPLETION_DELIM} "
        "and nothing after it."
    )
    user = f"Text:\n{text}\n\nExtract every entity and relationship now."
    return system, user


def build_gleaning_prompt() -> str:
    """A bounded 'did you miss any?' recall-loop continuation message."""
    return (
        "MANY entities and relationships were missed in the last extraction. "
        "Add any missing ones now, using the exact same tuple format "
        f"({RECORD_DELIM}-separated records). If nothing was missed, respond "
        f"with exactly {COMPLETION_DELIM} and nothing else."
    )


def build_repair_prompt(malformed: str) -> str:
    """A one-shot repair round-trip message for output that failed to parse."""
    return (
        "Your previous output could not be parsed. Reformat it EXACTLY as "
        f"instructed -- delimited-tuple records separated by {RECORD_DELIM}, "
        f"terminated by {COMPLETION_DELIM}, no markdown code fences, no prose. "
        f"Here is your previous output to reformat:\n\n{malformed}"
    )


def build_claims_prompt(text: str, entity_titles: list[str]) -> tuple[str, str]:
    """System/user prompt pair for one claim-extraction pass over known entities."""
    system = (
        "You are a claim-extraction assistant. Given a text passage and a list "
        "of known entities, extract factual claims involving those entities.\n\n"
        f"Claim `STATUS` MUST be exactly one of: {', '.join(sorted(CLAIM_STATUSES))}.\n\n"
        "Output ONLY delimited-tuple records of this shape, separated by "
        f"{RECORD_DELIM}:\n"
        f'("claim"{TUPLE_DELIM}<SUBJECT_ENTITY>{TUPLE_DELIM}<OBJECT_ENTITY_OR_NONE>'
        f"{TUPLE_DELIM}<TYPE>{TUPLE_DELIM}<STATUS>{TUPLE_DELIM}<PERIOD_START_OR_NONE>"
        f"{TUPLE_DELIM}<PERIOD_END_OR_NONE>{TUPLE_DELIM}<DESCRIPTION>)\n\n"
        f"When you have listed everything, output exactly {COMPLETION_DELIM} "
        "and nothing after it."
    )
    entities_list = ", ".join(entity_titles)
    user = f"Known entities: {entities_list}\n\nText:\n{text}\n\nExtract every claim now."
    return system, user
