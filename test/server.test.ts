import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { initDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { registerApiKey } from '../src/auth.js';

// ============================================================
// GET endpoint authorization (Issue #9)
//
// Reads previously enforced no authorization at all — the full audit
// trail was readable unauthenticated tailnet-wide. The 'read' scope is
// defined in auth.ts but was never checked on the read endpoints.
// ============================================================

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = initDatabase(':memory:');
});

afterEach(async () => {
  if (app) await app.close();
  db.close();
});

async function seedEvent(): Promise<void> {
  // Ingest one event via a write key so the read endpoints have data.
  const { key } = registerApiKey(db, 'noxctl', ['write']);
  const svr = createServer(db, { logger: false });
  const res = await svr.inject({
    method: 'POST',
    url: '/api/events',
    headers: { authorization: `Bearer ${key}` },
    payload: {
      event_type: 'accounting.booking.create',
      severity: 'significant',
      action: { verb: 'create', resource_type: 'voucher', resource_id: 'FV-1' },
    },
  });
  expect(res.statusCode).toBe(201);
  await svr.close();
}

describe('GET /api/events authorization', () => {
  it('rejects reads with no Authorization header (401)', async () => {
    app = createServer(db, { logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects reads with a write-only key (403)', async () => {
    const { key } = registerApiKey(db, 'noxctl', ['write']);
    app = createServer(db, { logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows reads with a read-scoped key (200)', async () => {
    await seedEvent();
    const { key } = registerApiKey(db, 'heimdall', ['read']);
    app = createServer(db, { logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
  });

  it('allows reads with an admin key (200)', async () => {
    await seedEvent();
    const { key } = registerApiKey(db, 'root', ['admin']);
    app = createServer(db, { logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/events/:eventId and /api/verify authorization', () => {
  it('enforces read scope on the single-event endpoint', async () => {
    app = createServer(db, { logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/events/whatever' });
    expect(res.statusCode).toBe(401);
  });

  it('enforces read scope on /api/verify', async () => {
    const { key } = registerApiKey(db, 'noxctl', ['write']);
    app = createServer(db, { logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/verify',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows /api/verify with a read key', async () => {
    const { key } = registerApiKey(db, 'heimdall', ['read']);
    app = createServer(db, { logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/verify',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('/health stays open', () => {
  it('serves health without authorization', async () => {
    app = createServer(db, { logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
