import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { verifyCheckpointHistory } from './checkpoint-verify.js';
import { initDatabase } from './db.js';
import { GENESIS_HASH, verifyChain } from './hash-chain.js';
import { inspectSchemaContract, SUPPORTED_SCHEMA_VERSION } from './schema-contract.js';

export interface DatabaseBinding {
  schema_version: number;
  adopted_event_count: number;
  adopted_last_event_id: number;
  adopted_last_entry_hash: string;
}

export interface GenerationMarker {
  version: 1;
  generation: string;
  created_at: string;
  operator: string;
  origin: 'recovered' | 'new-genesis';
  continuity: 'recovered-chain-only' | 'none';
  incident: string;
  recovery_evidence: Record<string, unknown>;
  database_binding: DatabaseBinding;
}

export interface GenerationValidation {
  valid: boolean;
  errors: string[];
  marker?: GenerationMarker;
  current_database?: {
    event_count: number;
    last_event_id: number;
    last_entry_hash: string;
  };
}

export interface NewGenerationOptions {
  operator: string;
  incident: string;
  recoveryEvidence: Record<string, unknown>;
  now?: Date;
  generation?: string;
}

export function validateGeneration(dataDir: string): GenerationValidation {
  const errors: string[] = [];
  const markerPath = join(dataDir, 'generation.json');
  const dbPath = join(dataDir, 'verdandi.db');

  if (!existsSync(markerPath) || statSync(markerPath).size === 0) {
    return { valid: false, errors: ['generation marker is missing or empty'] };
  }
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) {
    return { valid: false, errors: ['verdandi.db is missing or empty'] };
  }

  let marker: GenerationMarker | undefined;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
    const markerErrors = validateMarker(parsed);
    errors.push(...markerErrors);
    if (markerErrors.length === 0) marker = parsed as GenerationMarker;
  } catch (error) {
    errors.push(`generation marker is not valid JSON: ${errorMessage(error)}`);
  }
  if (!marker) return { valid: false, errors };

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const integrity = (db.pragma('integrity_check') as Array<Record<string, string>>)
      .flatMap((row) => Object.values(row));
    if (!(integrity.length === 1 && integrity[0] === 'ok')) {
      errors.push(`database integrity check failed: ${integrity.join('; ')}`);
    }

    const schema = inspectSchemaContract(db);
    if (!schema.valid) errors.push(...schema.violations.map((item) => `schema: ${item}`));
    const chain = verifyChain(db);
    if (!chain.valid) errors.push(`hash chain: ${chain.error ?? 'invalid'}`);
    const checkpoints = verifyCheckpointHistory(db);
    if (!checkpoints.valid) errors.push(`checkpoint history: ${checkpoints.error ?? 'invalid'}`);

    const current = currentDatabaseHead(db);
    validateBinding(db, marker, current, errors);
    return {
      valid: errors.length === 0,
      errors,
      marker,
      current_database: current,
    };
  } catch (error) {
    errors.push(`database validation failed: ${errorMessage(error)}`);
    return { valid: false, errors, marker };
  } finally {
    db?.close();
  }
}

export function initializeNewGeneration(
  dataDir: string,
  options: NewGenerationOptions
): GenerationValidation {
  if (!options.operator.trim()) throw new Error('operator is required');
  if (!options.incident.trim()) throw new Error('incident is required');
  if (!isRecord(options.recoveryEvidence) || Object.keys(options.recoveryEvidence).length === 0) {
    throw new Error('nonempty recovery evidence is required');
  }
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    throw new Error(`data directory must already exist: ${dataDir}`);
  }

  const finalDb = join(dataDir, 'verdandi.db');
  const finalMarker = join(dataDir, 'generation.json');
  if (existsSync(finalDb) || existsSync(finalMarker)) {
    throw new Error('refusing to initialize: verdandi.db or generation.json already exists');
  }

  const generation = options.generation ?? randomUUID();
  if (!isUuid(generation)) throw new Error('generation must be a UUID');
  const tempDb = join(dataDir, `.verdandi-init-${generation}.db`);
  const tempMarker = join(dataDir, `.generation-init-${generation}.json`);
  let installedDb = false;
  let installedMarker = false;

  try {
    const db = initDatabase(tempDb);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    rmSync(`${tempDb}-wal`, { force: true });
    rmSync(`${tempDb}-shm`, { force: true });
    chmodSync(tempDb, 0o600);

    const marker: GenerationMarker = {
      version: 1,
      generation,
      created_at: (options.now ?? new Date()).toISOString(),
      operator: options.operator.trim(),
      origin: 'new-genesis',
      continuity: 'none',
      incident: options.incident.trim(),
      recovery_evidence: options.recoveryEvidence,
      database_binding: {
        schema_version: SUPPORTED_SCHEMA_VERSION,
        adopted_event_count: 0,
        adopted_last_event_id: 0,
        adopted_last_entry_hash: GENESIS_HASH,
      },
    };
    writeFileSync(tempMarker, `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });

    linkSync(tempDb, finalDb);
    installedDb = true;
    rmSync(tempDb, { force: true });
    linkSync(tempMarker, finalMarker);
    installedMarker = true;
    rmSync(tempMarker, { force: true });

    const validation = validateGeneration(dataDir);
    if (!validation.valid) {
      throw new Error(`initialized generation failed validation: ${validation.errors.join('; ')}`);
    }
    return validation;
  } catch (error) {
    rmSync(tempDb, { force: true });
    rmSync(`${tempDb}-wal`, { force: true });
    rmSync(`${tempDb}-shm`, { force: true });
    rmSync(tempMarker, { force: true });
    if (installedMarker) rmSync(finalMarker, { force: true });
    if (installedDb) rmSync(finalDb, { force: true });
    throw error;
  }
}

function validateMarker(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['generation marker must be a JSON object'];
  if (value.version !== 1) errors.push('generation marker version must be 1');
  if (typeof value.generation !== 'string' || !isUuid(value.generation)) {
    errors.push('generation must be a UUID');
  }
  if (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) {
    errors.push('created_at must be a valid timestamp');
  }
  if (typeof value.operator !== 'string' || value.operator.trim() === '') {
    errors.push('operator must be nonempty');
  }
  if (typeof value.incident !== 'string' || value.incident.trim() === '') {
    errors.push('incident must be nonempty');
  }
  if (!isRecord(value.recovery_evidence) || Object.keys(value.recovery_evidence).length === 0) {
    errors.push('recovery_evidence must be a nonempty object');
  }
  const validPair =
    (value.origin === 'recovered' && value.continuity === 'recovered-chain-only') ||
    (value.origin === 'new-genesis' && value.continuity === 'none');
  if (!validPair) errors.push('origin and continuity are not a valid pairing');

  if (!isRecord(value.database_binding)) {
    errors.push('database_binding must be an object');
  } else {
    const binding = value.database_binding;
    if (binding.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      errors.push(`database_binding.schema_version must be ${SUPPORTED_SCHEMA_VERSION}`);
    }
    for (const field of ['adopted_event_count', 'adopted_last_event_id'] as const) {
      if (!Number.isInteger(binding[field]) || (binding[field] as number) < 0) {
        errors.push(`database_binding.${field} must be a nonnegative integer`);
      }
    }
    if (typeof binding.adopted_last_entry_hash !== 'string' || !binding.adopted_last_entry_hash) {
      errors.push('database_binding.adopted_last_entry_hash must be nonempty');
    }
  }
  return errors;
}

function validateBinding(
  db: Database.Database,
  marker: GenerationMarker,
  current: { event_count: number; last_event_id: number; last_entry_hash: string },
  errors: string[]
): void {
  const binding = marker.database_binding;
  if (marker.origin === 'new-genesis') {
    if (
      binding.adopted_event_count !== 0 ||
      binding.adopted_last_event_id !== 0 ||
      binding.adopted_last_entry_hash !== GENESIS_HASH
    ) {
      errors.push('new-genesis marker must bind to the empty GENESIS head');
    }
  } else {
    if (binding.adopted_event_count < 1 || binding.adopted_last_event_id < 1) {
      errors.push('recovered marker must bind to a nonempty recovered chain');
      return;
    }
    if (
      current.event_count < binding.adopted_event_count ||
      current.last_event_id < binding.adopted_last_event_id
    ) {
      errors.push('database is behind the recovered generation binding');
    }
    const adopted = db.prepare('SELECT entry_hash, server_timestamp FROM audit_events WHERE id = ?').get(
      binding.adopted_last_event_id
    ) as { entry_hash: string; server_timestamp: string } | undefined;
    if (!adopted) {
      errors.push('recovered generation binding references a missing event');
    } else if (adopted.entry_hash !== binding.adopted_last_entry_hash) {
      errors.push('recovered generation binding hash does not match its event');
    } else if (Date.parse(adopted.server_timestamp) > Date.parse(marker.created_at)) {
      errors.push('recovered generation marker predates its adopted head');
    }
  }

  const adoptedPrefixCount = (db.prepare(
    'SELECT COUNT(*) AS count FROM audit_events WHERE id <= ?'
  ).get(binding.adopted_last_event_id) as { count: number }).count;
  if (adoptedPrefixCount !== binding.adopted_event_count) {
    errors.push('generation binding event count does not match its adopted prefix');
  }

  const markerTime = Date.parse(marker.created_at);
  const laterRows = db.prepare(
    'SELECT id, server_timestamp FROM audit_events WHERE id > ? ORDER BY id'
  ).all(binding.adopted_last_event_id) as Array<{ id: number; server_timestamp: string }>;
  const preMarkerAppend = laterRows.find((row) => {
    const eventTime = Date.parse(row.server_timestamp);
    return !Number.isFinite(eventTime) || eventTime < markerTime;
  });
  if (preMarkerAppend) {
    errors.push(
      `event ${preMarkerAppend.id} follows the adopted head but predates the generation marker`
    );
  }
}

function currentDatabaseHead(db: Database.Database): {
  event_count: number;
  last_event_id: number;
  last_entry_hash: string;
} {
  const row = db.prepare(`
    SELECT COUNT(*) AS event_count, COALESCE(MAX(id), 0) AS last_event_id
    FROM audit_events
  `).get() as { event_count: number; last_event_id: number };
  const head = row.last_event_id === 0
    ? GENESIS_HASH
    : (db.prepare('SELECT entry_hash FROM audit_events WHERE id = ?').get(row.last_event_id) as {
        entry_hash: string;
      }).entry_hash;
  return { ...row, last_entry_hash: head };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
