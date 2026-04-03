/**
 * Database initialization and schema management for Verdandi.
 * Uses better-sqlite3 in WAL mode for optimal Pi 5 performance.
 */

import Database from 'better-sqlite3';
import { join } from 'path';

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // WAL mode makes this safe

  // Run migrations
  migrate(db);

  return db;
}

function migrate(db: Database.Database): void {
  // Create version tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
    )
  `);

  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })
      ?.v ?? 0;

  if (currentVersion < 1) applyV1(db);
}

function applyV1(db: Database.Database): void {
  db.exec(`
    -- ============================================================
    -- Layer 1: Audit Events (hash-chained, append-only)
    -- ============================================================

    CREATE TABLE audit_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id        TEXT    NOT NULL UNIQUE,

        -- Timestamps
        timestamp_utc   TEXT    NOT NULL,
        server_timestamp TEXT   NOT NULL,
        timestamp_ms    INTEGER NOT NULL,

        -- Classification
        event_type      TEXT    NOT NULL,
        component       TEXT    NOT NULL,
        severity        TEXT    NOT NULL CHECK (severity IN ('critical','significant','routine','debug')),
        retention_class TEXT    NOT NULL CHECK (retention_class IN ('accounting','security','operational','debug')),
        evidence_grade  TEXT    NOT NULL CHECK (evidence_grade IN ('mechanism','convention')) DEFAULT 'mechanism',

        -- Payload (canonical JSON per RFC 8785)
        payload         TEXT    NOT NULL,

        -- Hash chain
        prev_hash       TEXT    NOT NULL,
        entry_hash      TEXT    NOT NULL,

        -- RFC 3161 checkpoint reference
        checkpoint_id   INTEGER REFERENCES checkpoints(id),

        -- Trace context (denormalized for fast queries)
        trace_id        TEXT,
        session_id      TEXT,
        parent_event_id TEXT,

        -- GDPR metadata
        contains_pii    INTEGER NOT NULL DEFAULT 0,
        erasure_eligible INTEGER NOT NULL DEFAULT 1,

        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
    );

    -- Performance indexes
    CREATE INDEX idx_events_timestamp   ON audit_events(timestamp_ms);
    CREATE INDEX idx_events_trace       ON audit_events(trace_id) WHERE trace_id IS NOT NULL;
    CREATE INDEX idx_events_session     ON audit_events(session_id) WHERE session_id IS NOT NULL;
    CREATE INDEX idx_events_type        ON audit_events(event_type);
    CREATE INDEX idx_events_component   ON audit_events(component);
    CREATE INDEX idx_events_severity    ON audit_events(severity);
    CREATE INDEX idx_events_retention   ON audit_events(retention_class, timestamp_ms);

    -- Append-only enforcement: block updates unconditionally
    CREATE TRIGGER prevent_event_update BEFORE UPDATE ON audit_events
    BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only: updates are forbidden');
    END;

    -- Block deletion of protected records (accounting/legal retention)
    CREATE TRIGGER prevent_protected_delete BEFORE DELETE ON audit_events
    FOR EACH ROW WHEN OLD.erasure_eligible = 0
    BEGIN
        SELECT RAISE(ABORT, 'Protected audit event: deletion forbidden (accounting/legal retention)');
    END;

    -- ============================================================
    -- Layer 2: Session Details
    -- ============================================================

    CREATE TABLE session_details (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT    NOT NULL UNIQUE,
        session_type    TEXT    NOT NULL,

        started_at      TEXT    NOT NULL,
        ended_at        TEXT,
        environment     TEXT    NOT NULL,
        trace_id        TEXT,

        decision_summary TEXT,
        context_snapshot TEXT,

        retention_class TEXT    NOT NULL DEFAULT 'operational',
        expires_at      TEXT    NOT NULL,

        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
    );

    CREATE INDEX idx_sessions_trace  ON session_details(trace_id) WHERE trace_id IS NOT NULL;
    CREATE INDEX idx_sessions_expiry ON session_details(expires_at);

    -- ============================================================
    -- Layer 3: Debug / Raw (encrypted payloads)
    -- ============================================================

    CREATE TABLE debug_raw (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id          TEXT    NOT NULL REFERENCES audit_events(event_id),

        encrypted_payload BLOB   NOT NULL,
        encryption_iv     BLOB   NOT NULL,
        encryption_tag    BLOB   NOT NULL,

        expires_at        TEXT   NOT NULL,

        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
    );

    CREATE INDEX idx_debug_expiry ON debug_raw(expires_at);
    CREATE INDEX idx_debug_event  ON debug_raw(event_id);

    -- ============================================================
    -- RFC 3161 Checkpoints
    -- ============================================================

    CREATE TABLE checkpoints (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        checkpoint_at   TEXT    NOT NULL,
        last_event_id   INTEGER NOT NULL,
        last_entry_hash TEXT    NOT NULL,
        tsa_request     BLOB,
        tsa_response    BLOB,
        tsa_authority   TEXT,
        verified        INTEGER NOT NULL DEFAULT 0,

        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
    );

    -- ============================================================
    -- Erasure Requests (GDPR Article 17)
    -- ============================================================

    CREATE TABLE erasure_requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_at    TEXT    NOT NULL,
        data_subject_pseudonym TEXT NOT NULL,
        scope           TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processed','partial','denied')),
        processed_at    TEXT,
        events_deleted  INTEGER DEFAULT 0,
        events_retained INTEGER DEFAULT 0,
        retention_basis TEXT,
        notes           TEXT,

        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
    );

    -- ============================================================
    -- API Keys (per-component identity)
    -- Resolves debate critique C04/C18
    -- ============================================================

    CREATE TABLE api_keys (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash        TEXT    NOT NULL UNIQUE,
        component       TEXT    NOT NULL,
        scopes          TEXT    NOT NULL DEFAULT 'write',
        description     TEXT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
        revoked_at      TEXT,
        last_used_at    TEXT
    );

    -- Track schema version
    INSERT INTO schema_version (version) VALUES (1);
  `);
}

export function getDataDir(): string {
  return process.env.VERDANDI_DATA_DIR ?? join(process.cwd(), 'data');
}
