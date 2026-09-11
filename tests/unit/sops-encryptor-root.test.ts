import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('encrypts with the clone that holds .sops.yaml, not the database directory', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'),
    'utf8',
  );
  expect(source).toContain('new SopsEncryptor(config.repoDir)');
  expect(source).not.toContain('new SopsEncryptor(config.dbPath)');
});
