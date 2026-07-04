/**
 * Canonical event-type taxonomy for the multi-environment ingest seam (issue #10).
 *
 * These are the event types the two highest-value Pi-side emitters — hugin
 * (task execution) and ratatoskr (Telegram concierge) — should use so that
 * classification.ts's evidence-grade and retention rules apply as designed.
 * See docs/multi-env-ingest-design.md for the full ingest design.
 */

export const HUGIN_EVENT_TYPES = {
  TASK_START: 'task.execution.start',
  TASK_COMPLETE: 'task.execution.complete',
  TASK_FAIL: 'task.execution.fail',
  TASK_TIMEOUT: 'task.execution.timeout',
} as const;

export const RATATOSKR_EVENT_TYPES = {
  MESSAGE_RECEIVED: 'telegram.message.received',
  ACTION_EXECUTE: 'telegram.action.execute',
  DECISION_ESCALATE: 'telegram.decision.escalate',
} as const;
