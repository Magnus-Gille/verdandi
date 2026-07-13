import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createCheckpoint } from '../src/checkpoint.js';
import { initDatabase } from '../src/db.js';
import { AppendWorker, GENESIS_HASH } from '../src/hash-chain.js';

let db: Database.Database;
let tempDir: string;

beforeEach(() => {
  db = initDatabase(':memory:');
  tempDir = mkdtempSync(join(tmpdir(), 'verdandi-checkpoint-'));
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function appendTestEvent(eventId: string) {
  const worker = new AppendWorker(db);

  return worker.append({
    event_id: eventId,
    event_type: 'task.submit',
    component: 'hugin',
    severity: 'routine',
    retention_class: 'operational',
    evidence_grade: 'mechanism',
    timestamp: '2026-04-03T10:00:00Z',
    action: { verb: 'submit', resource_type: 'task' },
  });
}

describe('createCheckpoint', () => {
  it('records a verified checkpoint for the current chain head', async () => {
    const appended = await appendTestEvent('evt-checkpoint-1');

    const result = createCheckpoint(db, {
      now: new Date('2026-07-07T10:00:00.000Z'),
    });

    expect(result).toMatchObject({
      verified: true,
      checkpoint_id: 1,
      checkpoint_at: '2026-07-07T10:00:00.000Z',
      events_checked: 1,
      last_event_id: appended.id,
      last_entry_hash: appended.entry_hash,
    });

    const row = db.prepare(
      'SELECT checkpoint_at, last_event_id, last_entry_hash, verified FROM checkpoints WHERE id = ?'
    ).get(result.checkpoint_id) as {
      checkpoint_at: string;
      last_event_id: number;
      last_entry_hash: string;
      verified: number;
    };

    expect(row).toEqual({
      checkpoint_at: '2026-07-07T10:00:00.000Z',
      last_event_id: appended.id,
      last_entry_hash: appended.entry_hash,
      verified: 1,
    });
  });

  it('writes an atomic local anchor file when requested', async () => {
    const appended = await appendTestEvent('evt-checkpoint-anchor');
    const anchorPath = join(tempDir, 'anchors', 'latest.json');

    const result = createCheckpoint(db, {
      anchorPath,
      now: new Date('2026-07-07T10:30:00.000Z'),
    });

    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as Record<string, unknown>;

    expect(result.verified).toBe(true);
    expect(result.anchor_path).toBe(anchorPath);
    expect(anchor).toEqual({
      version: 1,
      service: 'verdandi',
      verification: 'sha256-hash-chain',
      checkpoint_id: result.checkpoint_id,
      checkpoint_at: '2026-07-07T10:30:00.000Z',
      events_checked: 1,
      last_event_id: appended.id,
      last_entry_hash: appended.entry_hash,
      previous_checkpoint_id: null,
    });
  });

  it('commits the checkpoint before attempting to publish its anchor', async () => {
    await appendTestEvent('evt-checkpoint-anchor-failure');
    const notDirectory = join(tempDir, 'not-a-directory');
    writeFileSync(notDirectory, 'occupied');

    expect(() => createCheckpoint(db, {
      anchorPath: join(notDirectory, 'latest.json'),
      now: new Date('2026-07-07T10:45:00.000Z'),
    })).toThrow();

    const row = db.prepare(
      'SELECT checkpoint_at, verified FROM checkpoints ORDER BY id DESC LIMIT 1'
    ).get() as { checkpoint_at: string; verified: number };
    expect(row).toEqual({
      checkpoint_at: '2026-07-07T10:45:00.000Z',
      verified: 1,
    });
  });

  it('records a verified genesis checkpoint for an empty chain', () => {
    const result = createCheckpoint(db);

    expect(result.verified).toBe(true);
    expect(result.events_checked).toBe(0);
    expect(result.last_event_id).toBe(0);
    expect(result.last_entry_hash).toBe(GENESIS_HASH);
  });

  it('records failed verification and does not write an anchor', async () => {
    await appendTestEvent('evt-checkpoint-tamper');
    const anchorPath = join(tempDir, 'anchors', 'latest.json');

    db.exec('DROP TRIGGER prevent_event_update');
    db.prepare("UPDATE audit_events SET payload = '{\"tampered\":true}' WHERE id = 1").run();

    const result = createCheckpoint(db, { anchorPath });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('Tampered');
    expect(result.anchor_path).toBeUndefined();

    const row = db.prepare(
      'SELECT verified FROM checkpoints WHERE id = ?'
    ).get(result.checkpoint_id) as { verified: number };

    expect(row.verified).toBe(0);
    expect(() => readFileSync(anchorPath, 'utf8')).toThrow();
  });

  it('fails if the previous verified checkpoint no longer matches the chain', async () => {
    await appendTestEvent('evt-checkpoint-continuity');
    const first = createCheckpoint(db);

    db.prepare(
      "UPDATE checkpoints SET last_entry_hash = 'not-the-event-hash' WHERE id = ?"
    ).run(first.checkpoint_id);

    const anchorPath = join(tempDir, 'anchors', 'latest.json');
    const result = createCheckpoint(db, { anchorPath });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('Previous checkpoint');
    expect(result.anchor_path).toBeUndefined();
    expect(() => readFileSync(anchorPath, 'utf8')).toThrow();
  });
});
