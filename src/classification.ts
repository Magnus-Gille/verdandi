/**
 * Server-side retention classification and evidence grade assignment.
 * Resolves debate critique C09: never trust client-supplied retention_class.
 * Resolves debate critique C25/C27: two explicit evidence grades.
 */

export type RetentionClass = 'accounting' | 'security' | 'operational' | 'debug';
export type EvidenceGrade = 'mechanism' | 'convention';
export type Severity = 'critical' | 'significant' | 'routine' | 'debug';

/**
 * Compute retention class server-side from event_type and severity.
 * Client-supplied retention_class is ALWAYS ignored.
 */
export function classifyRetention(eventType: string, severity: Severity): RetentionClass {
  // Accounting events: 7-year retention, not erasure-eligible
  if (eventType.startsWith('accounting.')) {
    return 'accounting';
  }

  // Decision events related to accounting inherit accounting retention
  if (eventType.startsWith('decision.') && severity === 'critical') {
    return 'accounting';
  }

  // Security and system events
  if (eventType.startsWith('system.') || severity === 'critical') {
    return 'security';
  }

  // Debug events
  if (severity === 'debug') {
    return 'debug';
  }

  // Everything else: operational
  return 'operational';
}

/**
 * Determine whether an event is erasure-eligible based on retention class.
 * Accounting records are protected under Bokföringslag Art 17(3)(b).
 */
export function isErasureEligible(retentionClass: RetentionClass): boolean {
  return retentionClass !== 'accounting';
}

/**
 * Retention periods by class.
 */
export const RETENTION_PERIODS: Record<RetentionClass, { months: number; description: string }> = {
  accounting: { months: 84, description: '7 years from fiscal year end (Bokföringslag 7 kap 2§)' },
  security: { months: 12, description: '12 months (legitimate interest)' },
  operational: { months: 6, description: '6 months (legitimate interest)' },
  debug: { months: 3, description: '1-3 months (auto-purged)' },
};

/**
 * Assign evidence grade based on event source.
 * Mechanism-captured: automatically produced by a software hook.
 * Convention-captured: voluntarily emitted by an agent or human.
 */
export function assignEvidenceGrade(eventType: string, component: string): EvidenceGrade {
  // Hook-generated events are always mechanism-captured
  if (component === 'claude-code' && eventType.startsWith('agent.')) {
    return 'mechanism';
  }

  // System events are mechanism-captured
  if (eventType.startsWith('system.')) {
    return 'mechanism';
  }

  // Task lifecycle events from Hugin are mechanism-captured
  if (component === 'hugin' && eventType.startsWith('task.')) {
    return 'mechanism';
  }

  // Telegram events from Ratatoskr are mechanism-captured
  if (component === 'ratatoskr' && eventType.startsWith('telegram.')) {
    return 'mechanism';
  }

  // Decision events are convention-captured (voluntarily emitted)
  if (eventType.startsWith('decision.')) {
    return 'convention';
  }

  // Default to mechanism for tool-generated events
  return 'mechanism';
}
