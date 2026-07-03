import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { AppendWorker } from '../src/hash-chain.js';
import { registerApiKey } from '../src/auth.js';
import { IngestPipeline } from '../src/ingest.js';
import { HUGIN_EVENT_TYPES, RATATOSKR_EVENT_TYPES } from '../src/event-types.js';

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

// ============================================================
// Multi-environment ingest seam (issue #10) — canonical event
// types for the two highest-value Pi-side emitters.
// ============================================================

describe('hugin event types', () => {
  it('ingests a task-completion event as mechanism/operational', async () => {
    const { key } = registerApiKey(db, 'hugin', ['write']);
    const pipeline = new IngestPipeline(db, new AppendWorker(db));

    const result = await pipeline.ingest(`Bearer ${key}`, {
      event_type: HUGIN_EVENT_TYPES.TASK_COMPLETE,
      severity: 'routine',
      action: { verb: 'execute', resource_type: 'task', resource_id: 'task-123' },
    });

    expect(result.ok).toBe(true);
    const row = db.prepare(
      'SELECT component, evidence_grade, retention_class FROM audit_events WHERE event_id = ?'
    ).get(result.ok ? result.event_id : '') as Record<string, string>;
    expect(row.component).toBe('hugin');
    expect(row.evidence_grade).toBe('mechanism');
    expect(row.retention_class).toBe('operational');
  });

  it('ingests a task-failure event as mechanism/operational, not debug', async () => {
    const { key } = registerApiKey(db, 'hugin', ['write']);
    const pipeline = new IngestPipeline(db, new AppendWorker(db));

    const result = await pipeline.ingest(`Bearer ${key}`, {
      event_type: HUGIN_EVENT_TYPES.TASK_FAIL,
      severity: 'significant',
      action: {
        verb: 'execute',
        resource_type: 'task',
        resource_id: 'task-456',
        detail: 'timed out after 300s',
      },
    });

    expect(result.ok).toBe(true);
    const row = db.prepare(
      'SELECT evidence_grade, retention_class FROM audit_events WHERE event_id = ?'
    ).get(result.ok ? result.event_id : '') as Record<string, string>;
    expect(row.evidence_grade).toBe('mechanism');
    expect(row.retention_class).toBe('operational');
  });
});

describe('ratatoskr event types', () => {
  it('ingests a telegram message-received event as mechanism/debug', async () => {
    const { key } = registerApiKey(db, 'ratatoskr', ['write']);
    const pipeline = new IngestPipeline(db, new AppendWorker(db));

    const result = await pipeline.ingest(`Bearer ${key}`, {
      event_type: RATATOSKR_EVENT_TYPES.MESSAGE_RECEIVED,
      severity: 'debug',
      action: { verb: 'receive', resource_type: 'telegram_message', resource_id: 'msg-1' },
    });

    expect(result.ok).toBe(true);
    const row = db.prepare(
      'SELECT component, evidence_grade, retention_class FROM audit_events WHERE event_id = ?'
    ).get(result.ok ? result.event_id : '') as Record<string, string>;
    expect(row.component).toBe('ratatoskr');
    expect(row.evidence_grade).toBe('mechanism');
    expect(row.retention_class).toBe('debug');
  });

  it('ingests a concierge action-execute event as mechanism/operational', async () => {
    const { key } = registerApiKey(db, 'ratatoskr', ['write']);
    const pipeline = new IngestPipeline(db, new AppendWorker(db));

    const result = await pipeline.ingest(`Bearer ${key}`, {
      event_type: RATATOSKR_EVENT_TYPES.ACTION_EXECUTE,
      severity: 'routine',
      action: { verb: 'execute', resource_type: 'concierge_action', resource_id: 'act-1' },
    });

    expect(result.ok).toBe(true);
    const row = db.prepare(
      'SELECT evidence_grade, retention_class FROM audit_events WHERE event_id = ?'
    ).get(result.ok ? result.event_id : '') as Record<string, string>;
    expect(row.evidence_grade).toBe('mechanism');
    expect(row.retention_class).toBe('operational');
  });
});
