import { createHash } from 'crypto';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { AppendWorker } from '../src/hash-chain.js';
import { inspectRecoveryCandidate } from '../src/recovery-inspect.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'verdandi-recovery-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('inspectRecoveryCandidate', () => {
  it('accepts an intact non-empty chain without mutating the candidate', async () => {
    const dbPath = join(tempDir, 'verdandi.db');
    const db = initDatabase(dbPath);
    const worker = new AppendWorker(db);
    await worker.append({
      event_id: 'evt-recovered-1',
      event_type: 'task.execution.complete',
      component: 'hugin',
      severity: 'routine',
      retention_class: 'operational',
      evidence_grade: 'mechanism',
      timestamp: '2026-07-08T08:00:00.000Z',
      action: { verb: 'execute', resource_type: 'task' },
    });
    db.close();
    const before = sha256(dbPath);

    const result = inspectRecoveryCandidate(dbPath);

    expect(result).toMatchObject({
      integrity_ok: true,
      required_tables_present: true,
      event_count: 1,
      schema_version: 1,
      schema_contract: { valid: true, violations: [] },
      history_recovered: true,
      acceptable_for_restore: true,
      evidence_files_unchanged: true,
      chain: { valid: true, events_checked: 1 },
      checkpoint_history: { valid: true, verified_checkpoints_checked: 0 },
    });
    expect(sha256(dbPath)).toBe(before);
  });

  it('rejects a valid but empty database as recovered history', () => {
    const dbPath = join(tempDir, 'verdandi.db');
    initDatabase(dbPath).close();

    const result = inspectRecoveryCandidate(dbPath);

    expect(result.integrity_ok).toBe(true);
    expect(result.chain).toEqual({ valid: true, events_checked: 0 });
    expect(result.history_recovered).toBe(false);
    expect(result.acceptable_for_restore).toBe(false);
  });

  it('rejects a SQLite file without the Verdandi schema', () => {
    const dbPath = join(tempDir, 'other.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    db.close();

    const result = inspectRecoveryCandidate(dbPath);

    expect(result.required_tables_present).toBe(false);
    expect(result.missing_tables).toEqual(expect.arrayContaining([
      'api_keys',
      'audit_events',
      'checkpoints',
      'schema_version',
    ]));
    expect(result.acceptable_for_restore).toBe(false);
  });

  it('removes its disposable inspection directory when SQLite inspection fails', () => {
    const dbPath = join(tempDir, 'corrupt.db');
    writeFileSync(dbPath, 'not a sqlite database');
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith('verdandi-recovery-inspect-'))
    );

    expect(() => inspectRecoveryCandidate(dbPath)).toThrow();

    const after = readdirSync(tmpdir()).filter(
      (name) => name.startsWith('verdandi-recovery-inspect-') && !before.has(name)
    );
    expect(after).toEqual([]);
  });

  it('rejects unsupported and degraded critical schema contracts', async () => {
    const dbPath = join(tempDir, 'verdandi.db');
    const db = initDatabase(dbPath);
    await appendEvent(db, 'evt-degraded-schema');
    db.exec('DROP TRIGGER prevent_event_update');
    db.exec('DROP INDEX idx_events_component');
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    db.close();

    const result = inspectRecoveryCandidate(dbPath);

    expect(result.schema_contract.valid).toBe(false);
    expect(result.schema_contract.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('unsupported schema version'),
      'missing append-only trigger: prevent_event_update',
      'missing audit_events index: idx_events_component',
    ]));
    expect(result.acceptable_for_restore).toBe(false);
  });

  it('rejects a claimed-valid checkpoint whose event hash does not match', async () => {
    const dbPath = join(tempDir, 'verdandi.db');
    const db = initDatabase(dbPath);
    const event = await appendEvent(db, 'evt-checkpoint-mismatch');
    insertVerifiedCheckpoint(db, 1, event.id, 'wrong-hash');
    db.close();

    const result = inspectRecoveryCandidate(dbPath);

    expect(result.checkpoint_history).toMatchObject({
      valid: false,
      broken_checkpoint_id: 1,
      error: 'checkpoint hash does not match its event',
    });
    expect(result.acceptable_for_restore).toBe(false);
  });

  it('rejects missing and nonmonotonic claimed-valid checkpoint heads', async () => {
    const missingPath = join(tempDir, 'missing.db');
    const missingDb = initDatabase(missingPath);
    await appendEvent(missingDb, 'evt-checkpoint-present');
    insertVerifiedCheckpoint(missingDb, 1, 999, 'missing-hash');
    missingDb.close();
    expect(inspectRecoveryCandidate(missingPath).checkpoint_history).toMatchObject({
      valid: false,
      error: 'checkpoint references a missing event',
    });

    const nonmonotonicPath = join(tempDir, 'nonmonotonic.db');
    const nonmonotonicDb = initDatabase(nonmonotonicPath);
    const first = await appendEvent(nonmonotonicDb, 'evt-checkpoint-first');
    const second = await appendEvent(nonmonotonicDb, 'evt-checkpoint-second');
    insertVerifiedCheckpoint(nonmonotonicDb, 1, second.id, second.entry_hash);
    insertVerifiedCheckpoint(nonmonotonicDb, 2, first.id, first.entry_hash);
    nonmonotonicDb.close();
    expect(inspectRecoveryCandidate(nonmonotonicPath).checkpoint_history).toMatchObject({
      valid: false,
      broken_checkpoint_id: 2,
      error: 'verified checkpoint event heads are nonmonotonic',
    });
  });

  it('keeps external-anchor presence separate from local checkpoint validity', async () => {
    const dbPath = join(tempDir, 'verdandi.db');
    const db = initDatabase(dbPath);
    const event = await appendEvent(db, 'evt-external-anchor');
    db.prepare(`
      INSERT INTO checkpoints (
        checkpoint_at, last_event_id, last_entry_hash, tsa_response, verified
      ) VALUES (?, ?, ?, ?, 1)
    `).run('2026-07-10T10:00:00.000Z', event.id, event.entry_hash, Buffer.from('unvalidated'));
    db.close();

    const result = inspectRecoveryCandidate(dbPath);

    expect(result.checkpoint_history).toMatchObject({
      valid: true,
      external_anchor_count: 1,
      external_anchor_grade: 'presence-only-unvalidated',
    });
    expect(result.acceptable_for_restore).toBe(true);
  });

  it('rejects acceptance when source evidence changes after the disposable snapshot', async () => {
    const dbPath = join(tempDir, 'verdandi.db');
    const db = initDatabase(dbPath);
    await appendEvent(db, 'evt-evidence-race');
    db.close();

    const result = inspectRecoveryCandidate(dbPath, {
      beforeFinalEvidenceCheck: () => appendFileSync(dbPath, Buffer.from([0])),
    });

    expect(result.integrity_ok).toBe(true);
    expect(result.chain?.valid).toBe(true);
    expect(result.evidence_files_unchanged).toBe(false);
    expect(result.acceptable_for_restore).toBe(false);
  });
});

async function appendEvent(db: Database.Database, eventId: string) {
  return new AppendWorker(db).append({
    event_id: eventId,
    event_type: 'task.execution.complete',
    component: 'hugin',
    severity: 'routine',
    retention_class: 'operational',
    evidence_grade: 'mechanism',
    timestamp: '2026-07-08T08:00:00.000Z',
    action: { verb: 'execute', resource_type: 'task' },
  });
}

function insertVerifiedCheckpoint(
  db: Database.Database,
  ordinal: number,
  eventId: number,
  entryHash: string
): void {
  db.prepare(`
    INSERT INTO checkpoints (checkpoint_at, last_event_id, last_entry_hash, verified)
    VALUES (?, ?, ?, 1)
  `).run(`2026-07-10T10:0${ordinal}:00.000Z`, eventId, entryHash);
}
