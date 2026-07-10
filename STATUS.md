# Verdandi — Project Status

**Last session:** 2026-07-10 (status reconciliation after recovery PR merge)
**Branch:** `main` (canonical checkout current through `532677d` / PR #18)

## Current state

- PR #18 merged as `532677d`, landing the evidence-safe offline recovery
  tooling, canonical production-storage contract, and fail-closed generation
  gate. The canonical checkout is current with `origin/main`.
- Verdandi production remains intentionally inactive and undeployed while the
  original database recovery is pending. Do not start `verdandi.service`,
  enable `verdandi-checkpoint.timer`, or initialize a new production genesis
  before the bounded recovery attempt and an explicit recovery decision.
- Grimnir's persistent-data deployment guard is live, preventing future
  service deploys from silently deleting untracked persistent data.
- The M5 recovery toolchain and protected workspace are ready, with
  approximately 1.46 TiB free for the SD-card image and recovery output.

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
  before acceptance. Validation: 88 tests, build,
  lint, and diff checks pass.
- PR #18 merged as `532677d`; none of its recovery tooling has been deployed
  and no production data or service state was changed.

## Completed This Session
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
- Awaiting the physical recovery window: cleanly shut down huginmunin, connect
  its original boot SD to the M5 reader, and run the bounded image-first
  recovery procedure.

## Blockers
- Physical access to huginmunin's original boot SD is required. The blocker is
  limited to a clean shutdown and connecting that card to the prepared M5
  recovery reader/workspace.

## Next Steps (Phase 2 scope)
1. Cleanly shut down huginmunin and connect its original boot SD to the M5
   reader without starting or writing to the card.
2. Acquire the protected master image and run the four-hour-bounded recovery
   procedure from `docs/offline-recovery-and-new-genesis.md`.
3. Validate any recovered candidate read-only, then explicitly decide whether
   to adopt it or authorize a new genesis. Until that decision, do not start
   the service, enable checkpointing, deploy Verdandi, or initialize genesis.
4. After recovery/adoption is complete, deploy the merged safeguards, start
   Verdandi, verify production health and generation state, then enable
   `verdandi-checkpoint.timer`.
5. Rubber-stamp detection (dwell-time scoring algorithm, alerting via Telegram)
6. Noxctl native integration (emit events on Fortnox API calls directly)
7. Hugin integration (emit task lifecycle events)
8. Ratatoskr integration (emit Telegram command events)
9. Outbox sync automation (launchd on laptop for periodic flush)

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
