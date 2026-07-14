# Multi-environment ingest coverage: the minimal seam

> **Historical v1 document — superseded by
> [ADR-0001](adr-0001-action-receipt-ledger.md).** Do not implement this document's universal
> Hugin/Telegram/task telemetry or broad fail-open ingestion model. Any future integration must use
> the accepted consequential-action selection rule, durable pre-action intent, constrained
> authoritative readback, and fail-closed boundary defined by ADR-0001.

Design doc for issue #10. Scope: design (not build) the ingest path for the
two highest-value emitters beyond the laptop — **hugin** (Pi-side task
execution) and **ratatoskr** (Telegram concierge). Desktop/Web/Mobile Claude
sessions and other server-side components are named in the issue as part of
the wider gap but are explicitly out of scope for this ticket; see
[Non-goals](#non-goals).

## 1. Current reality (verified 2026-07-03)

Verdandi has exactly one live emitter today: the laptop's Claude Code
`PostToolUse`/`PermissionRequest` hook, which posts to `POST /api/events/hook`
(`src/server.ts:74`, `src/ingest.ts:115-131`). That endpoint is intentionally
shaped around Claude Code's hook payload (`tool_name`, `hook_event_name`,
`tool_input`, …) — `transformHookPayload()` (`src/ingest.ts:263-314`) maps a
fixed set of tool names to Verdandi event types and drops everything else.

The important finding for this design: **the generic ingest path is already
emitter-agnostic** and does not need new pipeline code to accept hugin or
ratatoskr events.

- `POST /api/events` (`src/server.ts:43`) accepts any well-formed event from
  any authenticated component — it is not Claude-Code-specific. Only
  `/api/events/hook` is.
- Auth (`src/auth.ts`) is per-component and open-ended: `registerApiKey(db,
  component, scopes)` accepts any component name; nothing hardcodes
  `claude-code` as special at the auth layer.
- Classification (`src/classification.ts:63-91`) already contains
  component-aware rules for both target emitters:
  ```ts
  if (component === 'hugin' && eventType.startsWith('task.')) return 'mechanism';
  if (component === 'ratatoskr' && eventType.startsWith('telegram.')) return 'mechanism';
  ```
  These branches predate this ticket but were **untested and unused** — no
  component named `hugin` or `ratatoskr` had ever registered a key or posted
  an event. This PR adds test coverage proving they behave as designed (see
  §7) and a small `src/event-types.ts` module that gives them a documented,
  canonical set of event types to use.

So the "minimal seam" is mostly already present in the schema and
classification layer. What's actually missing is:

1. Registered API keys for `hugin` and `ratatoskr` in the production DB.
2. A documented, agreed event-type vocabulary for each (this doc + `src/event-types.ts`).
3. Emitter-side code in the hugin and ratatoskr repos to call Verdandi (out of
   scope here — cross-repo work goes through a ticket in each of those repos,
   per the repo-ownership convention).
4. A failure-handling story for when Verdandi is unreachable from the Pi
   (outbox pattern, §6) — today this exists only as an ad hoc laptop-side
   script and isn't generalized.

## 2. Why hugin and ratatoskr first

Per the issue: these two cover most autonomous mutations that currently have
*zero* audit trail.

- **hugin** dispatches and runs tasks on the Pi with no human in the loop
  once submitted — task execution is exactly the kind of "what did the agent
  do while I wasn't watching" record Pillar 1 exists for.
- **ratatoskr** is the Telegram concierge — it acts on inbound messages and
  can trigger mutations (bookings, sends, task submissions) from a channel
  that has no other record at all today.

Both already have a `component` identity anticipated in `classification.ts`,
which is a strong signal they were the intended first extension point.

## 3. Event format

No new envelope. Emitters send the same event shape the laptop hook produces
after transformation — the shape `validatePayload()` requires
(`src/ingest.ts:207-256`):

```jsonc
{
  "event_type": "task.execution.complete",   // ^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,4}$
  "severity": "routine",                      // critical | significant | routine | debug
  "action": {
    "verb": "execute",
    "resource_type": "task",
    "resource_id": "task-2026-0417",
    "detail": "ran hugin.deploy.verdandi, exit 0, 43s"
  },
  "actors": [
    { "actor_id": "magnus", "actor_type": "human", "role": "initiator" },
    { "actor_id": "hugin", "actor_type": "agent", "role": "executor" }
  ],
  "trace": {
    "trace_id": "…",        // see §5 correlation
    "session_id": "…",
    "originating_environment": "pi-hugin"
  }
}
```

Fields the server always overrides regardless of what's sent: `component`
(from the API key), `retention_class`, `evidence_grade`,
`data_classification.erasure_eligible`. `event_id` and `timestamp` are
defaulted only if absent from the payload — if an emitter supplies them
(e.g. replaying from an outbox, §6) they're kept as-is. The DB's
`server_timestamp` column is always computed fresh server-side for
ordering regardless of payload content, but emitters should still omit a
`server_timestamp` field from the payload itself — nothing strips a
client-supplied one out of the stored payload blob, it's just ignored for
authority purposes.

Emitters don't need to compute any of these — they only need `event_type`,
`severity`, and `action`.

### 3.1 Event-type vocabulary

Added in `src/event-types.ts` (with test coverage in
`test/event-types.test.ts`) as the canonical taxonomy these two emitters
should target:

| Component | Event type | Severity (suggested) | Retention (computed) | Evidence grade (computed) |
|---|---|---|---|---|
| hugin | `task.execution.start` | routine | operational | mechanism |
| hugin | `task.execution.complete` | routine | operational | mechanism |
| hugin | `task.execution.fail` | significant | operational | mechanism |
| hugin | `task.execution.timeout` | significant | operational | mechanism |
| ratatoskr | `telegram.message.received` | debug | debug | mechanism |
| ratatoskr | `telegram.action.execute` | routine | operational | mechanism |
| ratatoskr | `telegram.decision.escalate` | significant | operational | mechanism |

Retention and evidence grade are never chosen by the emitter — they fall out
of the existing `classifyRetention`/`assignEvidenceGrade` rules given
`event_type` + `component` + `severity`. The table above is what those rules
currently produce for each type; it's descriptive, not a new rule set. If a
future event type needs `critical` severity (e.g. a task that touches money
or an escalation that bypasses the human), `classifyRetention` already
promotes it to `security` retention with no change needed.

`telegram.decision.escalate` deliberately does **not** use the `decision.*`
prefix even though it's a decision point, because `decision.*` is graded
`convention` (voluntary, human-authored) in `assignEvidenceGrade`, whereas an
automatic escalation triggered by ratatoskr is mechanism-captured. Using
`telegram.*` keeps the evidence grade honest about how the record was
produced. If ratatoskr later needs to record the human's actual decision
(not just that escalation happened), that's a separate `decision.*` event
emitted by whatever the human used to decide (e.g. the laptop hook), not by
ratatoskr.

## 4. Auth

No new mechanism — reuse `registerApiKey`/CLI exactly as-is:

```bash
npx tsx src/index.ts register-key hugin write
npx tsx src/index.ts register-key ratatoskr write
```

Each gets its own `vrd_hugin_<hex>` / `vrd_ratatoskr_<hex>` key, requested
with `write` scope only since neither needs `read` or `admin`. Scope checks
are enforced: ingest requires `write` or `admin`, while event queries and
chain verification require `read` or `admin`. Per-component key separation
still provides the authenticated component identity used at ingest. Two
sub-decisions this doc flags rather than resolves:

- **Secret storage on the Pi.** The laptop convention is macOS Keychain via
  `security find-generic-password`; the Pi has no Keychain equivalent. The
  hugin/ratatoskr repos need to pick a Pi-appropriate store (e.g. a
  root-owned file under `/etc/grimnir/`, or systemd `LoadCredential=`) —
  this is an implementation decision for those repos, not Verdandi.
- **One key per component, not per instance.** If hugin or ratatoskr ever run
  as multiple processes/replicas, they'd share one component key; per-process
  identity would have to come from a field inside the event (e.g.
  `actors[].actor_id`), not from auth. Fine for the current single-Pi
  deployment; worth revisiting if that changes.

## 5. Trace correlation across emitters

A single user-facing action can span emitters — e.g. a Telegram message
(ratatoskr) triggers a task submission that hugin later executes. Verdandi
already denormalizes `trace_id`, `session_id`, and `parent_event_id` onto
every row (`src/db.ts:71-74`) precisely for this. The seam this design
recommends: whichever component originates the chain mints a `trace_id`
(a UUID is fine) and passes it downstream through whatever channel already
carries the request (Munin task record, task queue payload, etc.) so every
hop's Verdandi event carries the same `trace_id`. This is a convention for
emitters to follow, not new Verdandi code — `GET /api/events?trace_id=…`
already supports querying by it.

## 6. Failure handling — the outbox pattern

Verdandi fails open for operations (per CLAUDE.md's design principles): a
task or Telegram action must never block or fail because the audit POST
failed. That means every emitter needs a local outbox, not just a
best-effort fire-and-forget POST.

The laptop already has an informal version of this (referenced in issue #9):
a hook-side script appends to a local outbox file when the live POST to
Verdandi fails, and a separate `sync-outbox.sh` periodically flushes the
backlog to `/api/events/batch`. Issue #9 found that script currently broken
(it batches raw hook-format events against an endpoint that expects
full-format events) — that's tracked and fixed there, not here. What this
design borrows from it is the *pattern*, generalized:

1. **Try the live POST first.** `POST /api/events` (single event, not
   `/hook` — hugin/ratatoskr emit full-format events directly, no
   transform needed) with a short timeout (≈2s is plenty for a loopback/
   Tailscale call).
2. **On any failure** (network error, non-2xx, timeout) **append the
   already-fully-formed event JSON to a local append-only outbox file**, one
   JSON object per line. Never block the caller on this — an audit gap is
   logged and alertable, but the task/action itself proceeds
   (fail-open for operations, fail-loud for audit).
3. **A periodic flush job** (cron/systemd timer, analogous to
   `sync-outbox.sh`) reads the outbox, chunks it into batches of ≤1000
   (the existing `MAX_BATCH_SIZE` in `src/ingest.ts:22`), and POSTs each
   chunk to `/api/events/batch`. Because step 2 already stored full-format
   events (not hook-shaped ones), no server-side transform is needed —
   this sidesteps the exact bug issue #9 found in the laptop script.
4. **Idempotency is handled server-side**: `event_id` is
   client-supplied-or-generated and UNIQUE. `AppendWorker.appendOne()` checks
   for an existing `event_id` before inserting. An exact repeated delivery
   returns the original row's position/hash as success; reuse with different
   canonical content returns `409` so an audit collision cannot masquerade as
   a recorded action. An emitter should generate `event_id` itself (a UUID)
   before the first POST attempt and reuse the same full event on replay. It
   should also keep its advisory timestamp stable when supplying one; if the
   first delivery omitted it, Verdandi reuses its stored timestamp when
   comparing an exact retry.
5. **Cap the outbox size** (mirror the laptop's `MAX_OUTBOX_LINES`) and
   alert — don't drop silently — if the cap is hit, since an uncapped outbox
   on a Pi with limited storage is its own failure mode.

This is entirely emitter-side logic (hugin/ratatoskr repos); Verdandi's only
obligation is what it already provides: `/api/events/batch` accepting
full-format events up to 1000 per call, and idempotent `event_id` handling.

## 7. What this PR changes in Verdandi itself

Per the ticket's guidance to keep this a design ticket with at most a tiny
concretizing change:

- `src/event-types.ts` — the canonical event-type constants from §3.1, so
  hugin/ratatoskr implementations (and this doc) have one source of truth
  instead of a taxonomy that only lives in prose.
- `test/event-types.test.ts` — end-to-end `IngestPipeline` tests proving a
  `hugin`-keyed event using `HUGIN_EVENT_TYPES` and a `ratatoskr`-keyed event
  using `RATATOSKR_EVENT_TYPES` land with the evidence grade and retention
  class this doc claims (`mechanism`/`operational`, `mechanism`/`debug`).
- `test/ingest.test.ts` — two additional unit tests locking down the
  previously-untested `assignEvidenceGrade` branches for `hugin`/`task.*`
  and `ratatoskr`/`telegram.*`.

No changes to `server.ts`, `auth.ts`, `classification.ts`, or the DB schema —
the seam already existed; it just had no traffic and no tests.

## 8. Incremental rollout plan

1. **This PR** — design doc + canonical event types + regression tests
   (done here).
2. **Register production keys**: `register-key hugin write` and
   `register-key ratatoskr write` on the Pi Verdandi instance; hand the raw
   keys to the hugin/ratatoskr owning agents via their respective repos
   (never commit them).
3. **hugin**: file a ticket in the hugin repo (per repo-ownership
   convention) to add a small emitter — POST + outbox-on-failure per §6 —
   around task start/complete/fail/timeout using `HUGIN_EVENT_TYPES`. Land
   it behind a flag or dry-run mode first so a bug in the emitter can't
   affect task execution (fail-open).
4. **ratatoskr**: same pattern, ticket in the ratatoskr repo, emitting
   `RATATOSKR_EVENT_TYPES` for inbound messages and concierge actions.
5. **Verify coverage**: once both are live, confirm via
   `GET /api/events?component=hugin` / `component=ratatoskr` that events are
   actually flowing, and cross-check `GET /api/verify` chain integrity
   still holds under concurrent writers (the append worker already
   serializes writes — `src/hash-chain.ts` — so multiple emitting
   components is already a supported case, just not yet an *exercised*
   one).
6. **Dashboard**: surface per-component ingest health in heimdall (last
   event timestamp per registered component; alert if a component that
   should be emitting has gone quiet) — this is the "fail-loud for audit"
   half of the principle; nothing today alerts on an emitter going dark.
7. **Revisit remaining gaps**: Desktop/Web/Mobile Claude sessions and other
   server-side components (named in the issue, out of scope here) become
   the next candidates once hugin/ratatoskr are live and the pattern is
   proven.

## Non-goals

- Desktop/Web/Mobile Claude Code ingest — no local hook mechanism exists in
  those environments (per CLAUDE.md's environment table, they have no local
  filesystem/git access either), so this needs a genuinely different
  ingest path (likely server-side, initiated by Munin or another
  always-on component) and is left for a follow-up ticket.
- Any code changes in the hugin or ratatoskr repos — per repo ownership,
  those land as tickets filed against those repos, not edits here.
- Fixing the existing `sync-outbox.sh` / severity-taxonomy / GET-auth issues
  from issue #9 — tracked and resolved there.
