import type Database from 'better-sqlite3';
import { GENESIS_HASH } from './hash-chain.js';

export interface CheckpointHistoryResult {
  valid: boolean;
  verified_checkpoints_checked: number;
  external_anchor_count: number;
  external_anchor_grade: 'none' | 'presence-only-unvalidated';
  error?: string;
  broken_checkpoint_id?: number;
}

interface CheckpointRow {
  id: number;
  checkpoint_at: string;
  last_event_id: number;
  last_entry_hash: string;
}

export function verifyCheckpointHistory(db: Database.Database): CheckpointHistoryResult {
  const externalAnchorCount = (db.prepare(`
    SELECT COUNT(*) AS count FROM checkpoints WHERE tsa_response IS NOT NULL
  `).get() as { count: number }).count;
  const rows = db.prepare(`
    SELECT id, checkpoint_at, last_event_id, last_entry_hash
    FROM checkpoints
    WHERE verified = 1
    ORDER BY id
  `).all() as CheckpointRow[];

  let previousEventId = 0;
  let previousCheckpointTime = Number.NEGATIVE_INFINITY;
  for (const [index, row] of rows.entries()) {
    const checkpointTime = Date.parse(row.checkpoint_at);
    if (!Number.isFinite(checkpointTime)) {
      return invalid(row.id, index, externalAnchorCount, 'checkpoint_at is not valid ISO time');
    }
    if (checkpointTime < previousCheckpointTime) {
      return invalid(row.id, index, externalAnchorCount, 'verified checkpoint times are nonmonotonic');
    }
    if (!Number.isInteger(row.last_event_id) || row.last_event_id < previousEventId) {
      return invalid(row.id, index, externalAnchorCount, 'verified checkpoint event heads are nonmonotonic');
    }

    if (row.last_event_id === 0) {
      if (row.last_entry_hash !== GENESIS_HASH) {
        return invalid(row.id, index, externalAnchorCount, 'genesis checkpoint hash is invalid');
      }
    } else {
      const event = db.prepare('SELECT entry_hash FROM audit_events WHERE id = ?').get(
        row.last_event_id
      ) as { entry_hash: string } | undefined;
      if (!event) {
        return invalid(row.id, index, externalAnchorCount, 'checkpoint references a missing event');
      }
      if (event.entry_hash !== row.last_entry_hash) {
        return invalid(row.id, index, externalAnchorCount, 'checkpoint hash does not match its event');
      }
    }

    previousEventId = row.last_event_id;
    previousCheckpointTime = checkpointTime;
  }

  return {
    valid: true,
    verified_checkpoints_checked: rows.length,
    external_anchor_count: externalAnchorCount,
    external_anchor_grade: externalAnchorCount > 0 ? 'presence-only-unvalidated' : 'none',
  };
}

function invalid(
  checkpointId: number,
  checkedBeforeFailure: number,
  externalAnchorCount: number,
  error: string
): CheckpointHistoryResult {
  return {
    valid: false,
    verified_checkpoints_checked: checkedBeforeFailure,
    external_anchor_count: externalAnchorCount,
    external_anchor_grade: externalAnchorCount > 0 ? 'presence-only-unvalidated' : 'none',
    error,
    broken_checkpoint_id: checkpointId,
  };
}
