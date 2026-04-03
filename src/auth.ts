/**
 * Per-component API key authentication.
 * Resolves debate critique C04/C18: server-derived component identity.
 *
 * Key format: vrd_<component>_<32 hex chars>
 * Keys are stored as SHA-256 hashes in the database.
 */

import { createHash, randomBytes } from 'crypto';
import type Database from 'better-sqlite3';

export type Scope = 'write' | 'read' | 'admin';

export interface AuthResult {
  ok: true;
  component: string;
  keyId: number;
  scopes: Scope[];
}

export interface AuthError {
  ok: false;
  status: number;
  error: string;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(component: string): string {
  const hex = randomBytes(16).toString('hex');
  return `vrd_${component}_${hex}`;
}

export function createAuthenticator(db: Database.Database) {
  const lookupStmt = db.prepare(`
    SELECT id, component, scopes, revoked_at
    FROM api_keys WHERE key_hash = ?
  `);

  const updateLastUsedStmt = db.prepare(`
    UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%f','now')
    WHERE id = ?
  `);

  return function authenticate(
    authHeader: string | undefined
  ): AuthResult | AuthError {
    if (!authHeader?.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Missing or malformed Authorization header' };
    }

    const key = authHeader.slice(7);
    const hash = hashKey(key);

    const row = lookupStmt.get(hash) as
      | { id: number; component: string; scopes: string; revoked_at: string | null }
      | undefined;

    if (!row) {
      return { ok: false, status: 401, error: 'Invalid API key' };
    }

    if (row.revoked_at) {
      return { ok: false, status: 401, error: 'API key has been revoked' };
    }

    // Update last_used_at (fire and forget — don't block auth)
    updateLastUsedStmt.run(row.id);

    return {
      ok: true,
      component: row.component,
      keyId: row.id,
      scopes: row.scopes.split(',') as Scope[],
    };
  };
}

/**
 * Register a new API key for a component.
 * Returns the raw key (only shown once).
 */
export function registerApiKey(
  db: Database.Database,
  component: string,
  scopes: Scope[] = ['write'],
  description?: string
): { key: string; keyId: number } {
  const key = generateApiKey(component);
  const hash = hashKey(key);

  const info = db.prepare(`
    INSERT INTO api_keys (key_hash, component, scopes, description)
    VALUES (?, ?, ?, ?)
  `).run(hash, component, scopes.join(','), description ?? `API key for ${component}`);

  return { key, keyId: info.lastInsertRowid as number };
}
