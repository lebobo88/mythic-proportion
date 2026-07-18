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

#: Browser-audit item 7 (cosmetic/data-quality finding): a truncated or
#: malformed tuple record can leak a raw delimiter artifact -- our own
#: `TUPLE_DELIM`/`COMPLETION_DELIM` tokens, optionally followed by stray
#: trailing digits (e.g. `<|>7` -- a `TUPLE_DELIM` immediately followed by a
#: leaked relationship-strength value) -- into a neighboring entity/subject/
#: object field. Built directly from the actual delimiter constants (not a
#: generic heuristic) so it can never drift out of sync with them, and so it
#: never strips legitimate `<...>`-shaped prose that isn't one of *our*
#: control tokens, nor a legitimate digit elsewhere in a title (e.g.
#: "APOLLO 11") that isn't immediately preceded by a leaked delimiter.
_CONTROL_TOKEN_RE = re.compile(
    r"(?:" + "|".join(re.escape(token) for token in (COMPLETION_DELIM, TUPLE_DELIM)) + r")\d*"
)


def _sanitize_title_text(title: str) -> str:
    """Strip leaked delimiter control tokens and collapse every whitespace
    run -- including an embedded newline/tab from a source-text mid-name
    line wrap -- into a single space, ahead of the strip+uppercase dedup
    key. This is the fix for two browser-audit item 7 findings: a duplicate
    "PRIYA ANAND" PERSON node (one copy carried a literal embedded newline
    because the source text itself line-wraps mid-name, so it hashed to a
    different dedup key than the clean form) and a LOCATION node carrying a
    raw `<|>7`-shaped delimiter artifact."""
    return re.sub(r"\s+", " ", _CONTROL_TOKEN_RE.sub("", title))


def strip_markdown_fences(text: str) -> str:
    """Return the inside of a ```...``` fence if present, else ``text`` unchanged."""
    text = text.strip()
    match = _FENCE_RE.search(text)
    if match:
        return match.group(1).strip()
    return text


def _split_balanced_paren_groups(text: str) -> list[str]:
    """Scan ``text`` for top-level balanced ``(...)`` groups, ignoring
    whatever separates them (e.g. a bare newline where :data:`RECORD_DELIM`
    should have been). Used as defense-in-depth by :func:`_split_balanced_records`
    when a completion is missing the ``##`` record delimiter entirely --
    without this, two records separated only by ``\\n`` would be treated as
    one blob and each record's description would absorb the literal opening
    syntax of the next record (e.g. ``...modeling.)\\n("entity``)."""
    groups: list[str] = []
    depth = 0
    start: int | None = None
    for i, ch in enumerate(text):
        if ch == "(":
            if depth == 0:
                start = i
            depth += 1
        elif ch == ")":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    groups.append(text[start : i + 1])
                    start = None
    return groups


def _split_balanced_records(text: str) -> list[str]:
    """Split ``text`` on top-level ``##`` only -- i.e. never inside an open
    ``(...)`` pair -- so a record delimiter appearing inside a description
    can't fracture that record. This is the "balanced-delimiter scan".

    Defense-in-depth: if this yields at most one "record" (i.e. no top-level
    ``##`` was found at all), but that blob actually contains more than one
    top-level balanced ``(...)`` group, the model has produced multiple
    records separated by something other than ``##`` (in practice: a bare
    newline -- see :func:`build_extract_graph_prompt`'s worked example).
    Falls back to :func:`_split_balanced_paren_groups` in that case rather
    than silently corrupting every record after the first.
    """
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
    records = [r.strip() for r in records if r.strip()]

    if len(records) <= 1:
        groups = _split_balanced_paren_groups(text)
        if len(groups) > 1:
            return groups
    return records


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
    """Normalize an entity/subject/object title for dedup: sanitize, collapse
    whitespace, strip, and uppercase.

    ``entities.UNIQUE(title, type)`` depends on every producer of a title
    (extraction, claims, the reader in ``graph.store``) normalizing
    identically -- this is the single function that does it. See
    :func:`_sanitize_title_text` for the browser-audit item 7 fix this
    added: leaked delimiter control tokens are stripped and every
    whitespace run (including an embedded newline from a source-text
    mid-name line wrap) collapses to a single space *before* the
    strip+uppercase dedup key is built, so e.g. ``"Priya\\nAnand"`` and
    ``"Priya Anand"`` now hash to the same entity instead of producing two
    near-duplicate PERSON nodes.
    """
    return _sanitize_title_text(title).strip().upper()


def normalize_entity_type(raw_type: str) -> str:
    """Coerce a model-produced type string into :data:`ENTITY_TYPES`, defaulting to ``"OTHER"``."""
    candidate = raw_type.strip().upper()
    return candidate if candidate in ENTITY_TYPES else "OTHER"


def normalize_claim_status(raw_status: str) -> str:
    """Coerce a model-produced claim status into :data:`CLAIM_STATUSES`, defaulting to ``"SUSPECTED"``."""
    candidate = raw_status.strip().upper()
    return candidate if candidate in CLAIM_STATUSES else "SUSPECTED"


def build_extract_graph_prompt(text: str) -> tuple[str, str]:
    """System/user prompt pair for one entity+relationship extraction pass.

    The worked example below is load-bearing, not decorative: an earlier
    version of this prompt only ever showed the two record-shape *templates*
    on separate lines joined by a bare ``\\n`` (never an actual multi-record
    example joined by :data:`RECORD_DELIM`), so real model completions
    mimicked that newline-joined shape instead of using ``##`` -- see
    ``graph/tuples.py``'s parser, which only splits on top-level ``##``. The
    example here explicitly shows two same-kind (entity/entity) records and
    one different-kind (entity/relationship) transition, ALL joined by
    ``##``, so the model's own few-shot example teaches the correct
    delimiter.
    """
    example_text = (
        "Ada Lovelace worked with Charles Babbage on the Analytical Engine. "
        "They corresponded by letter for years."
    )
    example_output = RECORD_DELIM.join(
        [
            f'("entity"{TUPLE_DELIM}ADA LOVELACE{TUPLE_DELIM}PERSON{TUPLE_DELIM}'
            f"A mathematician who worked on the Analytical Engine.)",
            f'("entity"{TUPLE_DELIM}CHARLES BABBAGE{TUPLE_DELIM}PERSON{TUPLE_DELIM}'
            f"An inventor who designed the Analytical Engine.)",
            f'("entity"{TUPLE_DELIM}ANALYTICAL ENGINE{TUPLE_DELIM}CONCEPT{TUPLE_DELIM}'
            f"A proposed mechanical general-purpose computer.)",
            f'("relationship"{TUPLE_DELIM}ADA LOVELACE{TUPLE_DELIM}CHARLES BABBAGE{TUPLE_DELIM}'
            f"Collaborated on the Analytical Engine and corresponded by letter for years."
            f"{TUPLE_DELIM}9)",
        ]
    ) + COMPLETION_DELIM

    system = (
        "You are an information-extraction assistant building a knowledge graph "
        "from personal-wiki text. Identify every named entity and every "
        "relationship between entities in the given text.\n\n"
        f"Entity `TYPE` MUST be exactly one of: {', '.join(sorted(ENTITY_TYPES))}.\n\n"
        "Output ONLY delimited-tuple records -- nothing else, no prose, no "
        "markdown code fences. Two record shapes:\n"
        f'("entity"{TUPLE_DELIM}<NAME>{TUPLE_DELIM}<TYPE>{TUPLE_DELIM}<DESCRIPTION>)\n'
        f'("relationship"{TUPLE_DELIM}<SOURCE_NAME>{TUPLE_DELIM}<TARGET_NAME>'
        f"{TUPLE_DELIM}<DESCRIPTION>{TUPLE_DELIM}<STRENGTH 1-10>)\n\n"
        "CRITICAL: every record -- whether entity or relationship, of the "
        f"same kind as the previous record or a different kind -- MUST be "
        f"separated from the next record by exactly {RECORD_DELIM} and "
        f"NOTHING ELSE. Never separate records with only a newline. Here is "
        f"a complete, correctly-delimited worked example for the input "
        f'"{example_text}":\n\n{example_output}\n\n'
        "Notice every record above -- including the two consecutive entity "
        "records and the transition from entity to relationship -- is "
        f"joined by {RECORD_DELIM}, never by a bare newline. Your own "
        "output must follow this exact pattern.\n\n"
        f"When you have listed everything, output exactly {COMPLETION_DELIM} "
        "and nothing after it."
    )
    user = f"Text:\n{text}\n\nExtract every entity and relationship now."
    return system, user


def build_gleaning_prompt() -> str:
    """A bounded 'did you miss any?' recall-loop continuation message."""
    return (
        "MANY entities and relationships were missed in the last extraction. "
        "Add any missing ones now, using the exact same tuple format as "
        f"before. CRITICAL: separate every record from the next with exactly "
        f"{RECORD_DELIM} and nothing else -- never a bare newline -- e.g. "
        f'("entity"{TUPLE_DELIM}NAME{TUPLE_DELIM}TYPE{TUPLE_DELIM}DESC)'
        f'{RECORD_DELIM}("entity"{TUPLE_DELIM}NAME2{TUPLE_DELIM}TYPE2{TUPLE_DELIM}DESC2). '
        f"If nothing was missed, respond with exactly {COMPLETION_DELIM} and nothing else."
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
