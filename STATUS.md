# Verdandi — Project Status

**Last session:** 2026-07-13 (bounded hardening implementation; no deployment)
**Branch:** `codex/verdandi-hardening-20260713` (based on current `origin/main` at `91e5cb6`)

## Current state

- The local hardening branch adds safer secret redaction, collision-safe
  idempotency, bounded read parameters, snapshot-consistent verification, and
  commit-before-anchor ordering. It is intentionally not pushed or deployed.
- `origin/main` at `91e5cb6` includes PR #18's evidence-safe offline recovery
  tooling, canonical production-storage contract, and fail-closed generation
  gate. These current safeguards have not been deployed.
- The old MVP installation remains on huginmunin. On 2026-07-10 its
  `verdandi.service` was live-verified disabled and inactive, and
  `verdandi-checkpoint.timer` was absent/inactive; the service will not
  auto-start on reboot. Its installed unit still has `Restart=always`, so do
  not start it manually before recovery is complete.
- Verdandi production remains intentionally inactive while the original
  database recovery is pending. Do not deploy Verdandi, start its service,
  enable checkpointing, adopt a database candidate, or initialize a new
  production genesis before the bounded recovery attempt and an explicit
  recovery decision.
- Grimnir PR #74, merged as `a3eb01f`, is deployed. Its fail-closed
  persistent-data guard prevents service deploys from silently deleting
  untracked persistent data.
- The M5 recovery toolchain and protected workspace are ready. The known
  source card is approximately 63.3 GB; the M5 had approximately 1.46 TiB free
  on 2026-07-10, ample for the protected master image, working image, and
  recovery output.

## 2026-07-13 bounded hardening

- Sensitive structured fields now keep their names but replace their values;
  textual redaction also covers JSON-encoded credentials and component names
  containing hyphens/digits. Error strings are redacted before API/CLI output.
- Exact repeated delivery remains idempotent, including when Verdandi supplied
  the advisory timestamp. Reuse of an `event_id` with different canonical
  content now returns a conflict instead of silently claiming success.
- Event-query pagination/date bounds and incremental verification boundaries
  fail closed on malformed input. Hash-chain verification runs on one SQLite
  read snapshot for deterministic results under concurrent external appends.
- Checkpoint rows commit before an anchor is atomically published, so a failed
  commit can never leave an anchor for a rolled-back row. An anchor-write
  failure remains loud while preserving the committed verified checkpoint.
- Validation: 107 tests, lint, build, explicit no-emit typecheck, production
  dependency audit, and full dependency audit pass; npm reports 0 vulnerabilities.

## 2026-07-10 recovery preparation

- Live read-only evidence found the service inactive after `226/NAMESPACE`,
  with no Verdandi DB/WAL/SHM on huginmunin's mounted filesystems or the NAS.
- The live `.env` placed runtime data at
  `/home/magnus/repos/verdandi/data`; Grimnir rsync deploy uses `--delete` and
  did not preserve that directory. The 2026-07-08 deploy is the likely loss
  mechanism, though no retained deployment log proves causality.
- Prepared an image-first, four-hour-bounded ext4 recovery/new-genesis runbook,
  a read-only candidate inspector, and tests enforcing canonical production
  storage at `/home/magnus/.local/share/verdandi`.
- Production startup/checkpointing now validate an existing nonempty DB, strict
  generation metadata + adopted head, supported critical schema, full event
  chain, and claimed-valid checkpoint history. New DB creation is isolated in
  the explicit `init-new-generation` command.
- Formal PR review follow-up also makes recovery acceptance depend on unchanged
  source evidence, reports unvalidated external-anchor presence separately,
  and uses a pipefail-safe inspection pipeline. A follow-up runtime-SQL audit
  now validates every supported table column/default/PK, all indexes/foreign
  keys, and prepares representative server/auth/append/checkpoint statements
  before acceptance. The original PR validation passed 88 tests, build, lint,
  and diff checks; the later hardening validation is recorded above.

## Earlier completed work
- Added a Verdandi checkpoint command for issue #16: verifies the hash chain,
  records the current verified head in `checkpoints`, and optionally writes a
  local JSON anchor.
- Added daily systemd timer/service templates for checkpoint cadence.
- Added checkpoint tests for verified heads, local anchors, empty chains, and
  tamper detection.
- Phase 1 landscape research (Hugin task, 40+ frameworks, 90+ sources) — `audit-log-landscape-research.md`
- Phase 2 architecture proposal (Hugin task, 2100 lines) — `audit-log-architecture-proposal.md`
- Adversarial review: Claude vs Codex, 2 rounds, 28 critique points
- Phase 2.5 ingest-trust specification (Hugin task, 1949 lines) — `verdandi-ingest-trust-spec.md`
- MVP implementation: 8 source modules, 28 tests passing
- Initial MVP was previously deployed to Pi (huginmunin:3036) under systemd;
  the service is now intentionally inactive during recovery.
- Claude Code hooks wired (PostToolUse + PermissionRequest)
- API keys registered for all 6 Grimnir components
- Grimnir services.json updated — commit `14dc1f7` (verdandi), `6a620ba` (grimnir)
- PR #17 for issue #16 merged as `3ae7d3c` after lint, build, tests, review, and green GitHub checks.

## In Progress
- Awaiting a coordinated physical recovery window: cleanly shutting down
  huginmunin also interrupts its co-hosted services. The original boot SD must
  then be connected to the M5 reader for the bounded image-first recovery.

## Blockers
- Recovery requires physical access plus a coordinated huginmunin outage so
  its original boot SD can be moved to the prepared M5 recovery
  reader/workspace without an unsafe shutdown or source-card write.

## Next Steps (recovery gate only)
1. Coordinate the outage for huginmunin's co-hosted services, cleanly shut the
   host down, remove its original boot SD, and insert the card into the M5
   reader. Immediately unmount any automounted partitions, set the whole
   source device read-only, and verify it with `blockdev --getro` per the
   runbook before imaging. Never boot from the source card.
2. Acquire the protected master image and run the four-hour-bounded recovery
   procedure from `docs/offline-recovery-and-new-genesis.md`.
3. Validate any recovered candidate read-only and record an explicit decision
   to adopt it or authorize a new genesis. Do not execute either path yet.
4. Deploy PR #18's recovery and generation safeguards from current `main`.
5. Under those deployed safeguards, either adopt the accepted candidate or,
   only if explicitly authorized, run `init-new-generation`. Then start
   Verdandi and verify production health, generation state, and hash-chain
   integrity. Enable `verdandi-checkpoint.timer` last.

## Deferred roadmap (not part of the hardening sprint)

- Rubber-stamp detection (dwell-time scoring algorithm, alerting via Telegram)
- Noxctl native integration (emit events on Fortnox API calls directly)
- Hugin integration (emit task lifecycle events)
- Ratatoskr integration (emit Telegram command events)
- Outbox sync automation (launchd on laptop for periodic flush)

## Phase 3 scope (later)
- GDPR pseudonymization (verdandi-keys.db)
- RFC 3161 daily checkpoints
- Erasure workflow
- LIA documentation

## Phase 4 scope (later)
- Heimdall dashboard widget
- Skuld briefing integration
- Cross-session analysis
- Post-session decision extraction
