# Security Advisory: GraphRAG Extraction PII Cloud-Egress Leak

**ID**: mythic-proportion-20260712-graphrag-pii-egress  
**Severity**: CRITICAL  
**Affected Versions**: All Phase 3+ with GraphRAG extraction enabled and `redaction_enabled=true` (default Phase 6)  
**Fixed In**: v0.7.0 (feat/3d-graphrag branch)  

## Summary

A genuine PII cloud-egress vulnerability exists in the GraphRAG extraction pipeline's repair and gleaning rounds. Real names, email addresses, phone numbers, and other sensitive personally identifiable information can be sent unmasked to the configured cloud LLM provider (AuthHub/DeepSeek by default, or user-configured provider) during multi-round extraction attempts.

**This does NOT affect vaults with `redaction_enabled=false`** (redaction explicitly disabled in settings), nor does it affect the initial extraction pass in isolation — only repair rounds (triggered by parse failures) and gleaning rounds (recall-loop expansions).

## Root Cause

Redaction/rehydration state is scoped per-LLM-call rather than per-extraction-turn. In a multi-round extraction (initial call + repair + gleaning rounds):

1. Initial completion is rehydrated with real PII exposed
2. That already-rehydrated text (containing real PII) is embedded as context in the next repair/gleaning prompt
3. The new prompt is redacted fresh from scratch with only Presidio's built-in + basic recognizers (the OpenAI Privacy Filter is optional and not deployed in many environments)
4. Presidio significantly under-detects PII in pipe-delimited-tuple format (the format extraction uses)
5. Result: unredacted real PII reaches the cloud LLM, violating the "redact before any cloud call" invariant

## Impact

- **Direct**: Real names, emails, phone numbers, locations, and URLs from vault content can leak to cloud LLM providers on repair/gleaning rounds
- **Scope**: Only vaults actively using GraphRAG extraction (`mythic index-graph` or the new UI button) with `redaction_enabled=true`
- **Detection**: Impossible for users to detect (redaction tokens appear in logs, but real values go to cloud; logs are not inspectable in the normal flow)

## Mitigation

**Immediate (before update)**:
- **Recommended**: Stop using extraction: do not run `mythic index-graph` or use the new "Build Knowledge Graph" button until updated. This is the safest option.
- **Alternative**: Switch vault to fully local extraction: set `settings.local=true` and use Ollama or another local LLM provider (configured via `settings.ollama_base_url`/`ollama_model`). Local extraction paths never reach cloud LLM providers, so the cloud-egress leak does not occur.

**After update (v0.7.0)**:
- Update to v0.7.0 or later (feat/3d-graphrag branch)
- Re-run extraction: all vaults that have previously run extraction should re-run `mythic index-graph` to generate clean local data going forward. Note: re-extraction creates new, clean local database records and fixes corrupted data stored locally, but **cannot undo or retract PII already transmitted to cloud LLM providers in pre-fix extraction runs.** See incident-response section below.
- Verify: see Vault Data Cleanup runbook for verification procedure (SQLite inspection + browser sanity check)

## Incident Response

If your vault has `redaction_enabled=true` and ran extraction with repair or gleaning rounds before this fix, PII may have been transmitted to your configured cloud LLM provider (AuthHub, DeepSeek, or user-configured). Follow these steps:

1. **Check provider logs**: Log in to your LLM provider's dashboard or console and review request logs for the time period when you ran extraction before v0.7.0. Check whether redacted placeholders (e.g., `[REDACTED_PERSON_1]`) appeared only, or whether real PII was captured.
2. **Review provider terms**: Check your LLM provider's data retention and deletion policy. Many providers retain request data for a limited time (e.g., 30 days) before purging.
3. **Request data deletion** (if supported): If your provider supports data deletion requests or has a data retention setting, contact their support and request deletion of extraction requests from the affected time period. Provide them with the date/time range when you ran extraction.
4. **Notify your security/privacy stakeholder**: If this vault contains sensitive personal data belonging to others, notify the relevant stakeholder (privacy officer, data controller, or the individual) so they are aware of the exposure and can take appropriate action.
5. **Update to v0.7.0 and re-extract**: Once updated, re-run extraction to generate clean local data going forward. New extraction runs with v0.7.0 are protected by the fixed redaction architecture and will not leak PII.

## Fix Details

Redaction/rehydration map is now scoped to an entire extraction turn (initial + repair + gleaning rounds together), not per-call. The repair/gleaning prompt loops operate on redacted text throughout; only the final parsed records are rehydrated once, after all rounds complete. This ensures:
1. Redacted text never re-enters cleartext form until the absolute final step
2. No unredacted PII ever exits the process during an extraction turn
3. No `REDACTED_*` placeholder ever persists in the final stored data

All cloud-bound payloads during extraction are verified PII-free via a new integration test (`tests/test_egress_gate.py`) that exercises multi-round extraction with planted PII.

## Timeline

- **v0.7.0**: Fix is implemented, tested, and merged to feat/3d-graphrag
- **No EOL**: Users must update; there is no "this version is fine" narrative for existing deployment
- **Data cleanup required**: Vaults with prior extraction should re-run extraction (step-by-step instructions in Runbook § Vault Data Cleanup)

## Reporting

If you discover any PII leakage or have questions about this vulnerability, contact the maintainers immediately.
