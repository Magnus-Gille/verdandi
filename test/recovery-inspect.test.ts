import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
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
      history_recovered: true,
      acceptable_for_restore: true,
      evidence_files_unchanged: true,
      chain: { valid: true, events_checked: 1 },
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
});
