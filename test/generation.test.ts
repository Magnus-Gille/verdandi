import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db.js';
import {
  initializeNewGeneration,
  validateGeneration,
  type GenerationMarker,
} from '../src/generation.js';
import { AppendWorker, GENESIS_HASH } from '../src/hash-chain.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'verdandi-generation-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('generation lifecycle', () => {
  it('rejects a valid marker when verdandi.db is missing', () => {
    writeMarker(newGenesisMarker());

    const result = validateGeneration(dataDir);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('verdandi.db is missing or empty');
  });

  it('rejects malformed generation metadata', () => {
    initDatabase(join(dataDir, 'verdandi.db')).close();
    writeFileSync(join(dataDir, 'generation.json'), '{not-json', { mode: 0o600 });

    const result = validateGeneration(dataDir);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('not valid JSON');
  });

  it('rejects a malformed origin and continuity pairing', () => {
    initDatabase(join(dataDir, 'verdandi.db')).close();
    writeMarker({
      ...newGenesisMarker(),
      origin: 'recovered',
      continuity: 'none',
    } as GenerationMarker);

    const result = validateGeneration(dataDir);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('origin and continuity are not a valid pairing');
  });

  it('rejects a recovered marker whose adopted head does not match', async () => {
    const db = initDatabase(join(dataDir, 'verdandi.db'));
    const appended = await new AppendWorker(db).append({
      event_id: 'evt-recovered-generation',
      event_type: 'task.execution.complete',
      component: 'hugin',
      severity: 'routine',
      retention_class: 'operational',
      evidence_grade: 'mechanism',
      timestamp: '2026-07-08T08:00:00.000Z',
      action: { verb: 'execute', resource_type: 'task' },
    });
    db.close();
    writeMarker({
      ...newGenesisMarker(),
      origin: 'recovered',
      continuity: 'recovered-chain-only',
      database_binding: {
        schema_version: 1,
        adopted_event_count: 1,
        adopted_last_event_id: appended.id,
        adopted_last_entry_hash: 'not-the-recovered-head',
      },
    });

    const result = validateGeneration(dataDir);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('recovered generation binding hash does not match its event');
  });

  it('accepts a recovered marker bound to the inspected adoption head', async () => {
    const db = initDatabase(join(dataDir, 'verdandi.db'));
    const appended = await appendEvent(db, 'evt-valid-recovered-generation');
    db.close();
    writeMarker({
      ...newGenesisMarker(),
      created_at: new Date(Date.now() + 1_000).toISOString(),
      origin: 'recovered',
      continuity: 'recovered-chain-only',
      database_binding: {
        schema_version: 1,
        adopted_event_count: 1,
        adopted_last_event_id: appended.id,
        adopted_last_entry_hash: appended.entry_hash,
      },
    });

    expect(validateGeneration(dataDir)).toMatchObject({ valid: true, errors: [] });
  });

  it('explicitly initializes and validates a new genesis bound to GENESIS', async () => {
    const result = initializeNewGeneration(dataDir, {
      operator: 'Magnus',
      incident: 'verdandi-data-loss-2026-07',
      recoveryEvidence: { bounded_recovery_status: 'no-acceptable-candidate' },
      generation: '11111111-1111-4111-8111-111111111111',
      now: new Date(Date.now() - 1_000),
    });

    expect(result.valid).toBe(true);
    expect(result.marker).toMatchObject({
      origin: 'new-genesis',
      continuity: 'none',
      database_binding: {
        adopted_event_count: 0,
        adopted_last_event_id: 0,
        adopted_last_entry_hash: GENESIS_HASH,
      },
    });
    expect(result.current_database).toEqual({
      event_count: 0,
      last_event_id: 0,
      last_entry_hash: GENESIS_HASH,
    });
    expect(statSync(join(dataDir, 'verdandi.db')).size).toBeGreaterThan(0);
    expect(statSync(join(dataDir, 'generation.json')).size).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, '.verdandi-init-11111111-1111-4111-8111-111111111111.db')))
      .toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, 'generation.json'), 'utf8')))
      .toEqual(result.marker);

    const liveDb = initDatabase(join(dataDir, 'verdandi.db'));
    await appendEvent(liveDb, 'evt-after-new-genesis');
    liveDb.close();
    expect(validateGeneration(dataDir)).toMatchObject({ valid: true, errors: [] });
  });
});

function appendEvent(db: ReturnType<typeof initDatabase>, eventId: string) {
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

function writeMarker(marker: GenerationMarker): void {
  writeFileSync(join(dataDir, 'generation.json'), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

function newGenesisMarker(): GenerationMarker {
  return {
    version: 1,
    generation: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-07-10T11:00:00.000Z',
    operator: 'Magnus',
    origin: 'new-genesis',
    continuity: 'none',
    incident: 'verdandi-data-loss-2026-07',
    recovery_evidence: { master_image_sha256: 'not-yet-recorded-in-test-fixture' },
    database_binding: {
      schema_version: 1,
      adopted_event_count: 0,
      adopted_last_event_id: 0,
      adopted_last_entry_hash: GENESIS_HASH,
    },
  };
}
