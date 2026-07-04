import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { AppendWorker } from '../src/hash-chain.js';
import { registerApiKey } from '../src/auth.js';
import { IngestPipeline } from '../src/ingest.js';
import { HUGIN_EVENT_TYPES, RATATOSKR_EVENT_TYPES } from '../src/event-types.js';

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

// ============================================================
// Multi-environment ingest seam (issue #10) — canonical event
// types for the two highest-value Pi-side emitters.
//
// This table mirrors docs/multi-env-ingest-design.md §3.1 exactly,
// so a drift between the doc, the exported constants, and the
// server's actual classification behavior fails a test.
// ============================================================

interface Case {
  component: 'hugin' | 'ratatoskr';
  eventType: string;
  severity: 'critical' | 'significant' | 'routine' | 'debug';
  resourceType: string;
  expectedRetention: string;
  expectedEvidenceGrade: string;
}

const CASES: Case[] = [
  {
    component: 'hugin',
    eventType: HUGIN_EVENT_TYPES.TASK_START,
    severity: 'routine',
    resourceType: 'task',
    expectedRetention: 'operational',
    expectedEvidenceGrade: 'mechanism',
  },
  {
    component: 'hugin',
    eventType: HUGIN_EVENT_TYPES.TASK_COMPLETE,
    severity: 'routine',
    resourceType: 'task',
    expectedRetention: 'operational',
    expectedEvidenceGrade: 'mechanism',
  },
  {
    component: 'hugin',
    eventType: HUGIN_EVENT_TYPES.TASK_FAIL,
    severity: 'significant',
    resourceType: 'task',
    expectedRetention: 'operational',
    expectedEvidenceGrade: 'mechanism',
  },
  {
    component: 'hugin',
    eventType: HUGIN_EVENT_TYPES.TASK_TIMEOUT,
    severity: 'significant',
    resourceType: 'task',
    expectedRetention: 'operational',
    expectedEvidenceGrade: 'mechanism',
  },
  {
    component: 'ratatoskr',
    eventType: RATATOSKR_EVENT_TYPES.MESSAGE_RECEIVED,
    severity: 'debug',
    resourceType: 'telegram_message',
    expectedRetention: 'debug',
    expectedEvidenceGrade: 'mechanism',
  },
  {
    component: 'ratatoskr',
    eventType: RATATOSKR_EVENT_TYPES.ACTION_EXECUTE,
    severity: 'routine',
    resourceType: 'concierge_action',
    expectedRetention: 'operational',
    expectedEvidenceGrade: 'mechanism',
  },
  {
    component: 'ratatoskr',
    eventType: RATATOSKR_EVENT_TYPES.DECISION_ESCALATE,
    severity: 'significant',
    resourceType: 'concierge_escalation',
    expectedRetention: 'operational',
    expectedEvidenceGrade: 'mechanism',
  },
];

describe.each(CASES)(
  '$component event type $eventType',
  ({ component, eventType, severity, resourceType, expectedRetention, expectedEvidenceGrade }) => {
    it(`lands as ${expectedEvidenceGrade}/${expectedRetention}`, async () => {
      const { key } = registerApiKey(db, component, ['write']);
      const pipeline = new IngestPipeline(db, new AppendWorker(db));

      const result = await pipeline.ingest(`Bearer ${key}`, {
        event_type: eventType,
        severity,
        action: { verb: 'execute', resource_type: resourceType, resource_id: 'r-1' },
      });

      expect(result.ok).toBe(true);
      const row = db.prepare(
        'SELECT component, evidence_grade, retention_class FROM audit_events WHERE event_id = ?'
      ).get(result.ok ? result.event_id : '') as Record<string, string>;
      expect(row.component).toBe(component);
      expect(row.evidence_grade).toBe(expectedEvidenceGrade);
      expect(row.retention_class).toBe(expectedRetention);
    });
  }
);
