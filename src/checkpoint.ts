/**
 * Hash-chain checkpointing for Verdandi.
 *
 * A checkpoint verifies the full local hash chain, records the verified head in
 * the checkpoints table, and can optionally publish a small local anchor file.
 * It does not claim RFC 3161/TSA backing unless tsa_response is populated by a
 * future implementation.
 */

import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type Database from 'better-sqlite3';
import { GENESIS_HASH, verifyChain } from './hash-chain.js';

export interface CheckpointOptions {
  anchorPath?: string;
  now?: Date;
}

export interface CheckpointResult {
  verified: boolean;
  checkpoint_id: number;
  checkpoint_at: string;
  events_checked: number;
  last_event_id: number;
  last_entry_hash: string;
  anchor_path?: string;
  error?: string;
  broken_at?: number;
}

interface ChainHead {
  id: number;
  entry_hash: string;
}

interface StoredCheckpoint {
  id: number;
  last_event_id: number;
  last_entry_hash: string;
}

interface InsertResult {
  checkpoint_id: number;
  last_event_id: number;
  last_entry_hash: string;
  verified: boolean;
  events_checked: number;
  verification_error?: string;
  broken_at?: number;
  continuity_error?: string;
  previous_checkpoint_id?: number;
}

export function createCheckpoint(
  db: Database.Database,
  opts: CheckpointOptions = {}
): CheckpointResult {
  const checkpointAt = (opts.now ?? new Date()).toISOString();

  const transaction = db.transaction((): InsertResult => {
    const verification = verifyChain(db);
    const head = db.prepare(
      'SELECT id, entry_hash FROM audit_events ORDER BY id DESC LIMIT 1'
    ).get() as ChainHead | undefined;

    const lastEventId = head?.id ?? 0;
    const lastEntryHash = head?.entry_hash ?? GENESIS_HASH;
    const previousCheckpoint = latestVerifiedCheckpoint(db);
    const continuityError = previousCheckpoint
      ? validateCheckpointContinuity(db, previousCheckpoint, lastEventId)
      : undefined;
    const verified = verification.valid && continuityError === undefined;

    const info = db.prepare(`
      INSERT INTO checkpoints (
        checkpoint_at, last_event_id, last_entry_hash, verified
      ) VALUES (?, ?, ?, ?)
    `).run(
      checkpointAt,
      lastEventId,
      lastEntryHash,
      verified ? 1 : 0
    );

    const checkpointId = info.lastInsertRowid as number;

    return {
      checkpoint_id: checkpointId,
      last_event_id: lastEventId,
      last_entry_hash: lastEntryHash,
      verified,
      events_checked: verification.events_checked,
      verification_error: verification.error,
      broken_at: verification.broken_at,
      continuity_error: continuityError,
      previous_checkpoint_id: previousCheckpoint?.id,
    };
  });

  const inserted = transaction.immediate();

  // Publish only after SQLite has committed the checkpoint. Writing the
  // anchor inside the transaction could leave a durable file referring to a
  // row that was later rolled back by a commit failure.
  if (inserted.verified && opts.anchorPath) {
    writeAnchor(opts.anchorPath, {
      version: 1,
      service: 'verdandi',
      verification: 'sha256-hash-chain',
      checkpoint_id: inserted.checkpoint_id,
      checkpoint_at: checkpointAt,
      events_checked: inserted.events_checked,
      last_event_id: inserted.last_event_id,
      last_entry_hash: inserted.last_entry_hash,
      previous_checkpoint_id: inserted.previous_checkpoint_id ?? null,
    });
  }

  return {
    verified: inserted.verified,
    checkpoint_id: inserted.checkpoint_id,
    checkpoint_at: checkpointAt,
    events_checked: inserted.events_checked,
    last_event_id: inserted.last_event_id,
    last_entry_hash: inserted.last_entry_hash,
    anchor_path: inserted.verified ? opts.anchorPath : undefined,
    error: inserted.verification_error ?? inserted.continuity_error,
    broken_at: inserted.broken_at,
  };
}

function latestVerifiedCheckpoint(db: Database.Database): StoredCheckpoint | undefined {
  return db.prepare(`
    SELECT id, last_event_id, last_entry_hash
    FROM checkpoints
    WHERE verified = 1
    ORDER BY id DESC
    LIMIT 1
  `).get() as StoredCheckpoint | undefined;
}

function validateCheckpointContinuity(
  db: Database.Database,
  checkpoint: StoredCheckpoint,
  currentHeadId: number
): string | undefined {
  if (checkpoint.last_event_id === 0) {
    return checkpoint.last_entry_hash === GENESIS_HASH
      ? undefined
      : `Previous checkpoint ${checkpoint.id} has invalid genesis hash`;
  }

  if (checkpoint.last_event_id > currentHeadId) {
    return `Previous checkpoint ${checkpoint.id} points past current chain head`;
  }

  const row = db.prepare(
    'SELECT entry_hash FROM audit_events WHERE id = ?'
  ).get(checkpoint.last_event_id) as { entry_hash: string } | undefined;

  if (!row) {
    return `Previous checkpoint ${checkpoint.id} points to missing event ${checkpoint.last_event_id}`;
  }

  if (row.entry_hash !== checkpoint.last_entry_hash) {
    return `Previous checkpoint ${checkpoint.id} no longer matches event ${checkpoint.last_event_id}`;
  }

  return undefined;
}


function writeAnchor(anchorPath: string, anchor: Record<string, unknown>): void {
  mkdirSync(dirname(anchorPath), { recursive: true });

  const tmpPath = `${anchorPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(anchor, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmpPath, anchorPath);
}
