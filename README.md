# Verdandi

Verdandi is the stopped, pre-activation reference-ledger project for Grimnir's accepted
**Action Receipt Protocol**.

> Verdandi binds authenticated actor/principal authority and bounded pre-action intent to an
> independently observed authoritative outcome and reversal or mitigation evidence.

The portable product is the protocol—schemas, fixtures, middleware, and outcome-adapter semantics.
Verdandi is intended to be Grimnir's sovereign self-hosted ledger/verifier, not a generic activity
log, LLM-observability platform, SIEM, workflow engine, or source-of-truth database.

## Current lifecycle

**Stopped.** The current code is a hardened historical v1 audit implementation. The legacy
database was lost; physical recovery was declined; continuity is `none`. There is no v2 genesis.

Owner acceptance on 2026-07-14 authorizes governance, schemas/fixtures planning, and backlog
reconciliation only. It does not authorize implementation, restart, deployment, timer enablement,
live integration, or a new genesis.

## Current authority

- [ADR-0001 — Action Receipt Protocol and Verdandi Reference Ledger](docs/adr-0001-action-receipt-ledger.md)
- [64-story candidate product backlog](docs/action-receipt-product-backlog.md)
- [Project status and activation gates](STATUS.md)

## Core boundary

- Receipt-worthy: autonomous consequential state mutation with a named consumer.
- Required: durable pre-action intent, actor/principal authority, independent source readback,
  drift, source reference, and reversal/mitigation.
- Excluded: prompts, reasoning, universal tool telemetry, reads, generic task lifecycle, source
  payload copies, and inferred post-session decisions.
- Failure: fail closed only before autonomous consequential mutation; ordinary work bypasses
  Verdandi.

See ADR-0001 before changing the v1 implementation or opening an implementation PR.
