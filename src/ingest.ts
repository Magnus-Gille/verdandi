/**
 * Ingest pipeline — the complete server-side event processing chain.
 * Implements the 10-stage pipeline from the ingest-trust spec §4.
 *
 * authenticate → validate → redact → override → classify → canonicalize → queue → append → dedup → respond
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { type AuthResult, createAuthenticator, type Scope } from './auth.js';
import { redact } from './redaction.js';
import { classifyRetention, assignEvidenceGrade, isErasureEligible, type Severity } from './classification.js';
import { AppendWorker } from './hash-chain.js';

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,4}$/;
const VALID_SEVERITIES = new Set(['critical', 'significant', 'routine', 'debug']);
const MAX_DETAIL_LENGTH = 2000;
const MAX_REASONING_LENGTH = 5000;
const MAX_ALTERNATIVES = 10;
const MAX_ACTORS = 10;
const MAX_BATCH_SIZE = 1000;

export interface IngestResult {
  ok: true;
  event_id: string;
  entry_hash: string;
  chain_position: number;
}

export interface IngestError {
  ok: false;
  status: number;
  error: string;
  duplicate?: boolean;
}

export interface BatchIngestResult {
  accepted: number;
  rejected: number;
  /** Hook-format events that transformed to nothing significant (e.g. Read/Glob). */
  filtered: number;
  results: Array<IngestResult | IngestError>;
  last_entry_hash?: string;
}

export class IngestPipeline {
  private authenticate: ReturnType<typeof createAuthenticator>;
  private appendWorker: AppendWorker;

  constructor(db: Database.Database, appendWorker: AppendWorker) {
    this.authenticate = createAuthenticator(db);
    this.appendWorker = appendWorker;
  }

  /**
   * Process a single event through the full pipeline.
   */
  async ingest(
    authHeader: string | undefined,
    body: unknown,
  ): Promise<IngestResult | IngestError> {
    // Stage 1: Authentication + write authorization
    const auth = this.authenticate(authHeader);
    if (!auth.ok) return auth;
    const scopeError = requireWriteScope(auth);
    if (scopeError) return scopeError;

    // Stage 2-8: Process the event
    return this.processEvent(auth, body);
  }

  /**
   * Process a batch of events.
   */
  async ingestBatch(
    authHeader: string | undefined,
    body: unknown,
  ): Promise<BatchIngestResult | IngestError> {
    // Stage 1: Authentication + write authorization
    const auth = this.authenticate(authHeader);
    if (!auth.ok) return auth;
    const scopeError = requireWriteScope(auth);
    if (scopeError) return scopeError;

    if (!body || typeof body !== 'object' || !('events' in body)) {
      return { ok: false, status: 400, error: 'Batch body must have an events array' };
    }

    const events = (body as { events: unknown[] }).events;
    if (!Array.isArray(events)) {
      return { ok: false, status: 400, error: 'events must be an array' };
    }

    if (events.length > MAX_BATCH_SIZE) {
      return { ok: false, status: 400, error: `Batch size ${events.length} exceeds limit of ${MAX_BATCH_SIZE}` };
    }

    const results: Array<IngestResult | IngestError> = [];
    let accepted = 0;
    let rejected = 0;
    let filtered = 0;
    let lastHash: string | undefined;

    for (const event of events) {
      // sync-outbox.sh posts raw hook-format lines. Transform them here so
      // the batch path accepts the same shape as POST /api/events/hook,
      // while still accepting full-format Verdandi events.
      let toProcess: unknown = event;
      if (isHookFormat(event)) {
        const transformed = transformHookPayload(event);
        if (!transformed) {
          // Not significant enough to audit (e.g. Read/Glob/Grep) — skip, don't reject.
          filtered++;
          results.push({ ok: false, status: 204, error: 'Hook event filtered — not significant' });
          continue;
        }
        toProcess = transformed;
      }

      const result = await this.processEvent(auth, toProcess);
      results.push(result);
      if (result.ok) {
        accepted++;
        lastHash = result.entry_hash;
      } else {
        rejected++;
      }
    }

    return { accepted, rejected, filtered, results, last_entry_hash: lastHash };
  }

  /**
   * Process a Claude Code hook payload into a Verdandi event.
   */
  async ingestHook(
    authHeader: string | undefined,
    hookPayload: unknown,
  ): Promise<IngestResult | IngestError> {
    // Stage 1: Authentication + write authorization
    const auth = this.authenticate(authHeader);
    if (!auth.ok) return auth;
    const scopeError = requireWriteScope(auth);
    if (scopeError) return scopeError;

    // Transform hook payload to Verdandi event
    const event = transformHookPayload(hookPayload);
    if (!event) {
      // Hook event not significant enough to audit (e.g., Read, Glob, Grep)
      return { ok: false, status: 204, error: 'Hook event filtered — not significant' };
    }

    return this.processEvent(auth, event);
  }

  private async processEvent(
    auth: AuthResult,
    body: unknown,
  ): Promise<IngestResult | IngestError> {
    // Stage 2: Payload validation
    const validationError = validatePayload(body);
    if (validationError) {
      return { ok: false, status: 400, error: validationError };
    }

    const event = body as Record<string, unknown>;

    // Stage 3: Secret redaction
    const redacted = redact(event) as Record<string, unknown>;

    // Stage 4: Server-side field override
    // Component is ALWAYS derived from API key, never from client
    redacted.component = auth.component;

    // event_id: accept client-supplied if present, otherwise generate
    if (!redacted.event_id || typeof redacted.event_id !== 'string') {
      redacted.event_id = randomUUID();
    }

    // Client timestamp is preserved but server_timestamp is authoritative for ordering
    if (!redacted.timestamp || typeof redacted.timestamp !== 'string') {
      redacted.timestamp = new Date().toISOString();
    }

    // Stage 5: Server-side retention classification (never trust client)
    const severity = redacted.severity as Severity;
    const eventType = redacted.event_type as string;
    const retentionClass = classifyRetention(eventType, severity);
    redacted.retention_class = retentionClass;
    const erasureEligible = isErasureEligible(retentionClass);

    // Evidence grade assignment
    redacted.evidence_grade = assignEvidenceGrade(eventType, auth.component);

    // Set GDPR flags
    if (!redacted.data_classification || typeof redacted.data_classification !== 'object') {
      redacted.data_classification = {};
    }
    (redacted.data_classification as Record<string, unknown>).erasure_eligible = erasureEligible;

    // Stages 6-9: Canonicalize + atomic append (handled by AppendWorker)
    try {
      const result = await this.appendWorker.append(redacted);
      return {
        ok: true,
        event_id: result.event_id,
        entry_hash: result.entry_hash,
        chain_position: result.chain_position,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Check for duplicate (idempotency)
      if (message.includes('UNIQUE constraint failed')) {
        return {
          ok: false,
          status: 409,
          error: 'Duplicate event_id',
          duplicate: true,
        };
      }
      return { ok: false, status: 500, error: `Append failed: ${message}` };
    }
  }
}

/**
 * Require the `write` scope (or `admin`) on an authenticated request.
 * Writing to the append-only audit log must be denied to read-only keys —
 * otherwise a read consumer could forge events. Returns an IngestError (403)
 * when the scope is missing, or null when authorized.
 */
function requireWriteScope(auth: AuthResult): IngestError | null {
  const allowed: Scope[] = ['write', 'admin'];
  if (!auth.scopes.some(s => allowed.includes(s))) {
    return { ok: false, status: 403, error: 'Missing required scope: write' };
  }
  return null;
}

/**
 * Validate an event payload (Stage 2).
 * Returns an error message or null if valid.
 */
function validatePayload(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'Body must be a JSON object';
  }

  const event = body as Record<string, unknown>;

  // Required fields
  if (!event.event_type || typeof event.event_type !== 'string') {
    return 'Missing or invalid event_type';
  }
  if (!EVENT_TYPE_PATTERN.test(event.event_type)) {
    return `Invalid event_type format: ${event.event_type}`;
  }

  if (!event.severity || !VALID_SEVERITIES.has(event.severity as string)) {
    return 'Missing or invalid severity (must be critical/significant/routine/debug)';
  }

  // Action validation
  if (!event.action || typeof event.action !== 'object') {
    return 'Missing action object';
  }
  const action = event.action as Record<string, unknown>;
  if (!action.verb || typeof action.verb !== 'string') {
    return 'action.verb is required';
  }
  if (!action.resource_type || typeof action.resource_type !== 'string') {
    return 'action.resource_type is required';
  }

  // Length limits
  if (typeof action.detail === 'string' && action.detail.length > MAX_DETAIL_LENGTH) {
    return `action.detail exceeds ${MAX_DETAIL_LENGTH} character limit`;
  }

  const reasoning = event.reasoning as Record<string, unknown> | undefined;
  if (reasoning?.summary && typeof reasoning.summary === 'string' && reasoning.summary.length > MAX_REASONING_LENGTH) {
    return `reasoning.summary exceeds ${MAX_REASONING_LENGTH} character limit`;
  }
  if (reasoning?.alternatives_considered && Array.isArray(reasoning.alternatives_considered) && reasoning.alternatives_considered.length > MAX_ALTERNATIVES) {
    return `reasoning.alternatives_considered exceeds ${MAX_ALTERNATIVES} items`;
  }

  // Actors limit
  if (event.actors && Array.isArray(event.actors) && event.actors.length > MAX_ACTORS) {
    return `actors array exceeds ${MAX_ACTORS} items`;
  }

  return null;
}

/**
 * Transform a Claude Code hook payload into a Verdandi event.
 * Returns null if the hook event should be filtered (not significant).
 */
function transformHookPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const hook = payload as Record<string, unknown>;
  const toolName = hook.tool_name as string | undefined;
  const hookEvent = hook.hook_event_name as string | undefined;

  if (!toolName && !hookEvent) return null;

  // Filter: only audit significant tool calls
  let eventType: string;
  let severity: Severity;

  if (hookEvent === 'PermissionRequest') {
    // This is a human-in-the-loop decision point
    eventType = 'decision.approve';
    severity = 'significant';
  } else if (toolName) {
    let mapping = HOOK_TOOL_MAPPING[toolName] ?? matchToolPattern(toolName);
    // Shell tools carry the real action in their command string. Since the
    // May 2026 MCP→CLI move, money/email actions arrive as Bash calls
    // (noxctl / m365 / himalaya / gws) rather than mcp__* tool names — inspect
    // the command so they aren't buried as debug-grade shell events.
    if (toolName === 'Bash') {
      const shellMapping = matchShellCommand(extractShellCommand(hook.tool_input));
      if (shellMapping) mapping = shellMapping;
    }
    if (!mapping) return null; // Not significant — skip
    eventType = mapping.eventType;
    severity = mapping.severity;
  } else {
    return null;
  }

  return {
    event_type: eventType,
    severity,
    action: {
      verb: hookEvent === 'PermissionRequest' ? 'propose' : 'execute',
      resource_type: 'tool_call',
      resource_id: toolName ?? hookEvent,
      detail: truncate(JSON.stringify(hook.tool_input ?? {}), MAX_DETAIL_LENGTH),
    },
    actors: [
      { actor_id: 'magnus', actor_type: 'human', role: 'initiator' },
      { actor_id: 'claude-code', actor_type: 'agent', role: 'executor' },
    ],
    trace: {
      session_id: hook.session_id ?? null,
      originating_environment: 'laptop-claude-code',
    },
    // Preserve hook metadata for correlation
    _hook: {
      tool_use_id: hook.tool_use_id,
      hook_event_name: hookEvent,
      permission_mode: hook.permission_mode,
      agent_id: hook.agent_id,
    },
  };
}

interface ToolMapping {
  eventType: string;
  severity: Severity;
}

/** Direct tool name → event type mappings */
const HOOK_TOOL_MAPPING: Record<string, ToolMapping> = {
  Edit: { eventType: 'agent.file.edit', severity: 'debug' },
  Write: { eventType: 'agent.file.edit', severity: 'debug' },
  Bash: { eventType: 'agent.shell.execute', severity: 'debug' },
  NotebookEdit: { eventType: 'agent.file.edit', severity: 'debug' },
};

/** Pattern-based tool name matching for MCP tools */
function matchToolPattern(toolName: string): ToolMapping | null {
  if (toolName.startsWith('mcp__fortnox__') || toolName.startsWith('mcp__noxctl__')) {
    return { eventType: 'accounting.booking.create', severity: 'significant' };
  }
  if (toolName === 'mcp__munin-memory__memory_write' || toolName === 'mcp__munin-memory__memory_log') {
    return { eventType: 'memory.state.write', severity: 'routine' };
  }
  if (toolName.startsWith('mcp__microsoft-mcp__send_email') || toolName.startsWith('mcp__microsoft-mcp__create_email')) {
    return { eventType: 'email.send', severity: 'significant' };
  }
  if (toolName.startsWith('mcp__microsoft-mcp__create_event')) {
    return { eventType: 'calendar.event.create', severity: 'significant' };
  }
  // Default: not significant enough to audit
  return null;
}

/** Extract the command string from a Bash tool's tool_input, if present. */
function extractShellCommand(toolInput: unknown): string {
  if (toolInput && typeof toolInput === 'object') {
    const cmd = (toolInput as Record<string, unknown>).command;
    if (typeof cmd === 'string') return cmd;
  }
  return '';
}

/**
 * Detect high-value CLI actions inside a shell command string.
 * Post-May 2026 the fleet moved from MCP tools to CLIs, so money/email
 * actions now arrive as Bash tool calls and must be reclassified out of
 * the debug-grade shell bucket. Returns null for ordinary shell commands.
 */
function matchShellCommand(command: string): ToolMapping | null {
  if (!command) return null;

  // A command token starts at line start, after whitespace/control chars, or
  // after a path/quote boundary — so `./noxctl`, `/usr/local/bin/noxctl` and
  // `bash -lc 'noxctl …'` all count, while `mynoxctl` / a substring do not.
  const CMD = "(?:^|[\\s;&|(`$/'\"])";

  // Money movements: Fortnox accounting CLI (replaces mcp__fortnox__).
  // Trailing (?:\s|$) keeps `/var/log/noxctl.log` and `noxctl-data` from matching.
  if (new RegExp(`${CMD}noxctl(?:\\s|$)`).test(command)) {
    return { eventType: 'accounting.booking.create', severity: 'significant' };
  }

  // Outbound email via the fleet CLIs (replaces mcp__microsoft-mcp__send_email):
  //   m365:     `m365 outlook mail send ...` or a Graph `.../sendMail` request
  //   himalaya: `himalaya message send|reply|forward|write ...` (write also sends)
  //   gws:      `gws gmail ... send ...`
  // The Graph send is matched on the `/sendMail` URL path (not the bare token)
  // so a grep/echo mentioning "sendMail" isn't misread as an outbound send.
  if (
    new RegExp(`${CMD}m365\\b[\\s\\S]*\\bmail\\s+send\\b`).test(command) ||
    /\/sendMail\b/i.test(command) ||
    new RegExp(`${CMD}himalaya\\b[\\s\\S]*\\bmessage\\s+(?:send|reply|forward|write)\\b`).test(command) ||
    new RegExp(`${CMD}gws\\s+gmail\\b[\\s\\S]*\\bsend\\b`).test(command)
  ) {
    return { eventType: 'email.send', severity: 'significant' };
  }

  return null;
}

/**
 * A raw Claude Code hook payload carries tool_name / hook_event_name and no
 * event_type; a full Verdandi event carries event_type. This lets the batch
 * endpoint accept the hook-format lines sync-outbox.sh sends alongside
 * full-format events.
 */
function isHookFormat(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  if ('event_type' in e) return false;
  return 'tool_name' in e || 'hook_event_name' in e;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
