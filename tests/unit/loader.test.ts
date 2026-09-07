import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import type { ConfigSources } from '@config/src/store/types.js';
import { describe, expect, it } from 'vitest';

/**
 * Turning committed file text into the tree that gets served.
 *
 * Decryption then parsing, in that order and only in that order: a SOPS document is not the
 * document it will become, so parsing it first would type-check ciphertext.
 *
 * These cases use plaintext documents, which need no age key and therefore no sops binary —
 * `SopsDecryptor` returns an unencrypted document untouched. The encrypted path is covered in
 * tests/integration/loader-sops.test.ts.
 */

const SHA = 'a'.repeat(40);

const sources = (files: Record<string, string>): ConfigSources => ({
  commit: SHA,
  sources: new Map(Object.entries(files)),
});

const loader = () => new ConfigLoader(new SopsDecryptor(''));

describe('ConfigLoader.resolve', () => {
  it('parses each namespace into its values', async () => {
    const tree = await loader().resolve(sources({ 'iam/prod': 'MFA_ENFORCEMENT: all\n' }));

    expect(tree.namespaces.get('iam/prod')).toEqual({ MFA_ENFORCEMENT: 'all' });
  });

  it('preserves YAML types rather than stringifying everything', async () => {
    // The schema validator asserts typed keys. If the loader flattened everything to strings,
    // every bool and int constraint would have to be re-parsed downstream.
    const tree = await loader().resolve(
      sources({
        'iam/prod': 'KILL_PASSWORD_LOGIN: true\nSESSION_TTL: 3600\nFP_COMPONENTS: [ua, lang]\n',
      }),
    );

    expect(tree.namespaces.get('iam/prod')).toEqual({
      KILL_PASSWORD_LOGIN: true,
      SESSION_TTL: 3600,
      FP_COMPONENTS: ['ua', 'lang'],
    });
  });

  it('carries the commit through unchanged', async () => {
    expect((await loader().resolve(sources({}))).commit).toBe(SHA);
  });

  it('treats an empty file as a namespace with no overrides', async () => {
    // Distinct from an absent namespace: the file exists, so the service is known and simply
    // overrides nothing today.
    const tree = await loader().resolve(sources({ 'iam/prod': '' }));

    expect(tree.namespaces.get('iam/prod')).toEqual({});
  });

  it('rejects malformed YAML, naming the file', async () => {
    await expect(loader().resolve(sources({ 'iam/prod': 'A: [unclosed\n' }))).rejects.toThrow(
      /config\/iam\/prod\.yaml/,
    );
  });

  it('rejects a file whose top level is not a mapping', async () => {
    await expect(loader().resolve(sources({ 'iam/prod': '- a\n- b\n' }))).rejects.toThrow(
      /config\/iam\/prod\.yaml/,
    );
  });

  it('freezes the values it produces', async () => {
    const tree = await loader().resolve(sources({ 'iam/prod': 'A: 1\n' }));

    expect(Object.isFrozen(tree.namespaces.get('iam/prod'))).toBe(true);
  });
});
