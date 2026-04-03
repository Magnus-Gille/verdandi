# Verdandi — Audit Log for Agentic Actions

Verdandi is the accountability layer of the Grimnir ecosystem. It records what agents did, what humans decided, and the reasoning behind both — with tamper-evident storage, GDPR compliance, and rubber-stamp detection.

Named after the Norn of the present in Norse mythology — she weaves what is becoming.

## Architecture

Verdandi is a standalone Fastify service (port 3036) with a SQLite backend. It runs on Pi 1 (huginmunin) alongside other Grimnir services. It is a **peer** to Munin (memory), not a layer within it.

### Design documents (read these for full context)

All in `~/mimir/grimnir/research/`:
- `audit-log-landscape-research.md` — Phase 1: survey of 40+ frameworks across 6 domains
- `audit-log-architecture-proposal.md` — Phase 2: full architecture with schemas, DDL, API design
- `verdandi-ingest-trust-spec.md` — Phase 2.5: precise ingest pipeline and trust model spec
- `debate/verdandi-arch-summary.md` — Adversarial review (Claude vs Codex, 28 critique points)

### Key design principles

1. **Server-authoritative.** Verdandi recomputes all derived fields (timestamp, retention_class, component identity, hash chain). Client-supplied values are advisory, overridden at ingest.
2. **Honest about limitations.** Two evidence grades: `mechanism` (automatic hooks, proven) and `convention` (voluntary checkpoints, unverified completeness).
3. **Fail-open for operations, fail-loud for audit.** Verdandi never blocks business operations. But every gap in the audit trail is recorded and alerted.
4. **Redact before persist.** Secrets are stripped at intake before any write to any layer.

## Project structure

```
src/
  index.ts          — Entry point + CLI commands (register-key, verify, serve)
  server.ts         — Fastify HTTP server (health, write, read, verify APIs)
  ingest.ts         — 10-stage ingest pipeline
  hash-chain.ts     — SHA-256 hash chain with single append worker
  canonical.ts      — RFC 8785 JSON Canonicalization
  redaction.ts      — Secret redaction pipeline (14 rules)
  classification.ts — Server-side retention + evidence grade assignment
  auth.ts           — Per-component API keys
  db.ts             — SQLite schema with migrations (WAL mode)
test/
  ingest.test.ts    — Unit + integration tests
```

## Tech stack

- TypeScript (ESM, strict, NodeNext)
- Fastify 5
- better-sqlite3 (WAL mode)
- vitest for testing
- No external runtime dependencies beyond Fastify and SQLite

## Commands

```bash
npm run build          # TypeScript → dist/
npm run dev            # Dev server with tsx watch
npm run test           # Run vitest
npm start              # Production server

# CLI
npx tsx src/index.ts register-key <component> [scopes]   # Register API key
npx tsx src/index.ts verify                               # Verify hash chain
```

## API endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Service health + event count |
| POST | `/api/events` | Bearer | Ingest single event |
| POST | `/api/events/batch` | Bearer | Ingest batch (max 1000) |
| POST | `/api/events/hook` | Bearer | Ingest Claude Code hook payload |
| GET | `/api/events` | No | Query events (filters: trace_id, event_type, component, severity, session_id, since, until) |
| GET | `/api/events/:eventId` | No | Get single event |
| GET | `/api/verify` | No | Verify hash chain integrity |

## Ingest pipeline (10 stages)

Every event passes through these stages in order:
1. **Authentication** — reject invalid key, derive component identity
2. **Validation** — schema check, size limits, required fields
3. **Redaction** — strip secrets from all string fields
4. **Field override** — server sets component, timestamp, event_id
5. **Classification** — compute retention_class and evidence_grade server-side
6. **Canonicalization** — RFC 8785 deterministic JSON
7. **Queue** — enqueue for single append worker
8. **Atomic append** — BEGIN IMMEDIATE, read chain head, hash, INSERT, COMMIT
9. **Idempotency** — event_id UNIQUE constraint, return existing on duplicate
10. **Layer 3 write** — optional encrypted debug payload

## Event taxonomy

Hierarchical: `accounting.*`, `email.*`, `calendar.*`, `file.*`, `memory.*`, `task.*`, `telegram.*`, `agent.*`, `decision.*`, `system.*`

## Severity and retention

| Severity | Description | Example threshold |
|----------|-------------|-------------------|
| critical | Hard stop, justification required | > 20,000 SEK |
| significant | Active review required | 2,000 - 20,000 SEK |
| routine | Batch review OK | < 2,000 SEK |
| debug | No review needed | Tool calls, reads |

| Retention class | Period | Erasure eligible |
|-----------------|--------|:---:|
| accounting | 7 years | No (Bokföringslag) |
| security | 12 months | Yes |
| operational | 6 months | Yes |
| debug | 1-3 months | Yes |

## Debate critique resolutions implemented

- **C01**: RFC 8785 canonical JSON (not broken JSON.stringify)
- **C02**: Single append worker with atomic transactions
- **C04/C18**: Per-component API keys, server-derived identity
- **C06**: Idempotency via event_id UNIQUE
- **C09**: Server-side retention classification
- **C20**: Mandatory redaction pipeline
- **C25/C27**: Two evidence grades (mechanism/convention)

## Deployment

- **Port:** 3036
- **Host:** 127.0.0.1 (localhost only, accessed via Tailscale from laptop)
- **Data dir:** `VERDANDI_DATA_DIR` env var or `./data/`
- **Systemd:** `verdandi.service` (persistent server, Restart=always)

## Testing

```bash
npm test                # All tests
npx vitest run --reporter=verbose   # Verbose output
```

Tests use in-memory SQLite (`:memory:`) — no file cleanup needed.
