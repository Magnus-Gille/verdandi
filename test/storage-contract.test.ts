import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const canonicalDataDir = '/home/magnus/.local/share/verdandi';
const validationCommand =
  'ExecStartPre=/usr/bin/node /home/magnus/repos/verdandi/dist/index.js validate-generation';

describe('production storage contract', () => {
  it('keeps runtime data outside the rsync deployment checkout', () => {
    const unit = readFileSync(join(root, 'verdandi.service'), 'utf8');

    expect(unit).toContain(`Environment=VERDANDI_DATA_DIR=${canonicalDataDir}`);
    expect(unit).toContain(`ReadWritePaths=${canonicalDataDir}`);
    expect(unit).toContain(`AssertPathIsDirectory=${canonicalDataDir}`);
    expect(unit).toContain(validationCommand);
    expect(unit).not.toContain('VERDANDI_DATA_DIR=/home/magnus/repos/verdandi/data');
    expect(canonicalDataDir.startsWith('/home/magnus/repos/verdandi/')).toBe(false);
  });

  it('uses the same data directory for daily checkpoints', () => {
    const checkpoint = readFileSync(join(root, 'systemd/verdandi-checkpoint.service'), 'utf8');

    expect(checkpoint).toContain(`Environment=VERDANDI_DATA_DIR=${canonicalDataDir}`);
    expect(checkpoint).toContain(`ReadWritePaths=${canonicalDataDir}`);
    expect(checkpoint).toContain(`AssertPathIsDirectory=${canonicalDataDir}`);
    expect(checkpoint).toContain(
      'ExecStartPre=/usr/bin/env node /home/magnus/repos/verdandi/dist/index.js validate-generation'
    );
  });
});
