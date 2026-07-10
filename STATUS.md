# Verdandi — Project Status

**Last session:** 2026-07-10 (Codex recovery preparation)
**Branch:** `codex/verdandi-offline-recovery` (isolated worktree; not deployed)

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
- No production data, service state, deployment, or remote branch was changed.

## Current blocker

- Physical access is required to shut down huginmunin, remove its SD card, and
  acquire a read-only master image on a Linux recovery host.

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
- Deployed to Pi (huginmunin:3036), systemd managed, auto-restart
- Claude Code hooks wired (PostToolUse + PermissionRequest)
- API keys registered for all 6 Grimnir components
- Grimnir services.json updated — commit `14dc1f7` (verdandi), `6a620ba` (grimnir)
- PR #17 for issue #16 merged as `3ae7d3c` after lint, build, tests, review, and green GitHub checks.

## In Progress
- Deploy and enable `verdandi-checkpoint.timer` on huginmunin.

## Blockers
- None

## Next Steps (Phase 2 scope)
1. Deploy and enable `verdandi-checkpoint.timer` on huginmunin.
2. Rubber-stamp detection (dwell-time scoring algorithm, alerting via Telegram)
3. Noxctl native integration (emit events on Fortnox API calls directly)
4. Hugin integration (emit task lifecycle events)
5. Ratatoskr integration (emit Telegram command events)
6. Outbox sync automation (launchd on laptop for periodic flush)

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
