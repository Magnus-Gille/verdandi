import type Database from 'better-sqlite3';

export const SUPPORTED_SCHEMA_VERSION = 1;

const REQUIRED_TABLES = [
  'api_keys',
  'audit_events',
  'checkpoints',
  'debug_raw',
  'erasure_requests',
  'schema_version',
  'session_details',
] as const;

const REQUIRED_EVENT_INDEXES = [
  'idx_events_component',
  'idx_events_retention',
  'idx_events_session',
  'idx_events_severity',
  'idx_events_timestamp',
  'idx_events_trace',
  'idx_events_type',
] as const;

const REQUIRED_EVENT_COLUMNS = [
  'event_id',
  'timestamp_utc',
  'server_timestamp',
  'timestamp_ms',
  'event_type',
  'component',
  'severity',
  'retention_class',
  'evidence_grade',
  'payload',
  'prev_hash',
  'entry_hash',
  'contains_pii',
  'erasure_eligible',
  'created_at',
] as const;

const REQUIRED_CHECKPOINT_COLUMNS = [
  'id',
  'checkpoint_at',
  'last_event_id',
  'last_entry_hash',
  'tsa_request',
  'tsa_response',
  'tsa_authority',
  'verified',
  'created_at',
] as const;

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
  const missingTables = REQUIRED_TABLES.filter((name) => !tableNames.has(name));
  violations.push(...missingTables.map((name) => `missing required table: ${name}`));

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

  if (tableNames.has('audit_events')) {
    const columns = db.pragma('table_info(audit_events)') as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const columnMap = new Map(columns.map((column) => [column.name, column]));
    for (const name of REQUIRED_EVENT_COLUMNS) {
      const column = columnMap.get(name);
      if (!column) {
        violations.push(`audit_events missing column: ${name}`);
      } else if (column.notnull !== 1) {
        violations.push(`audit_events.${name} must be NOT NULL`);
      }
    }
    if (columnMap.get('id')?.pk !== 1) {
      violations.push('audit_events.id must be the primary key');
    }

    const auditSql = normalizeSql(
      objects.find((row) => row.type === 'table' && row.name === 'audit_events')?.sql ?? ''
    );
    for (const fragment of [
      "check(severityin('critical','significant','routine','debug'))",
      "check(retention_classin('accounting','security','operational','debug'))",
      "check(evidence_gradein('mechanism','convention'))",
    ]) {
      if (!auditSql.includes(fragment)) {
        violations.push(`audit_events missing constraint: ${fragment}`);
      }
    }

    const eventIndexes = new Set(
      objects
        .filter((row) => row.type === 'index' && row.tbl_name === 'audit_events')
        .map((row) => row.name)
    );
    for (const name of REQUIRED_EVENT_INDEXES) {
      if (!eventIndexes.has(name)) violations.push(`missing audit_events index: ${name}`);
    }
    if (!hasUniqueIndex(db, 'audit_events', ['event_id'])) {
      violations.push('audit_events.event_id must have a single-column UNIQUE index');
    }
  }

  if (tableNames.has('api_keys') && !hasUniqueIndex(db, 'api_keys', ['key_hash'])) {
    violations.push('api_keys.key_hash must have a single-column UNIQUE index');
  }

  if (tableNames.has('checkpoints')) {
    const columns = new Map(
      (db.pragma('table_info(checkpoints)') as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>).map((column) => [column.name, column])
    );
    for (const name of REQUIRED_CHECKPOINT_COLUMNS) {
      if (!columns.has(name)) violations.push(`checkpoints missing column: ${name}`);
    }
    for (const name of ['checkpoint_at', 'last_event_id', 'last_entry_hash', 'verified', 'created_at']) {
      if (columns.get(name)?.notnull !== 1) {
        violations.push(`checkpoints.${name} must exist and be NOT NULL`);
      }
    }
    if (columns.get('id')?.pk !== 1) violations.push('checkpoints.id must be the primary key');
  }

  validateTrigger(
    objects,
    'prevent_event_update',
    `
      CREATE TRIGGER prevent_event_update BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only: updates are forbidden');
      END
    `,
    violations
  );
  validateTrigger(
    objects,
    'prevent_protected_delete',
    `
      CREATE TRIGGER prevent_protected_delete BEFORE DELETE ON audit_events
      FOR EACH ROW WHEN OLD.erasure_eligible = 0
      BEGIN
        SELECT RAISE(ABORT, 'Protected audit event: deletion forbidden (accounting/legal retention)');
      END
    `,
    violations
  );

  return {
    valid: violations.length === 0,
    schema_version: schemaVersion,
    supported_schema_version: SUPPORTED_SCHEMA_VERSION,
    missing_tables: missingTables,
    violations,
  };
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
    }>).sort((a, b) => a.seqno - b.seqno).map((column) => column.name);
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
    return;
  }
  const sql = normalizeSql(trigger.sql ?? '');
  if (sql !== normalizeSql(expectedSql)) {
    violations.push(`${name} does not match the supported append-only trigger definition`);
  }
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, '');
}
