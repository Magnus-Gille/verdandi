import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { AppendWorker, verifyChain } from '../src/hash-chain.js';
import { canonicalize } from '../src/canonical.js';
import { redact } from '../src/redaction.js';
import { classifyRetention, assignEvidenceGrade } from '../src/classification.js';
import { registerApiKey, createAuthenticator } from '../src/auth.js';
import { IngestPipeline, type BatchIngestResult } from '../src/ingest.js';

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

// ============================================================
// Canonical JSON (RFC 8785)
// ============================================================

describe('canonicalize', () => {
  it('sorts top-level keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys recursively', () => {
    // This is the critical fix for C01 — nested keys must be preserved
    const input = { outer: { z: 1, a: 2 }, first: true };
    const result = canonicalize(input);
    expect(result).toBe('{"first":true,"outer":{"a":2,"z":1}}');
  });

  it('handles arrays without sorting elements', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles deeply nested structures', () => {
    const input = {
      action: { verb: 'create', detail: 'test' },
      actors: [{ role: 'executor', id: 'noxctl' }],
      attribution: { level: 'human_approved', dwell_time_ms: 5000 },
    };
    const result = canonicalize(input);
    // All keys at every level should be sorted
    expect(result).toContain('"action":{"detail":"test","verb":"create"}');
    expect(result).toContain('"attribution":{"dwell_time_ms":5000,"level":"human_approved"}');
  });

  it('omits undefined values', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles null', () => {
    expect(canonicalize(null)).toBe('null');
  });

  it('is deterministic across calls', () => {
    const obj = { z: { y: 1, x: 2 }, a: [3, 2, 1] };
    expect(canonicalize(obj)).toBe(canonicalize(obj));
  });
});

// ============================================================
// Hash Chain
// ============================================================

describe('AppendWorker', () => {
  it('appends events with correct hash chain', async () => {
    const worker = new AppendWorker(db);

    const r1 = await worker.append({
      event_id: 'evt-001',
      event_type: 'accounting.booking.create',
      component: 'noxctl',
      severity: 'significant',
      retention_class: 'accounting',
      evidence_grade: 'mechanism',
      timestamp: '2026-04-03T10:00:00Z',
      action: { verb: 'create', resource_type: 'voucher' },
    });

    expect(r1.chain_position).toBe(1);
    expect(r1.entry_hash).toBeTruthy();

    const r2 = await worker.append({
      event_id: 'evt-002',
      event_type: 'memory.state.write',
      component: 'hugin',
      severity: 'routine',
      retention_class: 'operational',
      evidence_grade: 'mechanism',
      timestamp: '2026-04-03T10:01:00Z',
      action: { verb: 'write', resource_type: 'munin_entry' },
    });

    expect(r2.chain_position).toBe(2);

    // Verify the chain
    const verification = verifyChain(db);
    expect(verification.valid).toBe(true);
    expect(verification.events_checked).toBe(2);
  });

  it('handles idempotent re-append', async () => {
    const worker = new AppendWorker(db);

    const event = {
      event_id: 'evt-dedup',
      event_type: 'task.submit',
      component: 'hugin',
      severity: 'routine',
      retention_class: 'operational',
      evidence_grade: 'mechanism',
      timestamp: '2026-04-03T10:00:00Z',
      action: { verb: 'submit', resource_type: 'hugin_task' },
    };

    const r1 = await worker.append(event);
    const r2 = await worker.append(event);

    // Same event_id returns the same result, not a duplicate
    expect(r1.event_id).toBe(r2.event_id);
    expect(r1.chain_position).toBe(r2.chain_position);

    // Only one event in the chain
    const count = (db.prepare('SELECT COUNT(*) as c FROM audit_events').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('verifyChain', () => {
  it('detects tampered payload', async () => {
    const worker = new AppendWorker(db);

    await worker.append({
      event_id: 'evt-tamper-1',
      event_type: 'task.submit',
      component: 'hugin',
      severity: 'routine',
      retention_class: 'operational',
      evidence_grade: 'mechanism',
      timestamp: '2026-04-03T10:00:00Z',
      action: { verb: 'submit', resource_type: 'task' },
    });

    // Tamper with the payload by directly modifying the DB
    // (bypassing the trigger by dropping it temporarily)
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER prevent_event_update');
    db.prepare("UPDATE audit_events SET payload = '{\"tampered\":true}' WHERE id = 1").run();

    const result = verifyChain(db);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Tampered');
  });
});

// ============================================================
// Redaction
// ============================================================

describe('redact', () => {
  it('strips bearer tokens', () => {
    const input = { detail: 'Called API with Bearer sk-ant-abc123def456ghi789jkl012' };
    const result = redact(input) as Record<string, unknown>;
    expect(result.detail).toContain('[REDACTED:token]');
    expect(result.detail).not.toContain('sk-ant-abc123');
  });

  it('strips Anthropic API keys', () => {
    // When embedded in a key=value pattern, the generic api_key rule matches first.
    // When standalone, the anthropic_key rule matches.
    const input = { config: 'ANTHROPIC_API_KEY=sk-ant-abcdefghij1234567890' };
    const result = redact(input) as Record<string, unknown>;
    expect(result.config).toContain('[REDACTED:');
    expect(result.config).not.toContain('sk-ant-abcdefghij');

    // Standalone Anthropic key
    const input2 = { key: 'sk-ant-abcdefghijklmnopqrstuvwxyz' };
    const result2 = redact(input2) as Record<string, unknown>;
    expect(result2.key).toContain('[REDACTED:anthropic_key]');
  });

  it('strips JWT tokens', () => {
    const input = { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.dGVzdHNpZw' };
    const result = redact(input) as Record<string, unknown>;
    expect(result.token).toContain('[REDACTED:jwt]');
  });

  it('drops structural fields', () => {
    const input = { transcript_path: '/Users/magnus/.claude/sessions/abc', tool_response: { big: 'data' }, keep_me: true };
    const result = redact(input) as Record<string, unknown>;
    expect(result).not.toHaveProperty('transcript_path');
    expect(result).not.toHaveProperty('tool_response');
    expect(result).toHaveProperty('keep_me');
  });

  it('redacts nested objects', () => {
    const input = {
      outer: {
        inner: {
          secret: 'password=SuperSecret123!',
        },
      },
    };
    const result = redact(input) as Record<string, unknown>;
    expect(JSON.stringify(result)).toContain('[REDACTED:password]');
  });
});

// ============================================================
// Classification
// ============================================================

describe('classifyRetention', () => {
  it('classifies accounting events as accounting', () => {
    expect(classifyRetention('accounting.booking.create', 'significant')).toBe('accounting');
  });

  it('classifies debug events as debug', () => {
    expect(classifyRetention('agent.tool.call', 'debug')).toBe('debug');
  });

  it('classifies system events as security', () => {
    expect(classifyRetention('system.startup', 'routine')).toBe('security');
  });

  it('classifies routine non-system events as operational', () => {
    expect(classifyRetention('task.submit', 'routine')).toBe('operational');
  });
});

describe('assignEvidenceGrade', () => {
  it('marks hook-generated agent events as mechanism', () => {
    expect(assignEvidenceGrade('agent.file.edit', 'claude-code')).toBe('mechanism');
  });

  it('marks decision events as convention', () => {
    expect(assignEvidenceGrade('decision.approve', 'claude-code')).toBe('convention');
  });

  it('marks hugin task lifecycle events as mechanism', () => {
    expect(assignEvidenceGrade('task.execution.complete', 'hugin')).toBe('mechanism');
  });

  it('marks ratatoskr telegram events as mechanism', () => {
    expect(assignEvidenceGrade('telegram.message.received', 'ratatoskr')).toBe('mechanism');
  });
});

// ============================================================
// Auth
// ============================================================

describe('auth', () => {
  it('registers and authenticates a key', () => {
    const { key } = registerApiKey(db, 'noxctl', ['write']);
    const authenticate = createAuthenticator(db);

    const result = authenticate(`Bearer ${key}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.component).toBe('noxctl');
      expect(result.scopes).toContain('write');
    }
  });

  it('rejects invalid keys', () => {
    const authenticate = createAuthenticator(db);
    const result = authenticate('Bearer vrd_fake_00000000000000000000000000000000');
    expect(result.ok).toBe(false);
  });

  it('rejects missing auth header', () => {
    const authenticate = createAuthenticator(db);
    const result = authenticate(undefined);
    expect(result.ok).toBe(false);
  });
});

// ============================================================
// Full Ingest Pipeline
// ============================================================

describe('IngestPipeline', () => {
  it('ingests a valid event end-to-end', async () => {
    const { key } = registerApiKey(db, 'noxctl', ['write']);
    const worker = new AppendWorker(db);
    const pipeline = new IngestPipeline(db, worker);

    const result = await pipeline.ingest(`Bearer ${key}`, {
      event_type: 'accounting.booking.create',
      severity: 'significant',
      action: {
        verb: 'create',
        resource_type: 'fortnox_voucher',
        resource_id: 'FV-2026-0147',
        detail: 'Created voucher: 8,500 SEK debit 6071, credit 2440',
      },
      actors: [
        { actor_id: 'magnus', actor_type: 'human', role: 'approver' },
        { actor_id: 'noxctl', actor_type: 'agent', role: 'executor' },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chain_position).toBe(1);
      expect(result.entry_hash).toBeTruthy();
    }

    // Verify: component was overridden by server from API key
    const row = db.prepare('SELECT component, retention_class, evidence_grade FROM audit_events WHERE id = 1').get() as Record<string, string>;
    expect(row.component).toBe('noxctl'); // Derived from API key
    expect(row.retention_class).toBe('accounting'); // Server-classified
    expect(row.evidence_grade).toBe('mechanism');

    // Verify chain integrity
    const verification = verifyChain(db);
    expect(verification.valid).toBe(true);
  });

  it('rejects invalid events', async () => {
    const { key } = registerApiKey(db, 'test', ['write']);
    const worker = new AppendWorker(db);
    const pipeline = new IngestPipeline(db, worker);

    const result = await pipeline.ingest(`Bearer ${key}`, {
      // Missing required fields
      severity: 'routine',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it('rejects unauthenticated requests', async () => {
    const worker = new AppendWorker(db);
    const pipeline = new IngestPipeline(db, worker);

    const result = await pipeline.ingest(undefined, {
      event_type: 'task.submit',
      severity: 'routine',
      action: { verb: 'submit', resource_type: 'task' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it('redacts secrets in event payloads', async () => {
    const { key } = registerApiKey(db, 'claude-code', ['write']);
    const worker = new AppendWorker(db);
    const pipeline = new IngestPipeline(db, worker);

    const result = await pipeline.ingest(`Bearer ${key}`, {
      event_type: 'agent.shell.execute',
      severity: 'debug',
      action: {
        verb: 'execute',
        resource_type: 'shell',
        detail: 'curl -H "Authorization: Bearer sk-ant-secret123456789012345" https://api.example.com',
      },
    });

    expect(result.ok).toBe(true);

    // Check that the stored payload has redacted secrets
    const row = db.prepare('SELECT payload FROM audit_events WHERE id = 1').get() as { payload: string };
    expect(row.payload).toContain('[REDACTED');
    expect(row.payload).not.toContain('sk-ant-secret');
  });
});

// ============================================================
// Post-MCP severity mapping — CLI shell commands (Issue #9)
//
// After the May 2026 MCP→CLI rationalization the money/email actions
// arrive as Bash tool calls (noxctl / m365 / himalaya / gws), not the
// removed mcp__fortnox__ / mcp__microsoft-mcp__ tool names. The hook
// transform must inspect the shell command so these don't land as
// debug-grade shell events with the wrong retention class.
// ============================================================

describe('hook severity mapping (post-MCP CLI shell commands)', () => {
  async function ingestBashHook(command: string) {
    const { key } = registerApiKey(db, 'claude-code', ['write']);
    const worker = new AppendWorker(db);
    const pipeline = new IngestPipeline(db, worker);
    const result = await pipeline.ingestHook(`Bearer ${key}`, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command, description: 'run a command' },
      session_id: 'sess-9',
      tool_use_id: 'tu-1',
    });
    return result;
  }

  function storedRow() {
    return db.prepare(
      'SELECT event_type, severity, retention_class FROM audit_events WHERE id = 1'
    ).get() as { event_type: string; severity: string; retention_class: string };
  }

  it('maps noxctl (Fortnox) shell commands to accounting severity', async () => {
    const result = await ingestBashHook('noxctl invoice create --amount 8500 --customer 42');
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('accounting.booking.create');
    expect(row.severity).toBe('significant');
    expect(row.retention_class).toBe('accounting');
  });

  it('maps m365 mail send to email.send', async () => {
    const result = await ingestBashHook(
      'm365 outlook mail send --to a@b.com --subject Hi --bodyContents "hello"'
    );
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('email.send');
    expect(row.severity).toBe('significant');
    expect(row.retention_class).toBe('operational');
  });

  it('maps himalaya message reply/write to email.send', async () => {
    const result = await ingestBashHook('himalaya message reply -a gille 1234');
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('email.send');
    expect(row.severity).toBe('significant');
  });

  it('maps gws gmail send to email.send', async () => {
    const result = await ingestBashHook(
      "gws gmail message send --params '{\"to\":\"x@y.com\"}'"
    );
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('email.send');
  });

  it('leaves ordinary shell commands as debug-grade shell events', async () => {
    const result = await ingestBashHook('ls -la /tmp');
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('agent.shell.execute');
    expect(row.severity).toBe('debug');
    expect(row.retention_class).toBe('debug');
  });

  it('does not misclassify a read that merely mentions send/mail', async () => {
    const result = await ingestBashHook('m365 outlook message list --folderName inbox');
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('agent.shell.execute');
    expect(row.severity).toBe('debug');
  });

  it('does not classify a grep for the sendMail token as an email send', async () => {
    const result = await ingestBashHook('grep -R sendMail docs/');
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('agent.shell.execute');
    expect(row.severity).toBe('debug');
  });

  it('classifies a Graph /sendMail POST as email.send', async () => {
    const result = await ingestBashHook(
      'm365 request -u "https://graph.microsoft.com/v1.0/me/sendMail" -m post -b @body.json'
    );
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('email.send');
  });

  it('classifies path-qualified and wrapped noxctl invocations as accounting', async () => {
    const result = await ingestBashHook("bash -lc './noxctl invoice create --amount 8500'");
    expect(result.ok).toBe(true);
    const row = storedRow();
    expect(row.event_type).toBe('accounting.booking.create');
    expect(row.severity).toBe('significant');
  });
});

// ============================================================
// Write-scope enforcement on ingest endpoints (Issue #9 / Codex #14)
//
// Once read-only keys become real (GET endpoints now require 'read'), the
// write paths must reject read-only keys — otherwise a read consumer could
// forge events into the append-only log.
// ============================================================

describe('write scope enforcement', () => {
  function newPipeline() {
    const worker = new AppendWorker(db);
    return new IngestPipeline(db, worker);
  }

  it('rejects a read-only key on single ingest (403)', async () => {
    const { key } = registerApiKey(db, 'heimdall', ['read']);
    const result = await newPipeline().ingest(`Bearer ${key}`, {
      event_type: 'accounting.booking.create',
      severity: 'significant',
      action: { verb: 'create', resource_type: 'voucher' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects a read-only key on batch ingest (403)', async () => {
    const { key } = registerApiKey(db, 'heimdall', ['read']);
    const result = await newPipeline().ingestBatch(`Bearer ${key}`, { events: [] });
    expect('ok' in result && result.ok === false).toBe(true);
    if ('status' in result) expect(result.status).toBe(403);
  });

  it('rejects a read-only key on hook ingest (403)', async () => {
    const { key } = registerApiKey(db, 'heimdall', ['read']);
    const result = await newPipeline().ingestHook(`Bearer ${key}`, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'noxctl invoice create' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('allows an admin key to write', async () => {
    const { key } = registerApiKey(db, 'root', ['admin']);
    const result = await newPipeline().ingest(`Bearer ${key}`, {
      event_type: 'accounting.booking.create',
      severity: 'significant',
      action: { verb: 'create', resource_type: 'voucher' },
    });
    expect(result.ok).toBe(true);
  });
});

// ============================================================
// Batch ingest accepts hook-format events (Issue #9)
//
// sync-outbox.sh posts raw hook-format lines to /api/events/batch.
// The batch path must transform hook-format events (as the single-hook
// endpoint does) while still accepting full-format events.
// ============================================================

describe('batch ingest — hook-format events', () => {
  it('transforms and classifies hook-format events, skipping filtered ones', async () => {
    const { key } = registerApiKey(db, 'claude-code', ['write']);
    const worker = new AppendWorker(db);
    const pipeline = new IngestPipeline(db, worker);

    const result = await pipeline.ingestBatch(`Bearer ${key}`, {
      events: [
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'noxctl invoice create --amount 21000' },
          session_id: 's',
        },
        // A Read tool call is not significant — should be filtered, not rejected
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/x' },
          session_id: 's',
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git status' },
          session_id: 's',
        },
      ],
    });

    expect('ok' in result && result.ok === false).toBe(false);
    const batch = result as BatchIngestResult;
    expect(batch.accepted).toBe(2); // noxctl + git status
    expect(batch.filtered).toBe(1); // Read
    expect(batch.rejected).toBe(0);

    const types = (
      db.prepare('SELECT event_type FROM audit_events ORDER BY id').all() as Array<{ event_type: string }>
    ).map(r => r.event_type);
    expect(types).toContain('accounting.booking.create');
    expect(types).toContain('agent.shell.execute');
  });

  it('still accepts full-format events in a batch', async () => {
    const { key } = registerApiKey(db, 'noxctl', ['write']);
    const worker = new AppendWorker(db);
    const pipeline = new IngestPipeline(db, worker);

    const result = await pipeline.ingestBatch(`Bearer ${key}`, {
      events: [
        {
          event_type: 'accounting.booking.create',
          severity: 'significant',
          action: { verb: 'create', resource_type: 'voucher', resource_id: 'FV-1' },
        },
      ],
    });

    const batch = result as BatchIngestResult;
    expect(batch.accepted).toBe(1);
    expect(batch.filtered).toBe(0);
    expect(batch.rejected).toBe(0);
  });
});
