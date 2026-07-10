import type Database from 'better-sqlite3';

export const SUPPORTED_SCHEMA_VERSION = 1;

interface ColumnContract {
  name: string;
  type: 'BLOB' | 'INTEGER' | 'TEXT';
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

const CREATED_AT = "strftime('%Y-%m-%dT%H:%M:%f','now')";
const column = (
  name: string,
  type: ColumnContract['type'],
  notNull = false,
  primaryKey = false,
  defaultValue: string | null = null
): ColumnContract => ({ name, type, notNull, primaryKey, defaultValue });

const TABLE_CONTRACTS: Record<string, ColumnContract[]> = {
  schema_version: [
    column('version', 'INTEGER', false, true),
    column('applied_at', 'TEXT', true, false, CREATED_AT),
  ],
  audit_events: [
    column('id', 'INTEGER', false, true),
    column('event_id', 'TEXT', true),
    column('timestamp_utc', 'TEXT', true),
    column('server_timestamp', 'TEXT', true),
    column('timestamp_ms', 'INTEGER', true),
    column('event_type', 'TEXT', true),
    column('component', 'TEXT', true),
    column('severity', 'TEXT', true),
    column('retention_class', 'TEXT', true),
    column('evidence_grade', 'TEXT', true, false, "'mechanism'"),
    column('payload', 'TEXT', true),
    column('prev_hash', 'TEXT', true),
    column('entry_hash', 'TEXT', true),
    column('checkpoint_id', 'INTEGER'),
    column('trace_id', 'TEXT'),
    column('session_id', 'TEXT'),
    column('parent_event_id', 'TEXT'),
    column('contains_pii', 'INTEGER', true, false, '0'),
    column('erasure_eligible', 'INTEGER', true, false, '1'),
    column('created_at', 'TEXT', true, false, CREATED_AT),
  ],
  session_details: [
    column('id', 'INTEGER', false, true),
    column('session_id', 'TEXT', true),
    column('session_type', 'TEXT', true),
    column('started_at', 'TEXT', true),
    column('ended_at', 'TEXT'),
    column('environment', 'TEXT', true),
    column('trace_id', 'TEXT'),
    column('decision_summary', 'TEXT'),
    column('context_snapshot', 'TEXT'),
    column('retention_class', 'TEXT', true, false, "'operational'"),
    column('expires_at', 'TEXT', true),
    column('created_at', 'TEXT', true, false, CREATED_AT),
  ],
  debug_raw: [
    column('id', 'INTEGER', false, true),
    column('event_id', 'TEXT', true),
    column('encrypted_payload', 'BLOB', true),
    column('encryption_iv', 'BLOB', true),
    column('encryption_tag', 'BLOB', true),
    column('expires_at', 'TEXT', true),
    column('created_at', 'TEXT', true, false, CREATED_AT),
  ],
  checkpoints: [
    column('id', 'INTEGER', false, true),
    column('checkpoint_at', 'TEXT', true),
    column('last_event_id', 'INTEGER', true),
    column('last_entry_hash', 'TEXT', true),
    column('tsa_request', 'BLOB'),
    column('tsa_response', 'BLOB'),
    column('tsa_authority', 'TEXT'),
    column('verified', 'INTEGER', true, false, '0'),
    column('created_at', 'TEXT', true, false, CREATED_AT),
  ],
  erasure_requests: [
    column('id', 'INTEGER', false, true),
    column('requested_at', 'TEXT', true),
    column('data_subject_pseudonym', 'TEXT', true),
    column('scope', 'TEXT', true),
    column('status', 'TEXT', true, false, "'pending'"),
    column('processed_at', 'TEXT'),
    column('events_deleted', 'INTEGER', false, false, '0'),
    column('events_retained', 'INTEGER', false, false, '0'),
    column('retention_basis', 'TEXT'),
    column('notes', 'TEXT'),
    column('created_at', 'TEXT', true, false, CREATED_AT),
  ],
  api_keys: [
    column('id', 'INTEGER', false, true),
    column('key_hash', 'TEXT', true),
    column('component', 'TEXT', true),
    column('scopes', 'TEXT', true, false, "'write'"),
    column('description', 'TEXT'),
    column('created_at', 'TEXT', true, false, CREATED_AT),
    column('revoked_at', 'TEXT'),
    column('last_used_at', 'TEXT'),
  ],
};

const INDEX_CONTRACTS: Record<string, string> = {
  idx_events_timestamp: 'CREATE INDEX idx_events_timestamp ON audit_events(timestamp_ms)',
  idx_events_trace:
    'CREATE INDEX idx_events_trace ON audit_events(trace_id) WHERE trace_id IS NOT NULL',
  idx_events_session:
    'CREATE INDEX idx_events_session ON audit_events(session_id) WHERE session_id IS NOT NULL',
  idx_events_type: 'CREATE INDEX idx_events_type ON audit_events(event_type)',
  idx_events_component: 'CREATE INDEX idx_events_component ON audit_events(component)',
  idx_events_severity: 'CREATE INDEX idx_events_severity ON audit_events(severity)',
  idx_events_retention:
    'CREATE INDEX idx_events_retention ON audit_events(retention_class, timestamp_ms)',
  idx_sessions_trace:
    'CREATE INDEX idx_sessions_trace ON session_details(trace_id) WHERE trace_id IS NOT NULL',
  idx_sessions_expiry: 'CREATE INDEX idx_sessions_expiry ON session_details(expires_at)',
  idx_debug_expiry: 'CREATE INDEX idx_debug_expiry ON debug_raw(expires_at)',
  idx_debug_event: 'CREATE INDEX idx_debug_event ON debug_raw(event_id)',
};

const RUNTIME_STATEMENTS: Record<string, string> = {
  'append event': `
    INSERT INTO audit_events (
      event_id, timestamp_utc, server_timestamp, timestamp_ms,
      event_type, component, severity, retention_class, evidence_grade,
      payload, prev_hash, entry_hash, trace_id, session_id, parent_event_id,
      contains_pii, erasure_eligible
    ) VALUES (
      @event_id, @timestamp_utc, @server_timestamp, @timestamp_ms,
      @event_type, @component, @severity, @retention_class, @evidence_grade,
      @payload, @prev_hash, @entry_hash, @trace_id, @session_id, @parent_event_id,
      @contains_pii, @erasure_eligible
    )
  `,
  'authenticate key':
    'SELECT id, component, scopes, revoked_at FROM api_keys WHERE key_hash = ?',
  'update key use':
    "UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%f','now') WHERE id = ?",
  'register key':
    'INSERT INTO api_keys (key_hash, component, scopes, description) VALUES (?, ?, ?, ?)',
  'query event list': `
    SELECT event_id, timestamp_utc, server_timestamp, event_type, component,
      severity, retention_class, evidence_grade, payload, trace_id, session_id, entry_hash
    FROM audit_events ORDER BY id DESC LIMIT ? OFFSET ?
  `,
  'query event detail': `
    SELECT event_id, timestamp_utc, server_timestamp, event_type, component,
      severity, retention_class, evidence_grade, payload, trace_id, session_id,
      prev_hash, entry_hash
    FROM audit_events WHERE event_id = ?
  `,
  'query trace filters':
    'SELECT id FROM audit_events WHERE trace_id = ? AND session_id = ? AND parent_event_id = ?',
  'query checkpoint head':
    'SELECT id, checkpoint_at, last_event_id, last_entry_hash, tsa_request, tsa_response, tsa_authority, verified, created_at FROM checkpoints ORDER BY id DESC LIMIT 1',
  'insert checkpoint':
    'INSERT INTO checkpoints (checkpoint_at, last_event_id, last_entry_hash, verified) VALUES (?, ?, ?, ?)',
};

export interface SchemaContractResult {
  valid: boolean;
  schema_version: number | null;
  supported_schema_version: number;
  missing_tables: string[];
  violations: string[];
}

export function inspectSchemaContract(db: Database.Database): SchemaContractResult {
  const violations: string[] = [];
  const objects = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger')
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const tableNames = new Set(objects.filter((row) => row.type === 'table').map((row) => row.name));
  const missingTables = Object.keys(TABLE_CONTRACTS).filter((name) => !tableNames.has(name));
  violations.push(...missingTables.map((name) => `missing required table: ${name}`));

  for (const [table, contract] of Object.entries(TABLE_CONTRACTS)) {
    if (tableNames.has(table)) validateTable(db, table, contract, violations);
  }

  let schemaVersion: number | null = null;
  if (tableNames.has('schema_version')) {
    const versions = (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{
      version: number;
    }>).map((row) => row.version);
    schemaVersion = versions.at(-1) ?? null;
    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      violations.push(
        `unsupported schema version: ${String(schemaVersion)} (supported: ${SUPPORTED_SCHEMA_VERSION})`
      );
    }
    if (JSON.stringify(versions) !== JSON.stringify([SUPPORTED_SCHEMA_VERSION])) {
      violations.push(`unexpected schema version history: ${JSON.stringify(versions)}`);
    }
  }

  const auditSql = normalizeSql(
    objects.find((row) => row.type === 'table' && row.name === 'audit_events')?.sql ?? ''
  );
  for (const fragment of [
    "check(severityin('critical','significant','routine','debug'))",
    "check(retention_classin('accounting','security','operational','debug'))",
    "check(evidence_gradein('mechanism','convention'))",
  ]) {
    if (!auditSql.includes(fragment)) violations.push(`audit_events missing constraint: ${fragment}`);
  }
  const erasureSql = normalizeSql(
    objects.find((row) => row.type === 'table' && row.name === 'erasure_requests')?.sql ?? ''
  );
  if (!erasureSql.includes("check(statusin('pending','processed','partial','denied'))")) {
    violations.push('erasure_requests missing supported status constraint');
  }

  for (const [name, expectedSql] of Object.entries(INDEX_CONTRACTS)) {
    const actual = objects.find((row) => row.type === 'index' && row.name === name)?.sql;
    if (!actual) violations.push(`missing required index: ${name}`);
    else if (normalizeSql(actual) !== normalizeSql(expectedSql)) {
      violations.push(`${name} does not match the supported index definition`);
    }
  }
  for (const [table, columns] of [
    ['audit_events', ['event_id']],
    ['session_details', ['session_id']],
    ['api_keys', ['key_hash']],
  ] as Array<[string, string[]]>) {
    if (tableNames.has(table) && !hasUniqueIndex(db, table, columns)) {
      violations.push(`${table}.${columns.join(',')} must have a UNIQUE index`);
    }
  }

  validateForeignKey(db, 'audit_events', 'checkpoint_id', 'checkpoints', 'id', violations);
  validateForeignKey(db, 'debug_raw', 'event_id', 'audit_events', 'event_id', violations);
  validateTrigger(
    objects,
    'prevent_event_update',
    `CREATE TRIGGER prevent_event_update BEFORE UPDATE ON audit_events
     BEGIN SELECT RAISE(ABORT, 'audit_events is append-only: updates are forbidden'); END`,
    violations
  );
  validateTrigger(
    objects,
    'prevent_protected_delete',
    `CREATE TRIGGER prevent_protected_delete BEFORE DELETE ON audit_events
     FOR EACH ROW WHEN OLD.erasure_eligible = 0
     BEGIN SELECT RAISE(ABORT,
       'Protected audit event: deletion forbidden (accounting/legal retention)'); END`,
    violations
  );

  if (missingTables.length === 0) validateRuntimeStatements(db, violations);

  return {
    valid: violations.length === 0,
    schema_version: schemaVersion,
    supported_schema_version: SUPPORTED_SCHEMA_VERSION,
    missing_tables: missingTables,
    violations,
  };
}

function validateTable(
  db: Database.Database,
  table: string,
  contract: ColumnContract[],
  violations: string[]
): void {
  const actual = db.pragma(`table_info(${table})`) as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const actualMap = new Map(actual.map((item) => [item.name, item]));
  for (const expected of contract) {
    const item = actualMap.get(expected.name);
    if (!item) {
      violations.push(`${table} missing column: ${expected.name}`);
      continue;
    }
    if (item.type.toUpperCase() !== expected.type) {
      violations.push(`${table}.${expected.name} must have type ${expected.type}`);
    }
    if ((item.notnull === 1) !== expected.notNull) {
      violations.push(`${table}.${expected.name} has wrong NOT NULL contract`);
    }
    if ((item.pk === 1) !== expected.primaryKey) {
      violations.push(`${table}.${expected.name} has wrong primary-key contract`);
    }
    if (normalizeSql(item.dflt_value ?? '') !== normalizeSql(expected.defaultValue ?? '')) {
      violations.push(`${table}.${expected.name} has wrong default value`);
    }
  }
  const expectedNames = new Set(contract.map((item) => item.name));
  for (const item of actual) {
    if (!expectedNames.has(item.name)) violations.push(`${table} has unsupported column: ${item.name}`);
  }
}

function validateRuntimeStatements(db: Database.Database, violations: string[]): void {
  for (const [name, sql] of Object.entries(RUNTIME_STATEMENTS)) {
    try {
      db.prepare(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      violations.push(`runtime SQL incompatible (${name}): ${message}`);
    }
  }
}

function validateForeignKey(
  db: Database.Database,
  table: string,
  from: string,
  targetTable: string,
  to: string,
  violations: string[]
): void {
  const rows = db.pragma(`foreign_key_list(${table})`) as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  if (!rows.some((row) => row.table === targetTable && row.from === from && row.to === to)) {
    violations.push(`${table}.${from} must reference ${targetTable}.${to}`);
  }
}

function hasUniqueIndex(
  db: Database.Database,
  table: string,
  expectedColumns: string[]
): boolean {
  const indexes = db.pragma(`index_list(${table})`) as Array<{ name: string; unique: number }>;
  return indexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = (db.pragma(`index_info(${JSON.stringify(index.name)})`) as Array<{
      seqno: number;
      name: string;
    }>).sort((a, b) => a.seqno - b.seqno).map((item) => item.name);
    return JSON.stringify(columns) === JSON.stringify(expectedColumns);
  });
}

function validateTrigger(
  objects: Array<{ type: string; name: string; sql: string | null }>,
  name: string,
  expectedSql: string,
  violations: string[]
): void {
  const trigger = objects.find((row) => row.type === 'trigger' && row.name === name);
  if (!trigger) {
    violations.push(`missing append-only trigger: ${name}`);
  } else if (normalizeSql(trigger.sql ?? '') !== normalizeSql(expectedSql)) {
    violations.push(`${name} does not match the supported append-only trigger definition`);
  }
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, '');
}
