import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import type { ConfigSources } from '@config/src/store/types.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, sopsEncrypt } from '../helpers.js';

/**
 * The loader against genuinely encrypted namespaces.
 *
 * This is where "decrypt, then parse" is actually load-bearing: the committed document has
 * `SMTP_PASSWORD: ENC[...]` and a `sops:` block, and neither is what the service should see.
 */

const withSops = hasSops() ? describe : describe.skip;
const SHA = 'a'.repeat(40);

withSops('ConfigLoader with encrypted namespaces', () => {
  let key: AgeKeypair;
  let sources: ConfigSources;

  beforeAll(() => {
    key = generateAgeKey();
    const encrypted = sopsEncrypt('MFA_ENFORCEMENT: all\nSMTP_PASSWORD: hunter2\n', {
      recipient: key.recipient,
      encryptedRegex: '^(SMTP_PASSWORD)$',
    });
    sources = { commit: SHA, sources: new Map([['iam/prod', encrypted]]) };
  });

  it('serves the decrypted value, not the ciphertext', async () => {
    const tree = await new ConfigLoader(new SopsDecryptor(key.secret)).resolve(sources);

    expect(tree.namespaces.get('iam/prod')).toEqual({
      MFA_ENFORCEMENT: 'all',
      SMTP_PASSWORD: 'hunter2',
    });
  });

  it('does not leave the sops metadata block among the config keys', async () => {
    // Parsing before decrypting would put `sops` in the tree, and the schema validator would
    // then reject every encrypted namespace as holding an unknown key.
    const tree = await new ConfigLoader(new SopsDecryptor(key.secret)).resolve(sources);

    expect(Object.keys(tree.namespaces.get('iam/prod') ?? {})).not.toContain('sops');
  });

  it('fails the whole load rather than serving a namespace it could not decrypt', async () => {
    // Half-decrypted config is worse than stale config: the service would boot, look healthy,
    // and use a compiled-in default for a secret it believes it has been given.
    const loader = new ConfigLoader(new SopsDecryptor(generateAgeKey().secret));

    await expect(loader.resolve(sources)).rejects.toThrow(/config\/iam\/prod\.yaml/);
  });
});
