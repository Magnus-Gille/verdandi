import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { AppendWorker, verifyChain } from '../src/hash-chain.js';
import { canonicalize } from '../src/canonical.js';
import { redact } from '../src/redaction.js';
import { classifyRetention, assignEvidenceGrade } from '../src/classification.js';
import { registerApiKey, createAuthenticator } from '../src/auth.js';
import { IngestPipeline } from '../src/ingest.js';

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
