# Verdandi — Project Status

**Last session:** 2026-04-03
**Branch:** main

## Completed This Session
- Phase 1 landscape research (Hugin task, 40+ frameworks, 90+ sources) — `audit-log-landscape-research.md`
- Phase 2 architecture proposal (Hugin task, 2100 lines) — `audit-log-architecture-proposal.md`
- Adversarial review: Claude vs Codex, 2 rounds, 28 critique points
- Phase 2.5 ingest-trust specification (Hugin task, 1949 lines) — `verdandi-ingest-trust-spec.md`
- MVP implementation: 8 source modules, 28 tests passing
- Deployed to Pi (huginmunin:3036), systemd managed, auto-restart
- Claude Code hooks wired (PostToolUse + PermissionRequest)
- API keys registered for all 6 Grimnir components
- Grimnir services.json updated — commit `14dc1f7` (verdandi), `6a620ba` (grimnir)

## In Progress
- Nothing actively in progress

## Blockers
- None

## Next Steps (Phase 2 scope)
1. Rubber-stamp detection (dwell-time scoring algorithm, alerting via Telegram)
2. Noxctl native integration (emit events on Fortnox API calls directly)
3. Hugin integration (emit task lifecycle events)
4. Ratatoskr integration (emit Telegram command events)
5. Outbox sync automation (launchd on laptop for periodic flush)
6. Per-component API key scoping (read vs write separation)

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
