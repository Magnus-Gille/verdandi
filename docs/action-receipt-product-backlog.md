# Action Receipt Product Backlog

- **Status:** Accepted product-discovery input; individual stories are not implementation commitments
- **Decision date:** 2026-07-14
- **Authority:** [ADR-0001](adr-0001-action-receipt-ledger.md)

This bank tests whether the accepted Action Receipt Protocol can become a useful control product.
It must not be read as authorization to implement all 64 stories. Verdandi remains stopped, and the
minimum activation slice still requires a separate reviewed plan and final activation decision.

## Priorities and personas

- **P0 — proof/activation:** required before real autonomous consequential mutation.
- **P1 — operational value:** required before Verdandi earns permanence.
- **P2 — conditional expansion:** build only after observed use establishes the need.

Personas are owner/operator, acting tenant, mutation-boundary integrator, outcome-adapter author,
incident reviewer, and privacy/data steward.

“Independent outcome” means constrained authoritative readback, not a success assertion from the
acting tenant, LLM, tool call, or request/response gateway.

## 1. Selection, authority, and pre-action control

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-SEL-01 | P0 | As an integrator, I want a deterministic consequential-action rule so reads and harmless drafts bypass the ledger. | Shared fixtures classify representative operations; reads work during ledger outage. |
| AR-SEL-02 | P0 | As a tenant, I want `action.intent` durably accepted before execution so authority cannot be invented afterward. | Fault injection proves no provider write occurs after intent failure. |
| AR-SEL-03 | P0 | As an owner, I want every intent bounded by action class, target, and expected effect so vague approval cannot authorize arbitrary change. | Missing/wildcard bounds fail outside explicit policy. |
| AR-SEL-04 | P0 | As an owner, I want actor and principal/authority separate so “who acted?” and “for whom?” have distinct answers. | Both are stored and server-derived or grant-backed. |
| AR-SEL-05 | P0 | As an owner, I want a reversal recipe or honest irreversible mitigation before execution so containment is considered first. | Consequential actions lacking either are rejected. |
| AR-SEL-06 | P1 | As an owner, I want approval bound to the exact target/effect so it cannot be replayed for another action. | Changing target/effect invalidates the grant/digest. |
| AR-SEL-07 | P1 | As an integrator, I want human-directed, policy-preapproved, and fully autonomous modes so control matches delegation. | Fixtures prove distinct authority/review requirements. |
| AR-SEL-08 | P2 | As an integrator, I want domain/tool risk hints to seed classification so described tools need less configuration. | Local policy overrides hints; hints are never proof or authority. |

## 2. Authoritative outcome and drift

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-OUT-01 | P0 | As an owner, I want an observer distinct from the tenant to read back the result so the actor cannot certify itself. | Actor credentials cannot append authoritative outcomes. |
| AR-OUT-02 | P0 | As a reviewer, I want a stable source-system object/revision reference so I can inspect the authority. | Outcome contains a resolvable immutable or documented stable identifier. |
| AR-OUT-03 | P0 | As a reviewer, I want expected and actual effects compared through a small drift vocabulary so mismatch is actionable. | Fixtures cover `none`, `partial`, `unexpected`, `unverifiable`, `missing`. |
| AR-OUT-04 | P0 | As an operator, I want intents without timely outcomes to become gaps so silence cannot look like success. | Deterministic timeout creates an alertable `action.gap`. |
| AR-OUT-05 | P0 | As an integrator, I want idempotent retries so network failure cannot create multiple authorized actions. | Same key returns same action; conflicting payload is rejected. |
| AR-OUT-06 | P1 | As an adapter author, I want a canonical post-state digest without payload duplication so later drift can be checked privately. | Canonicalization fixtures are stable across equivalent provider responses. |
| AR-OUT-07 | P1 | As an operator, I want asynchronous provider writes reconciled later so queued work is not prematurely successful. | Pending becomes succeeded/failed only through adapter readback. |
| AR-OUT-08 | P2 | As a reviewer, I want batch actions decomposed per target so partial success is visible and recoverable. | Fixture identifies exact successful, failed, and unknown targets. |

## 3. Reversal, mitigation, and incident recovery

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-REC-01 | P0 | As an incident responder, I want intent, outcome, authority, and reversal evidence for one action together so reconstruction is quick. | Action-ID query returns linked chain and source refs. |
| AR-REC-02 | P0 | As an owner, I want a validated reversal vocabulary so free-text “undo” is not mistaken for recovery. | Fixtures validate `git_revert`, `snapshot_restore`, provider inverse, and `irreversible+mitigation`. |
| AR-REC-03 | P0 | As a tenant, I want rollback to be a new linked consequential action so recovery stays attributable. | Rollback creates its own intent/outcome and `reverses_action_id`. |
| AR-REC-04 | P0 | As an operator, I want reversal verified from source truth so a command is not confused with restored state. | Domain observer confirms the restored object/revision. |
| AR-REC-05 | P1 | As a responder, I want irreversible actions to expose promised mitigation so containment is immediate. | External-send fixture shows correction/notification, not fake undo. |
| AR-REC-06 | P1 | As a data steward, I want restore/erasure results per store so partial completion is explicit. | Success is impossible while one required store is unknown. |
| AR-REC-07 | P1 | As an operator, I want consequential changes since a trusted checkpoint so incident scope is bounded. | Query flags verified actions and unanchored intervals. |
| AR-REC-08 | P2 | As a responder, I want a portable evidence pack so investigation works while the live service is impaired. | Redacted export verifies offline without credentials/source payloads. |

## 4. Tenant identity and delegated authority

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-ID-01 | P0 | As an owner, I want one credential per tenant so Codex, Claude, Hugin, and domain services are distinct. | Mint/list/rotate/revoke works for two named tenants. |
| AR-ID-02 | P0 | As a reviewer, I want actor identity derived from authentication so callers cannot self-label. | Spoofed `actor_id` is rejected or ignored. |
| AR-ID-03 | P0 | As an owner, I want credentials scoped by role/action class so receipt access is not universal authority. | Cross-scope intent/outcome attempts fail. |
| AR-ID-04 | P0 | As an owner, I want immediate revocation so compromised tenants cannot create new valid intent. | New calls fail; historical receipts still verify. |
| AR-ID-05 | P1 | As a reviewer, I want stable historical identity across key rotation so old receipts remain attributable. | Keys have distinct validity windows under one tenant record. |
| AR-ID-06 | P1 | As an owner, I want principal authority separate from workload identity so delegation is explicit. | Fixtures distinguish actor, principal, and authority reference. |
| AR-ID-07 | P1 | As an adapter author, I want observer-only capability so readback components cannot authorize mutations. | Observer appends allowed outcomes but cannot create intent. |
| AR-ID-08 | P2 | As an operator, I want optional short-lived workload credentials so exposure can later be bounded without schema change. | External credential provider passes conformance without making Verdandi a PKI. |

## 5. Review, exceptions, and autonomy governance

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-REV-01 | P0 | As an operator, I want Heimdall to show only unresolved gaps, failures, drift, and integrity problems so Verdandi creates decisions, not a feed. | Normal successful receipts create no alert. |
| AR-REV-02 | P0 | As an operator, I want stale intents ranked by risk/age so dangerous ambiguity is handled first. | Seeded gaps sort deterministically. |
| AR-REV-03 | P1 | As an owner, I want one exception view linked to source/task/trace/reversal so I avoid raw-log archaeology. | One action view resolves every permitted reference. |
| AR-REV-04 | P1 | As an owner, I want exceptions resolved only by verified outcome/reversal or explicit residual-risk acceptance. | Resolution is attributable and append-only. |
| AR-REV-05 | P1 | As an owner, I want monthly review by action class/tenant so delegation changes from evidence. | Report shows gaps/drift/reversals and review decisions, not a trust score. |
| AR-REV-06 | P1 | As a component owner, I want recurrence grouped by adapter/action class so systemic defects are visible. | Consolidated issue candidate cites exact action IDs. |
| AR-REV-07 | P2 | As an owner, I want policy-change proposals from reviewed receipts so evidence improves autonomy without self-modifying policy. | Human acceptance and cited evidence are mandatory. |
| AR-REV-08 | P2 | As a reviewer, I want a scoped redacted export so a period/incident can be evaluated without broad access. | Tenant/time/class/privacy filters preserve verification. |

## 6. Privacy, retention, and data lifecycle

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-PRV-01 | P0 | As a steward, I want refs/digests/bounded summaries instead of prompts, messages, diffs, or records so no shadow store forms. | Schema/redaction tests reject representative sensitive payload fields. |
| AR-PRV-02 | P0 | As an integrator, I want conservative classification defaults so omissions never reduce protection. | Caller cannot downgrade the configured floor. |
| AR-PRV-03 | P0 | As an owner, I want secrets rejected before persistence so chaining does not make credentials hard to remove. | Seeded secrets never reach durable storage. |
| AR-PRV-04 | P0 | As a steward, I want retention by evidence class/domain so append-only does not mean eternal metadata. | Every supported class has explicit retain/expiry behavior. |
| AR-PRV-05 | P1 | As an owner/data subject, I want approved erasure/crypto-shredding with an honest tombstone so privacy and continuity can coexist. | Removed fields are unrecoverable; permitted tombstone states category/reason. |
| AR-PRV-06 | P1 | As a reviewer, I want receipt and source-object authorization separate so links cannot bypass source controls. | Receipt reader cannot dereference protected source without separate authority. |
| AR-PRV-07 | P1 | As a steward, I want export/backup to preserve classification so relocation cannot downgrade evidence. | Restore/export retains labels and access checks. |
| AR-PRV-08 | P2 | As an owner, I want anchor metadata-leakage checks so integrity proof reveals no sensitive target/timing detail. | Anchor contains only explicitly approved checkpoint material. |

## 7. Integrity, continuity, and degraded operation

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-OPS-01 | P0 | As an operator, I want complete-chain verification so corruption/discontinuity is detected before trust. | Clean passes; delete/reorder/mutate fixtures fail at the right record. |
| AR-OPS-02 | P0 | As an owner, I want an off-host witness so one Pi compromise cannot rewrite ledger and proof. | Restored ledger verifies against independently retained checkpoint. |
| AR-OPS-03 | P0 | As an operator, I want tested restoration so continuity after host loss is demonstrated. | Clean-room restore passes schema, chain, anchor, identity, query checks. |
| AR-OPS-04 | P0 | As an owner, I want consequential autonomous mutation to fail closed when intent/reversal evidence is unavailable. | Fault injection leaves provider untouched. |
| AR-OPS-05 | P0 | As an operator, I want bounded break-glass with durable local gap evidence so essential recovery is possible honestly. | Outage drill records authority/reason and visible later reconciliation. |
| AR-OPS-06 | P1 | As an operator, I want payload-free health for intake/outcomes/anchor/backup/verify so Heimdall monitors safely. | Seeded failure covers every health contract signal. |
| AR-OPS-07 | P1 | As an integrator, I want explicit schema/generation boundaries so breaking changes cannot imply continuity. | Mixed-generation verification reports boundary and never invents linkage. |
| AR-OPS-08 | P2 | As an operator, I want offline verification independent of the API so a compromised app is not sole verifier. | Small read-only verifier detects tampered DB/export fixtures. |

## 8. Developer experience and integration

| ID | Pri | Story | Acceptance signal |
|---|---:|---|---|
| AR-DEV-01 | P0 | As an integrator, I want versioned JSON Schemas and fixtures so products implement the protocol without Verdandi internals. | Two independent implementations pass common fixtures. |
| AR-DEV-02 | P0 | As an integrator, I want small TypeScript middleware so intent-before-write/outcome-after-readback ordering is hard to misuse. | Reference fake-provider flow proves every failure path. |
| AR-DEV-03 | P0 | As an adapter author, I want actor/observer SDK capabilities separate so convenience cannot collapse trust. | Actor-only client cannot append authoritative outcome. |
| AR-DEV-04 | P0 | As a product owner, I want a fake-provider conformance harness so fail-closed/idempotency/drift/reversal are proven without external mutation. | Harness runs locally and touches no real provider. |
| AR-DEV-05 | P1 | As an MCP host integrator, I want tool annotations to seed risk selection without treating hints as proof. | Missing/dishonest hints default cautiously and local policy wins. |
| AR-DEV-06 | P1 | As an observability integrator, I want trace correlation without trace ingestion so execution detail stays elsewhere. | Receipt remains meaningful after trace expiry. |
| AR-DEV-07 | P2 | As a platform integrator, I want optional CloudEvents transport so brokers can carry receipts without defining semantics. | Envelope round-trip preserves receipt; envelope fields never confer authority. |
| AR-DEV-08 | P2 | As a security integrator, I want optional signed-statement envelopes so higher-risk deployments add authenticity without mandatory PKI. | Signature layer is independent of business semantics. |

## Explicit anti-stories

Reject or route elsewhere requests to:

1. capture every prompt, completion, reasoning token, tool call, read, or task lifecycle event;
2. make Verdandi the source of truth for external objects;
3. copy full messages, invoices, files, calendar bodies, or diffs;
4. let the LLM/acting tenant decide whether its action succeeded;
5. treat successful HTTP response as authoritative post-state;
6. copy all human provider activity for completeness;
7. build a real-time feed of every successful receipt;
8. compute an opaque agent trust score;
9. gate reads, drafts, or harmless work on Verdandi availability;
10. claim legal/regulatory compliance merely because data is chained;
11. bundle a workflow runtime, policy engine, SIEM, or observability platform;
12. start a v2 genesis before every activation gate and separate owner review.

## Minimum activation backlog

The smallest defensible slice is:

- AR-SEL-01–05;
- AR-OUT-01–05;
- AR-REC-01–04;
- AR-ID-01–04 and AR-ID-07;
- AR-REV-01–02;
- AR-PRV-01–04;
- AR-OPS-01–05;
- AR-DEV-01–04.

P1/P2 work must not delay the vertical proof or create a platform before use exists.

## Grimnir product fit

| Product | Integration boundary | Outcome source | Position |
|---|---|---|---|
| Grimnir deploy tooling | Apply service/config revision | Exact marker, file digest, health, Git SHA | First adapter; strongest existing reversal/readback primitives. |
| Hugin | Consequential mutation gate | Domain adapter, never task success alone | Core protocol middleware. |
| Heimdall | Read-only exception consumer | Verdandi gap/verify health | First consumer; exceptions only. |
| noxctl/Fortnox | Financial create/update/book/send/correct | Fresh Fortnox object readback | Second domain under mocks/sandbox first; minimal refs only. |
| Brokkr | Host/config/storage/ACL/key mutation | Host/provider state and snapshots | Strong later operational adapter. |
| Mimir | Future delete/restore/access mutation | Filesystem metadata/digest | Future fit; current reads bypass Verdandi. |
| Ratatoskr | External send or routed consequential command | Provider message/domain result | Privacy-sensitive; no message ingestion. |
| Munin | Destructive correction/erasure/security change | Fresh memory/history ref | Very narrow selection; never every memory write. |
| M5 gateway | Admin/model/routing/key mutation | Gateway/admin state/artifact digest | Admin plane only; inference telemetry stays elsewhere. |

## External product fit

Strong embedding categories are MCP tool gateways, agent SDK middleware, coding/DevOps agents,
finance/RPA connectors, SaaS admin planes, IT/infrastructure operations, personal assistants,
data-lifecycle tooling, and physical/IoT control. The protocol belongs at each product's mutation
boundary; authoritative adapters are the differentiator.

CloudEvents may be an optional envelope, OpenTelemetry IDs may correlate traces, policy-decision
logs may supply `authority_ref`, and build attestations may be linked as provenance. None replaces
receipt selection, actor/principal identity, independent post-state readback, or reversal evidence.

Do not position Verdandi as a generic audit-log SaaS. If two independent internal integrations
prove value, the preferred packaging is:

```text
@action-receipts/schema
@action-receipts/client
@action-receipts/middleware
@action-receipts/adapter-sdk
verdandi              # sovereign reference ledger/verifier
verdandi-verify       # offline verifier
```

## Success and kill criteria

Measure timely authoritative outcomes, gap age, drift, verified reversals, reconstruction time,
receipts used in real decisions, privacy/lifecycle tests, false-positive burden, and adapter cost.

Apply ADR-0001's stop conditions after two monthly reviews. Collection volume is never a success
metric.
