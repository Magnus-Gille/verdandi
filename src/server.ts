/**
 * Verdandi HTTP server — Fastify-based audit log API.
 * Port 3036 in the Grimnir ecosystem.
 */

import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { IngestPipeline } from './ingest.js';
import { AppendWorker, verifyChain } from './hash-chain.js';
import { createAuthenticator, type Scope } from './auth.js';

const MAX_QUERY_LIMIT = 1000;
const MAX_QUERY_OFFSET = 1_000_000;

function boundedInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined) return { value: defaultValue };
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { error: `${name} must be an integer between ${min} and ${max}` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { error: `${name} must be an integer between ${min} and ${max}` };
  }
  return { value: parsed };
}

function timestampMillis(
  value: unknown,
  name: string,
): { value?: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.length > 64) {
    return { error: `${name} must be a valid timestamp` };
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? { value: parsed }
    : { error: `${name} must be a valid timestamp` };
}

export function createServer(db: Database.Database, opts: { logger?: boolean } = {}) {
  const appendWorker = new AppendWorker(db);
  const pipeline = new IngestPipeline(db, appendWorker);
  const authenticate = createAuthenticator(db);

  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: 256 * 1024, // 256 KB
  });

  /**
   * Enforce a scope on read endpoints. Returns an error descriptor when the
   * caller is unauthenticated (401) or authenticated but lacking the scope
   * (403); returns null when access is granted. The 'admin' scope grants all.
   */
  function requireScope(
    authHeader: string | undefined,
    scope: Scope,
  ): { status: number; error: string } | null {
    const auth = authenticate(authHeader);
    if (!auth.ok) return { status: auth.status, error: auth.error };
    if (!auth.scopes.includes(scope) && !auth.scopes.includes('admin')) {
      return { status: 403, error: `Missing required scope: ${scope}` };
    }
    return null;
  }

  // ============================================================
  // Health
  // ============================================================

  app.get('/health', async () => {
    const count = (db.prepare('SELECT COUNT(*) as c FROM audit_events').get() as { c: number }).c;
    const lastEvent = db.prepare(
      'SELECT event_id, server_timestamp, entry_hash FROM audit_events ORDER BY id DESC LIMIT 1'
    ).get() as { event_id: string; server_timestamp: string; entry_hash: string } | undefined;

    return {
      status: 'ok',
      service: 'verdandi',
      version: '0.1.0',
      events_count: count,
      last_event: lastEvent ?? null,
    };
  });

  // ============================================================
  // Write API
  // ============================================================

  app.post('/api/events', async (request, reply) => {
    const result = await pipeline.ingest(
      request.headers.authorization,
      request.body,
    );

    if (!result.ok) {
      reply.status(result.status);
      return { error: result.error };
    }

    reply.status(201);
    return result;
  });

  app.post('/api/events/batch', async (request, reply) => {
    const result = await pipeline.ingestBatch(
      request.headers.authorization,
      request.body,
    );

    if ('ok' in result && !result.ok) {
      reply.status((result as { status: number }).status);
      return { error: (result as { error: string }).error };
    }

    reply.status(201);
    return result;
  });

  // Hook intake endpoint — receives raw Claude Code hook JSON
  app.post('/api/events/hook', async (request, reply) => {
    const result = await pipeline.ingestHook(
      request.headers.authorization,
      request.body,
    );

    if (!result.ok) {
      if (result.status === 204) {
        reply.status(204);
        return;
      }
      reply.status(result.status);
      return { error: result.error };
    }

    reply.status(201);
    return result;
  });

  // ============================================================
  // Read API
  // ============================================================

  app.get<{
    Querystring: {
      trace_id?: string;
      event_type?: string;
      component?: string;
      severity?: string;
      session_id?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/events', async (request, reply) => {
    const authErr = requireScope(request.headers.authorization, 'read');
    if (authErr) {
      reply.status(authErr.status);
      return { error: authErr.error };
    }

    const q = request.query;

    const since = timestampMillis(q.since, 'since');
    const until = timestampMillis(q.until, 'until');
    const parsedLimit = boundedInteger(q.limit, 'limit', 100, 1, MAX_QUERY_LIMIT);
    const parsedOffset = boundedInteger(q.offset, 'offset', 0, 0, MAX_QUERY_OFFSET);
    const queryError = since.error ?? until.error ?? parsedLimit.error ?? parsedOffset.error;
    if (queryError) {
      reply.status(400);
      return { error: queryError };
    }
    if (since.value !== undefined && until.value !== undefined && since.value > until.value) {
      reply.status(400);
      return { error: 'since must not be later than until' };
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.trace_id) {
      conditions.push('trace_id = ?');
      params.push(q.trace_id);
    }
    if (q.event_type) {
      if (q.event_type.endsWith('.*')) {
        conditions.push("event_type LIKE ?");
        params.push(q.event_type.replace('.*', '.%'));
      } else {
        conditions.push('event_type = ?');
        params.push(q.event_type);
      }
    }
    if (q.component) {
      conditions.push('component = ?');
      params.push(q.component);
    }
    if (q.severity) {
      conditions.push('severity = ?');
      params.push(q.severity);
    }
    if (q.session_id) {
      conditions.push('session_id = ?');
      params.push(q.session_id);
    }
    if (since.value !== undefined) {
      conditions.push('timestamp_ms >= ?');
      params.push(since.value);
    }
    if (until.value !== undefined) {
      conditions.push('timestamp_ms <= ?');
      params.push(until.value);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = parsedLimit.value;
    const offset = parsedOffset.value;

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM audit_events ${where}`
    ).get(...params) as { total: number };

    const rows = db.prepare(
      `SELECT event_id, timestamp_utc, server_timestamp, event_type, component,
              severity, retention_class, evidence_grade, payload,
              trace_id, session_id, entry_hash
       FROM audit_events ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    // Parse payload JSON for each row
    const events = (rows as Array<Record<string, unknown>>).map(row => ({
      ...row,
      payload: JSON.parse(row.payload as string),
    }));

    return {
      events,
      total: countRow.total,
      limit,
      offset,
    };
  });

  app.get<{ Params: { eventId: string } }>('/api/events/:eventId', async (request, reply) => {
    const authErr = requireScope(request.headers.authorization, 'read');
    if (authErr) {
      reply.status(authErr.status);
      return { error: authErr.error };
    }

    const row = db.prepare(
      `SELECT event_id, timestamp_utc, server_timestamp, event_type, component,
              severity, retention_class, evidence_grade, payload,
              trace_id, session_id, prev_hash, entry_hash
       FROM audit_events WHERE event_id = ?`
    ).get(request.params.eventId) as Record<string, unknown> | undefined;

    if (!row) {
      reply.status(404);
      return { error: 'Event not found' };
    }

    return {
      ...row,
      payload: JSON.parse(row.payload as string),
    };
  });

  // ============================================================
  // Verify API
  // ============================================================

  app.get<{ Querystring: { since?: string } }>('/api/verify', async (request, reply) => {
    const authErr = requireScope(request.headers.authorization, 'read');
    if (authErr) {
      reply.status(authErr.status);
      return { error: authErr.error };
    }

    const parsedSince = boundedInteger(
      request.query.since,
      'since',
      1,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (request.query.since !== undefined && parsedSince.error) {
      reply.status(400);
      return { error: parsedSince.error };
    }
    const sinceId = request.query.since === undefined ? undefined : parsedSince.value;

    const result = verifyChain(db, sinceId === undefined ? undefined : { since: sinceId });

    const lastCheckpoint = db.prepare(
      'SELECT checkpoint_at, verified FROM checkpoints ORDER BY id DESC LIMIT 1'
    ).get() as { checkpoint_at: string; verified: number } | undefined;

    return {
      ...result,
      last_checkpoint: lastCheckpoint?.checkpoint_at ?? null,
      last_checkpoint_verified: lastCheckpoint ? lastCheckpoint.verified === 1 : false,
    };
  });

  return app;
}
