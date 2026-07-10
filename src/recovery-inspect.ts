/**
 * Read-only inspection for a recovered Verdandi SQLite candidate.
 *
 * Recovery media is evidence. This module deliberately does not call
 * initDatabase(), run migrations, checkpoint WAL state, or create files.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { verifyCheckpointHistory, type CheckpointHistoryResult } from './checkpoint-verify.js';
import { verifyChain } from './hash-chain.js';
import { inspectSchemaContract, type SchemaContractResult } from './schema-contract.js';

interface EvidenceFile {
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string;
}

export interface RecoveryInspection {
  candidate: string;
  evidence_files: EvidenceFile[];
  evidence_files_unchanged: boolean;
  integrity_ok: boolean;
  integrity_messages: string[];
  required_tables_present: boolean;
  missing_tables: string[];
  schema_version: number | null;
  schema_contract: SchemaContractResult;
  event_count: number;
  first_event_at: string | null;
  last_event_at: string | null;
  last_event_id: number | null;
  last_entry_hash: string | null;
  api_key_count: number;
  checkpoint_count: number;
  verified_checkpoint_count: number;
  chain: ReturnType<typeof verifyChain> | null;
  checkpoint_history: CheckpointHistoryResult | null;
  history_recovered: boolean;
  acceptable_for_restore: boolean;
}

export interface RecoveryInspectionOptions {
  beforeFinalEvidenceCheck?: () => void;
}

export function inspectRecoveryCandidate(
  candidatePath: string,
  options: RecoveryInspectionOptions = {}
): RecoveryInspection {
  if (!existsSync(candidatePath)) {
    throw new Error(`Candidate does not exist: ${candidatePath}`);
  }

  const candidate = realpathSync(candidatePath);
  const before = evidenceFiles(candidate);
  const inspectionDir = mkdtempSync(join(tmpdir(), 'verdandi-recovery-inspect-'));
  let db: Database.Database | undefined;
  let inspection: Omit<RecoveryInspection, 'evidence_files_unchanged'>;

  try {
    for (const file of before) {
      copyFileSync(file.path, join(inspectionDir, basename(file.path)));
    }
    const inspectionCandidate = join(inspectionDir, basename(candidate));
    db = new Database(inspectionCandidate, { readonly: true, fileMustExist: true });

    const integrityMessages = (db.pragma('integrity_check') as Array<Record<string, string>>)
      .flatMap((row) => Object.values(row));
    const integrityOk = integrityMessages.length === 1 && integrityMessages[0] === 'ok';

    const schemaContract = inspectSchemaContract(db);
    const missingTables = schemaContract.missing_tables;
    const requiredTablesPresent = missingTables.length === 0;

    const schemaVersion = schemaContract.schema_version;
    let eventCount = 0;
    let firstEventAt: string | null = null;
    let lastEventAt: string | null = null;
    let lastEventId: number | null = null;
    let lastEntryHash: string | null = null;
    let apiKeyCount = 0;
    let checkpointCount = 0;
    let verifiedCheckpointCount = 0;
    let chain: ReturnType<typeof verifyChain> | null = null;
    let checkpointHistory: CheckpointHistoryResult | null = null;

    if (schemaContract.valid) {
      const events = db.prepare(`
        SELECT
          COUNT(*) AS event_count,
          MIN(timestamp_utc) AS first_event_at,
          MAX(timestamp_utc) AS last_event_at,
          MAX(id) AS last_event_id
        FROM audit_events
      `).get() as {
        event_count: number;
        first_event_at: string | null;
        last_event_at: string | null;
        last_event_id: number | null;
      };
      eventCount = events.event_count;
      firstEventAt = events.first_event_at;
      lastEventAt = events.last_event_at;
      lastEventId = events.last_event_id;

      if (lastEventId !== null) {
        lastEntryHash = (db.prepare('SELECT entry_hash FROM audit_events WHERE id = ?').get(lastEventId) as {
          entry_hash: string;
        }).entry_hash;
      }

      apiKeyCount = (db.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as { count: number }).count;
      const checkpoints = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS verified
        FROM checkpoints
      `).get() as { count: number; verified: number };
      checkpointCount = checkpoints.count;
      verifiedCheckpointCount = checkpoints.verified;
      chain = verifyChain(db);
      checkpointHistory = verifyCheckpointHistory(db);
    }

    const historyRecovered = eventCount > 0;
    const acceptableForRestore =
      integrityOk &&
      schemaContract.valid &&
      historyRecovered &&
      chain?.valid === true &&
      checkpointHistory?.valid === true;

    inspection = {
      candidate,
      evidence_files: before,
      integrity_ok: integrityOk,
      integrity_messages: integrityMessages,
      required_tables_present: requiredTablesPresent,
      missing_tables: missingTables,
      schema_version: schemaVersion,
      schema_contract: schemaContract,
      event_count: eventCount,
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      last_event_id: lastEventId,
      last_entry_hash: lastEntryHash,
      api_key_count: apiKeyCount,
      checkpoint_count: checkpointCount,
      verified_checkpoint_count: verifiedCheckpointCount,
      chain,
      checkpoint_history: checkpointHistory,
      history_recovered: historyRecovered,
      acceptable_for_restore: acceptableForRestore,
    };
  } finally {
    db?.close();
    rmSync(inspectionDir, { recursive: true, force: true });
  }

  options.beforeFinalEvidenceCheck?.();
  const evidenceFilesUnchanged = sameEvidence(before, evidenceFiles(candidate));
  return {
    ...inspection,
    evidence_files_unchanged: evidenceFilesUnchanged,
    acceptable_for_restore: inspection.acceptable_for_restore && evidenceFilesUnchanged,
  };
}

function evidenceFiles(candidate: string): EvidenceFile[] {
  return [candidate, `${candidate}-wal`, `${candidate}-shm`]
    .filter(existsSync)
    .map((path) => {
      const stat = statSync(path);
      return {
        path,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      };
    });
}

function sameEvidence(before: EvidenceFile[], after: EvidenceFile[]): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}
