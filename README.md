# Verdandi

Tamper-evident audit log for agentic actions — the accountability layer of the
[Grimnir](https://github.com/Magnus-Gille/grimnir) personal AI infrastructure.
Named for the Norn of the present, who records what *is*.

> **Project status: stopped.** Verdandi's MVP was built, hardened, and then
> deliberately paused pending a purpose reset (see draft PR #22, the Action
> Receipt Protocol ADR). The service is not deployed; the code is published for
> transparency and reuse. This repository going public is a visibility change,
> not a restart.

## What it is

Verdandi ingests structured audit events from the other Grimnir components
(task dispatch, accounting actions, deployments) into an append-only,
hash-chained SQLite log:

- **Hash-chained ingest** — every event is bound to its predecessor; tampering
  breaks chain verification (`verifyChain`).
- **Fail-closed authentication** — Bearer keys per component; malformed or
  unauthenticated events are rejected, never silently dropped.
- **Redaction at the boundary** — bearer tokens, API keys, and secret-shaped
  values are stripped from event payloads before persistence.
- **Idempotent, bounded reads** — collision-safe idempotency keys and bounded
  query parameters.
- **Offline recovery** — a documented, evidence-preserving recovery procedure
  (`docs/offline-recovery-and-new-genesis.md`) for rebuilding trust in the log
  after host failure.
- **Checkpointing** — periodic checkpoint statements via a systemd timer.

## Running it (for the curious)

```bash
npm ci
npm test        # vitest suite
npm run build
node dist/index.js
```

The service is a standalone Fastify app (port 3036) with a SQLite backend,
designed to run under systemd (`verdandi.service`,
`systemd/verdandi-checkpoint.timer`).

## License

[MIT](LICENSE)
