# Verdandi — Project Status

**Last session:** 2026-07-14 — owner accepted the action-receipt purpose reset; governance PR in progress
**Branch:** `agent/action-receipt-adr` from canonical `origin/main@2c5439a`
**Lifecycle:** stopped

## Current state

- The owner permanently abandoned physical recovery of the deleted legacy database. Treat the
  approximate 67,000-event v1 history as lost and claim no continuity.
- Verdandi's service remains disabled/inactive and its checkpoint timer remains absent/inactive.
- No restart, deployment, new genesis, or implementation has been authorized.
- Canonical `main@2c5439a` is a hardened v1 implementation. It is historical code, not a conforming
  Action Receipt Protocol implementation and has no compatibility promise with a future v2 schema.

## Accepted purpose (2026-07-14)

[ADR-0001](docs/adr-0001-action-receipt-ledger.md) is the current product authority:

> Verdandi is Grimnir's sovereign append-only reference ledger of consequential action receipts.
> It binds authenticated actor/principal authority and bounded pre-action intent to independently
> observed authoritative outcome and reversal or mitigation evidence.

The portable product is the Action Receipt Protocol—schemas, fixtures, mutation middleware, and
authoritative-outcome adapters. Verdandi is the reference ledger/verifier, not a generic audit-log
product.

### Scope boundary

- Fail closed only before autonomous consequential mutations.
- Reads, searches, drafts, model calls, harmless tasks, and ordinary telemetry bypass Verdandi.
- Use `action.intent`, `action.outcome`, and `action.gap` with actor, principal, authority, observer,
  source reference, drift, and reversal/mitigation kept explicit.
- Never capture prompts, reasoning, universal tool calls, generic task lifecycle, source payloads,
  full financial/message/file content, or post-session decision extraction.
- Source systems remain authoritative for their objects.

## Governance work authorized now

- Land ADR-0001 and the 64-story candidate product backlog through review.
- Supersede/close v1 issues #1, #3, and #5.
- Rewrite #2 around minimization, lifecycle, erasure, and independent anchoring.
- Rewrite #15 around tailnet receipt intake and tenant/observer identity lifecycle.
- Close #21 only after the ADR/backlog merge and issue disposition are verified.
- Keep #16 closed while treating its same-host checkpoint as insufficient independent anchoring.

This authorizes documentation, contract planning, fixtures, and issue hygiene only.

## Activation blockers

A separate owner activation decision requires all of the following:

1. v2 schemas and positive/negative selection fixtures;
2. per-tenant mint/list/rotate/revoke plus server-derived actor identity;
3. tailnet-only off-Pi intake;
4. two real adapters with independent authoritative readback, including a non-Claude tenant;
5. a demonstrated fail-closed consequential-mutation gate;
6. an exception-only Heimdall/operator consumer that causes a concrete response;
7. an independently witnessed checkpoint and offline verifier;
8. clean-room export/restore proof;
9. tested retention and erasure on the v2 schema;
10. coordinated Grimnir architecture, tenant, recovery, threat, lifecycle, and registry updates.

No new genesis exists until these are all evidenced and separately approved.

## Accepted proof order

1. Contract schemas/fixtures and fake-provider conformance harness; no external mutation.
2. Grimnir deployment adapter under simulation, including marker drift and `git_revert` recovery.
3. Hugin mutation gate plus Heimdall exception-only consumer.
4. Independent non-Claude tenant and mocked/sandboxed noxctl/Fortnox adapter.
5. Decide whether to extract neutral protocol packages only after two independent integrations and
   a receipt has changed a real operating decision.

## Adjacent Hugin lane assignment

Owner-approved coordination rule:

- Codex owns Harbor/Gate-D evaluation plus gille-inference #250–#252 integration.
- The ticket fleet owns Hugin #190, then #191, then #192; closed #183 remains a capped-window
  acceptance constraint for #190 and is not reopened.
- No duplicate ticket ownership; concurrent work uses separate worktrees.
- Existing review/evidence gates still govern deploy and learning promotion.

## Historical documents

The following are retained for v1 history but are superseded as product authority:

- `docs/multi-env-ingest-design.md` — universal telemetry and fail-open ingestion;
- `docs/offline-recovery-and-new-genesis.md` — physical recovery path declined by owner;
- `docs/checkpoints.md` — local checkpoint mechanism without independent witness.

## Next steps

1. Review and merge the governance PR.
2. Verify the accepted GitHub issue dispositions and close #21.
3. Prepare a separate Stage 0 implementation proposal limited to schemas, fixtures, and a
   no-external-mutation conformance harness.
4. Keep the service and checkpoint timer disabled throughout.
