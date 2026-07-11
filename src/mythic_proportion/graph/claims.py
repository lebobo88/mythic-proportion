"""Claim extraction over one text unit + its known entities (Phase 3).

Adapts the structure of Microsoft GraphRAG's ``extract_claims`` prompt to
the same delimited-tuple format used by :mod:`.extract` (see
:mod:`.tuples`), routed through the same read-through ``llm_cache``. Only
called once a chunk has at least one already-extracted entity (a claim needs
a known subject), and reuses :func:`mythic_proportion.graph.extract._parse_with_one_repair`
so parsing/repair behavior can never drift between the two extraction paths.
"""

from __future__ import annotations

from dataclasses import dataclass

from mythic_proportion.graph.cache import LlmCache, read_through_complete
from mythic_proportion.graph.extract import ExtractionClient, _parse_with_one_repair
from mythic_proportion.graph.tuples import build_claims_prompt, normalize_claim_status, normalize_title

_NONE_TOKENS = {"", "NONE", "N/A", "NULL"}


@dataclass
class ExtractedClaim:
    subject: str
    object: str | None
    type: str
    status: str
    description: str
    period_start: str | None
    period_end: str | None


def _none_if_blank(raw: str | None) -> str | None:
    if raw is None:
        return None
    return None if raw.strip().upper() in _NONE_TOKENS else raw.strip()


def extract_claims(
    text: str,
    entity_titles: list[str],
    *,
    client: ExtractionClient,
    cache: LlmCache,
    model: str = "mock",
) -> tuple[list[ExtractedClaim], int]:
    """Extract claims from ``text`` involving only the given known ``entity_titles``.

    Returns ``(claims, llm_calls)`` -- ``llm_calls`` counts only cache
    misses, exactly like :func:`mythic_proportion.graph.extract.extract_entities_relationships`.
    Returns ``([], 0)`` immediately if ``entity_titles`` is empty (nothing to
    anchor a claim's subject to).
    """
    if not entity_titles:
        return [], 0

    system, user = build_claims_prompt(text, entity_titles)
    response, hit = read_through_complete(client, cache, system=system, user=user, model=model)
    llm_calls = 0 if hit else 1

    records, repair_calls = _parse_with_one_repair(response, client=client, cache=cache, model=model)
    llm_calls += repair_calls

    claims: list[ExtractedClaim] = []
    for fields in records:
        kind = fields[0].lower()
        if kind != "claim" or len(fields) < 2:
            continue

        subject = normalize_title(fields[1])
        if not subject:
            continue

        obj_raw = fields[2] if len(fields) > 2 else None
        obj_clean = _none_if_blank(obj_raw)
        claim_object = normalize_title(obj_clean) if obj_clean else None

        claim_type = fields[3].strip().upper() if len(fields) > 3 and fields[3].strip() else "OTHER"
        status = normalize_claim_status(fields[4]) if len(fields) > 4 else "SUSPECTED"
        period_start = _none_if_blank(fields[5]) if len(fields) > 5 else None
        period_end = _none_if_blank(fields[6]) if len(fields) > 6 else None
        description = fields[7] if len(fields) > 7 else ""

        claims.append(
            ExtractedClaim(
                subject=subject,
                object=claim_object,
                type=claim_type,
                status=status,
                description=description,
                period_start=period_start,
                period_end=period_end,
            )
        )
    return claims, llm_calls
