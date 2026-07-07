/**
 * Verdandi — Audit log for agentic actions.
 * The Grimnir accountability layer.
 *
 * "Verdandi, the Norn of the present, weaves what is becoming."
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { initDatabase, getDataDir } from './db.js';
import { createServer } from './server.js';
import { registerApiKey } from './auth.js';
import { createCheckpoint } from './checkpoint.js';
import { verifyChain } from './hash-chain.js';

const PORT = parseInt(process.env.VERDANDI_PORT ?? '3036', 10);
const HOST = process.env.VERDANDI_HOST ?? '127.0.0.1';

async function main() {
  // Handle CLI commands
  const command = process.argv[2];

  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, 'verdandi.db');
  const db = initDatabase(dbPath);

  if (command === 'register-key') {
    const component = process.argv[3];
    const scopes = process.argv[4]?.split(',') ?? ['write'];

    if (!component) {
      console.error('Usage: verdandi register-key <component> [scopes]');
      console.error('  scopes: comma-separated list of write,read,admin');
      process.exit(1);
    }

    const { key, keyId } = registerApiKey(db, component, scopes as Array<'write' | 'read' | 'admin'>);
    console.log(`Registered API key for component "${component}":`);
    console.log(`  Key ID: ${keyId}`);
    console.log(`  Key:    ${key}`);
    console.log(`  Scopes: ${scopes.join(', ')}`);
    console.log('');
    console.log('Store this key securely — it cannot be retrieved again.');

    db.close();
    return;
  }

  if (command === 'verify') {
    const result = verifyChain(db);
    console.log(JSON.stringify(result, null, 2));
    db.close();
    process.exit(result.valid ? 0 : 1);
  }

  if (command === 'checkpoint') {
    const anchorPath = process.argv[3] ?? process.env.VERDANDI_ANCHOR_PATH;
    const result = createCheckpoint(db, { anchorPath });
    console.log(JSON.stringify(result, null, 2));
    db.close();
    process.exit(result.verified ? 0 : 1);
  }

  // Default: start server
  const app = createServer(db);

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Verdandi listening on ${HOST}:${PORT}`);
    console.log(`Data directory: ${dataDir}`);
  } catch (err) {
    console.error('Failed to start Verdandi:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down Verdandi...');
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
