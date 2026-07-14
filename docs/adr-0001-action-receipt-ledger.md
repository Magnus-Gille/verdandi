# ADR-0001: Action Receipt Protocol and Verdandi Reference Ledger

- **Status:** Accepted
- **Decision date:** 2026-07-14
- **Owner:** Magnus Gille
- **Decision issue:** [#21](https://github.com/Magnus-Gille/verdandi/issues/21)
- **Companion backlog:** [Action-receipt product backlog](action-receipt-product-backlog.md)

> Acceptance of this ADR authorizes contract, fixture, documentation, and backlog work only.
> Verdandi remains stopped. It does not authorize implementation, deployment, restart, a new
> genesis, migration of the v1 database model, or live integration with an authoritative system.

## Context

Verdandi v1 was built as a general audit log for agent activity, tool calls, task lifecycle,
Telegram activity, and inferred decisions. Its only material emitter was a laptop Claude Code
hook. The approximately 67,000-event legacy database was deleted in July 2026. The owner declined
physical SD-card recovery because the expected forensic value did not justify the outage and
sensitive whole-disk handling.

The lost history had no material downstream consumer, no independent integrity anchor, incomplete
actor identity, and known classification gaps. Its volume proved collection, not accountability.
The permanent continuity statement is therefore:

- predecessor: legacy Verdandi v1;
- predecessor continuity: **none**;
- incident: legacy database deleted 2026-07-13;
- physical recovery: explicitly declined by the owner;
- approximate lost history: 67,000 events, never represented as an exact verified count.

The useful question is not “how do we capture agent activity?” It is:

> Which future decision becomes safer or possible because this receipt exists?

If no gate, exception response, rollback, incident review, or autonomy decision consumes a record,
the record should not exist.

## Decision

Permanently retire Verdandi v1's generic activity/audit purpose. Continue the project
**conditionally** around one narrow capability:

> **Verdandi is Grimnir's append-only reference ledger of consequential action receipts. It binds
> an authenticated actor and authority-bearing intent to an independently observed outcome, an
> authoritative-system reference, and reversal or mitigation evidence.**

The portable product is the **Action Receipt Protocol**: versioned schemas, fixtures, middleware,
and authoritative-outcome adapter semantics. Verdandi is Grimnir's sovereign, self-hosted reference
ledger and verifier for that protocol. Integrators must not need Verdandi's database internals.

This protocol/server separation is intentional:

```text
actor or agent
    |
    v
product mutation boundary -- durable action.intent --> Verdandi/reference ledger
    |                                                    |
    v                                                    v
authoritative system ------- independent readback --> action.outcome
    |                                                    |
    +---------------- reversal / mitigation <------------+
```

Verdandi is authoritative only for the relationship:

```text
authority + intended effect -> observed effect + source reference + reversal evidence
```

It is not authoritative for the changed object. Git remains authoritative for code, Fortnox for
accounting records, providers for messages/calendar objects, Mimir/filesystems for files, Munin for
memory, and Hugin for task execution.

## Receipt contract

### Record kinds

The minimum protocol has three append-only record kinds:

1. `action.intent` — accepted before a consequential autonomous mutation.
2. `action.outcome` — appended after readback from the authoritative system.
3. `action.gap` — appended when an intent lacks timely authoritative outcome, the receipt path
   failed, or break-glass was used; later reconciliation never erases the original gap.

The accepted schema must keep these identities distinct:

- `actor_id`: authenticated tenant/workload that attempted the action;
- `principal_id`: human or named policy whose delegated authority was used;
- `authority_ref`: exact approval/grant/policy decision;
- `observer_id`: constrained adapter that read the result from the source of truth.

An action ID is a stable correlation/idempotency identifier. Content digests provide evidence but
are not the action's identity.

### Selection rule

An operation is receipt-worthy only when all three are true:

1. It changes authoritative state, sends something externally, changes identity/security posture,
   spends or commits money, deletes/restores data, or deploys/publishes executable behavior.
2. It is performed by an agent/service under delegated authority, or changes the Grimnir
   substrate's own trust/continuity controls.
3. A named consumer can block, alert, reverse, investigate, or update an autonomy decision from the
   receipt.

Human work performed directly in an authoritative system is not duplicated for completeness.

### Must record

| Action | Minimum evidence |
|---|---|
| Deploy, merge, publish, or infrastructure apply | Bounded intent, exact revision/provider ref, independent observed state, health/drift, reversal recipe |
| Security/config/ACL/key mutation | Authority, target, pre-state/snapshot ref, observed post-state, rollback or containment |
| Financial mutation | Principal authority, operation class, minimal Fortnox/provider ref, fresh readback, valid correction/mitigation; never the full financial payload |
| External send or irreversible action | Pre-action intent, minimal target ref, provider result ref, explicit mitigation rather than a fake undo |
| Delete, restore, retention, or erasure | Stores in scope, verified result per store, residual gaps, reversal or honest irreversibility |
| Autonomous rollback or recovery | Original action ref, new authority, reversal method, independently verified restored state |
| Break-glass mutation during ledger impairment | Durable local gap receipt, named authority/reason, later reconciliation outcome |

### Must not record

- prompts, responses, chain-of-thought, chats, and universal tool calls;
- reads, searches, health checks, polling, model calls, latency, tokens, or cost;
- task start/complete events without a consequential side effect;
- drafts before authoritative commit/publication;
- full diffs, messages, invoices, calendar bodies, files, credentials, or source payloads;
- post-session “decision extraction” inferred by an LLM;
- direct human provider activity with no Grimnir delegation;
- generic successful-receipt feeds, agent trust scores, or cross-session analytics.

Execution detail belongs in scoped service logs/traces and may expire independently. A receipt can
carry a `trace_id` or task reference for correlation, but remains meaningful without that trace.

## Authority and outcome rules

1. Intent must be durably accepted before the provider mutation begins.
2. The intent must bound action class, target, expected effect, authority, and reversal/mitigation.
3. Actor identity is derived server-side from authentication; caller-supplied identity is not
   trusted.
4. Outcome authority belongs to an observer-only adapter. The acting tenant cannot certify its own
   result.
5. A tool's success response is not authoritative readback.
6. Expected and actual effects use a small testable drift vocabulary: at minimum `none`, `partial`,
   `unexpected`, `unverifiable`, and `missing`.
7. Retries reuse one idempotency key. Conflicting content for the same action is rejected.
8. Rollback is a new consequential action linked to the original and verified by readback.

## Failure semantics

Verdandi is on the critical path only for **autonomous consequential mutation**:

- If intent or reversal/mitigation evidence cannot be durably accepted, the mutation fails closed.
- Reads, searches, drafts, model calls, ordinary task execution, and non-consequential work do not
  depend on Verdandi availability.
- A bounded break-glass path may be used for essential recovery. It requires named human authority,
  a durable local gap receipt, a reason, and visible later reconciliation.
- An accepted intent without timely authoritative outcome becomes an alertable gap; silence never
  becomes success.

This supersedes v1's broad fail-open ingest convention.

## Identity and access

Before activation, Verdandi must support:

- per-tenant mint/list/rotate/revoke;
- server-derived actor identity;
- separate principal, actor, and observer roles;
- action-class and role scoping;
- observer-only credentials that cannot create intents;
- historical verification across key rotation;
- tailnet-only off-Pi intake without public exposure.

Tailscale Serve may provide transport. Its identity headers are not a workload/tenant identity
system and do not replace the credential lifecycle.

## Privacy and lifecycle

- Prefer references, digests, and bounded summaries over payload copies.
- Apply conservative server-side classification floors; callers cannot downgrade them.
- Reject secrets before persistence.
- Define retention by evidence class/action domain; append-only does not mean every metadata field
  is retained forever.
- Tested erasure or crypto-shredding leaves an honest tombstone and preserves only permitted chain
  evidence.
- Receipt access never grants access to the referenced source object.
- Independent anchors contain only approved checkpoint material and are tested for metadata leakage.

Schema-level exclusion is the first privacy control. A pseudonym-key database, RFC 3161, or any
specific crypto/PKI is not preselected by this ADR.

## Integrity and continuity

The existing local hash-chain/checkpoint primitives may be reused, but a checkpoint on the same
host is not an independent anchor. Activation requires:

- complete-chain verification with tamper fixtures;
- a checkpoint retained across an independent trust boundary;
- an offline/read-only verifier independent of the running API;
- clean-room export/restore proof;
- explicit schema and generation boundaries.

Any future v2 generation permanently discloses v1 continuity as `none`. It is a new product
generation, never a restoration or continuation of the lost chain.

## Consumers

The first consumer is exception-oriented, not a stream of successful events:

- Hugin or product-local middleware blocks an unreceipted consequential mutation.
- Heimdall shows unresolved gaps, drift, failed outcomes, stale intents, anchor age, and restore
  failures only.
- Operator/rollback tooling reconstructs one action and verifies recovery.
- Periodic autonomy review examines concrete action classes, gaps, drift, and reversals; it does not
  synthesize an opaque trust score.

## Proof order

1. **Contract:** schemas, positive/negative fixtures, actor/principal/observer separation,
   idempotency, drift, privacy, and failure behavior; no genesis.
2. **Grimnir deployment adapter:** exact revision/marker readback, health, marker drift, and
   `git_revert` recovery against simulations first.
3. **Hugin + Heimdall:** consequential-mutation gate and exception-only consumer.
4. **Independent tenant/domain:** a non-Claude tenant and mocked/sandboxed noxctl/Fortnox adapter;
   no live financial mutation as validation.
5. **Product decision:** externalize protocol packages only if two independent integrations work
   without Verdandi internals and receipts change a real operating decision.

Codex owns the Harbor/Gate-D evaluation lane and gille-inference #250–#252. The ticket fleet owns
Hugin #190, then #191, then #192. Closed #183 remains a capped-window acceptance constraint for
#190 and is not reopened. These Hugin lanes use separate worktrees and must not duplicate ticket
ownership. This coordination decision is adjacent to, not implemented by, Verdandi.

## Activation gates

No implementation completion, deployment, restart, timer enablement, or new genesis is implied by
ADR acceptance. A separate owner activation review requires all of the following evidence:

1. This purpose, scope, non-goals, and failure model are owner-accepted. **Met 2026-07-14.**
2. Schemas have fixtures for every must-record class and rejection fixtures for every exclusion.
3. Tenant identity mint/list/rotate/revoke and server-derived actor tests pass.
4. Tailnet-only off-Pi intake works without public exposure.
5. Two real adapters pass end-to-end; one uses a non-Claude tenant and one independently reads an
   authoritative outcome. Financial paths may use mocks/sandbox.
6. A mutation gate demonstrably fails closed before an unaudited autonomous consequential action.
7. Heimdall or an operator CLI consumes exceptions and causes a concrete response.
8. An independently witnessed checkpoint and clean-room export/restore test pass.
9. Retention and erasure behavior is tested on the v2 schema.
10. Grimnir's service registry, architecture, tenant contract, failure-recovery convention, threat
    model, and data-lifecycle map are updated together before deployment.

Only after all gates pass may the owner separately authorize a v2 genesis. The service and
checkpoint timer remain disabled until then.

## Legacy issue disposition

| Issue | Accepted disposition |
|---|---|
| #1 — Phase 2 integrations/rubber-stamp detection | Supersede and close. Drop dwell-time scoring and generic Hugin/Telegram telemetry. Refile only narrow consequential-action adapters after ADR acceptance. |
| #2 — GDPR compliance | Rewrite around schema minimization, tested retention/erasure, classification, secret rejection, and independent anchoring. Do not preselect a pseudonym DB or RFC 3161. |
| #3 — Dashboard/analysis | Supersede and close. Replace generic widgets/analysis/extraction with an exception-only consumer after receipt evidence exists. |
| #5 — warrant-inspired rebuild | Supersede and close. Retain intent/outcome separation, final-state evidence, and content digests; reject content-hash action identity, universal intent refs, per-repo stores, leases, and a code-only model. |
| #15 — off-Pi intake/identity | Retain and rewrite for tailnet-only receipt intake plus per-tenant mint/list/rotate/revoke and observer scoping. |
| #16 — local checkpoints (closed) | Keep closed, but do not treat same-host checkpoints as independent anchoring. The independent witness remains an activation requirement. |
| #21 — purpose reset | Close only when this ADR/backlog are merged and the dispositions above are reflected on GitHub. |

## Consequences

### Positive

- Receipt volume and privacy exposure fall sharply.
- Delegated autonomy gains explicit pre-action authority and recovery evidence.
- Model/runtime choice remains replaceable because the mutation boundary owns the control.
- Source systems remain authoritative; Verdandi avoids becoming a shadow database.
- The protocol can fit other products without requiring the Verdandi server.

### Costs and risks

- Fail-closed receipt availability becomes part of consequential autonomous mutation reliability.
- Independent authoritative adapters, not storage, are the main engineering cost.
- Some providers cannot supply stable readback; unsupported actions must stay human-gated.
- Retention/erasure and append-only integrity require deliberate joint design.
- Verdandi must be retired if it becomes an unused audit ornament or telemetry sink again.

## Stop conditions

Retire or narrow Verdandi if any condition remains true for two consecutive monthly reviews:

- no receipt informs a gate, exception response, rollback, incident, or autonomy decision;
- most outcomes are assertions from the acting tenant rather than independent observations;
- integrations drift toward prompts, tool telemetry, or generic task history;
- source payload duplication or privacy exceptions become routine;
- independent anchoring/restore verification is not operational;
- integrators must understand Verdandi internals rather than the portable protocol;
- adapter/operator cost exceeds the value of the protected actions.

## Superseded v1 documents

The following remain historical implementation records but are not current product authority:

- `docs/multi-env-ingest-design.md` — universal activity taxonomy and fail-open ingest;
- `docs/offline-recovery-and-new-genesis.md` — physical recovery path declined by owner;
- `docs/checkpoints.md` — same-host/local checkpoint mechanism only;
- the generic phase roadmap formerly in `STATUS.md`.

The v1 code on `main` is hardened historical implementation, not a conforming Action Receipt
Protocol implementation. No compatibility promise is made between v1 events and any future v2
receipt schema.
