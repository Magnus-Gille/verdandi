/**
 * SHA-256 hash chain for tamper-evident audit log.
 * Resolves debate critique C02: atomic append with single writer.
 *
 * The AppendWorker is the ONLY code path that writes to the audit_events table.
 * It processes events sequentially from an in-process queue, each within
 * a BEGIN IMMEDIATE transaction.
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { canonicalize } from './canonical.js';

export const GENESIS_HASH = 'GENESIS';

export function computeEntryHash(prevHash: string, canonicalPayload: string): string {
  return createHash('sha256')
    .update(prevHash)
    .update('||')
    .update(canonicalPayload)
    .digest('hex');
}

export interface AppendResult {
  id: number;
  event_id: string;
  entry_hash: string;
  chain_position: number;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('event_id already exists with different event content');
    this.name = 'IdempotencyConflictError';
  }
}

interface QueuedEvent {
  event: Record<string, unknown>;
  resolve: (result: AppendResult) => void;
  reject: (error: Error) => void;
}

export class AppendWorker {
  private queue: QueuedEvent[] = [];
  private processing = false;
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private lastHashStmt: Database.Statement;
  private checkDuplicateStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.insertStmt = db.prepare(`
      INSERT INTO audit_events (
        event_id, timestamp_utc, server_timestamp, timestamp_ms,
        event_type, component, severity, retention_class, evidence_grade,
        payload, prev_hash, entry_hash,
        trace_id, session_id, parent_event_id,
        contains_pii, erasure_eligible
      ) VALUES (
        @event_id, @timestamp_utc, @server_timestamp, @timestamp_ms,
        @event_type, @component, @severity, @retention_class, @evidence_grade,
        @payload, @prev_hash, @entry_hash,
        @trace_id, @session_id, @parent_event_id,
        @contains_pii, @erasure_eligible
      )
    `);

    this.lastHashStmt = db.prepare(
      'SELECT entry_hash FROM audit_events ORDER BY id DESC LIMIT 1'
    );

    this.checkDuplicateStmt = db.prepare(
      'SELECT id, entry_hash, payload FROM audit_events WHERE event_id = ?'
    );
  }

  /**
   * Enqueue an event for append. Returns a promise that resolves
   * when the event is persisted (or rejects on error).
   */
  append(event: Record<string, unknown>): Promise<AppendResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  private processQueue(): void {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;

    // Process the entire current queue in one batch for efficiency
    const batch = this.queue.splice(0);

    for (const item of batch) {
      try {
        const result = this.appendOne(item.event);
        item.resolve(result);
      } catch (err) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Check if more items were added while processing
    if (this.queue.length > 0) {
      // Use setImmediate to avoid stack overflow on large bursts
      setImmediate(() => this.processQueue());
    } else {
      this.processing = false;
    }
  }

  private appendOne(event: Record<string, unknown>): AppendResult {
    const eventId = event.event_id as string;

    // Idempotency check (C06): exact repeated delivery returns the existing
    // result. If the original request omitted its advisory timestamp, reuse
    // the stored value before comparing so a server-generated timestamp does
    // not turn a byte-for-byte retry into a false conflict.
    const existing = this.checkDuplicateStmt.get(eventId) as
      | { id: number; entry_hash: string; payload: string }
      | undefined;
    if (existing) {
      if (!event.timestamp) {
        const stored = JSON.parse(existing.payload) as Record<string, unknown>;
        if (typeof stored.timestamp === 'string') event.timestamp = stored.timestamp;
      }
      const canonicalPayload = canonicalize(event);
      if (canonicalPayload !== existing.payload) {
        throw new IdempotencyConflictError();
      }
      return {
        id: existing.id,
        event_id: eventId,
        entry_hash: existing.entry_hash,
        chain_position: existing.id,
      };
    }

    if (!event.timestamp || typeof event.timestamp !== 'string') {
      event.timestamp = new Date().toISOString();
    }

    // Canonicalize the event payload
    const canonicalPayload = canonicalize(event);

    // Atomic append within BEGIN IMMEDIATE transaction
    const result = this.db.transaction(() => {
      // Read chain head
      const lastRow = this.lastHashStmt.get() as
        | { entry_hash: string }
        | undefined;
      const prevHash = lastRow?.entry_hash ?? GENESIS_HASH;

      // Compute entry hash
      const entryHash = computeEntryHash(prevHash, canonicalPayload);

      const now = new Date();
      const serverTimestamp = now.toISOString();

      // Insert
      const info = this.insertStmt.run({
        event_id: eventId,
        timestamp_utc: (event.timestamp as string) ?? serverTimestamp,
        server_timestamp: serverTimestamp,
        timestamp_ms: now.getTime(),
        event_type: event.event_type as string,
        component: event.component as string,
        severity: event.severity as string,
        retention_class: event.retention_class as string,
        evidence_grade: event.evidence_grade as string ?? 'mechanism',
        payload: canonicalPayload,
        prev_hash: prevHash,
        entry_hash: entryHash,
        trace_id: (event.trace as Record<string, unknown>)?.trace_id ?? null,
        session_id: (event.trace as Record<string, unknown>)?.session_id ?? null,
        parent_event_id: (event.trace as Record<string, unknown>)?.parent_event_id ?? null,
        contains_pii: (event.data_classification as Record<string, unknown>)?.contains_pii ? 1 : 0,
        erasure_eligible: (event.data_classification as Record<string, unknown>)?.erasure_eligible !== false ? 1 : 0,
      });

      return {
        id: info.lastInsertRowid as number,
        event_id: eventId,
        entry_hash: entryHash,
        chain_position: info.lastInsertRowid as number,
      };
    }).immediate();

    return result;
  }
}

/**
 * Verify the integrity of the hash chain.
 */
export function verifyChain(
  db: Database.Database,
  opts?: { since?: number }
): { valid: boolean; events_checked: number; error?: string; broken_at?: number } {
  const since = opts?.since;
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 1)) {
    throw new RangeError('since must be a positive safe integer');
  }

  // Keep the row set and its predecessor on one SQLite read snapshot. This
  // makes verification deterministic even if another process appends while a
  // long chain is being checked.
  return db.transaction(() => verifyChainSnapshot(db, since))();
}

function verifyChainSnapshot(
  db: Database.Database,
  since?: number
): { valid: boolean; events_checked: number; error?: string; broken_at?: number } {
  const query = since !== undefined
    ? 'SELECT id, payload, prev_hash, entry_hash FROM audit_events WHERE id >= ? ORDER BY id'
    : 'SELECT id, payload, prev_hash, entry_hash FROM audit_events ORDER BY id';

  const rows = since !== undefined
    ? db.prepare(query).all(since)
    : db.prepare(query).all();

  if (rows.length === 0) {
    return { valid: true, events_checked: 0 };
  }

  // If starting from an offset, we need the previous entry's hash
  let prevHash = GENESIS_HASH;
  if (since !== undefined) {
    const prev = db.prepare(
      'SELECT entry_hash FROM audit_events WHERE id < ? ORDER BY id DESC LIMIT 1'
    ).get(since) as { entry_hash: string } | undefined;
    if (prev) prevHash = prev.entry_hash;
  }

  for (const row of rows as Array<{
    id: number;
    payload: string;
    prev_hash: string;
    entry_hash: string;
  }>) {
    if (row.prev_hash !== prevHash) {
      return {
        valid: false,
        events_checked: rows.indexOf(row),
        error: `Chain broken at id=${row.id}: expected prev_hash=${prevHash}, got ${row.prev_hash}`,
        broken_at: row.id,
      };
    }

    const expected = computeEntryHash(prevHash, row.payload);
    if (row.entry_hash !== expected) {
      return {
        valid: false,
        events_checked: rows.indexOf(row),
        error: `Tampered payload at id=${row.id}: expected hash=${expected}, got ${row.entry_hash}`,
        broken_at: row.id,
      };
    }

    prevHash = row.entry_hash;
  }

  return { valid: true, events_checked: rows.length };
}
