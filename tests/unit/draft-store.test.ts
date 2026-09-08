import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Draft, DraftStore } from '@config/src/store/draft-store.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Edits that have been made but not published.
 *
 * The registry used to commit on save, which made "saved" mean durable. Scoped publishing needs
 * a state between the two — and that state is genuinely weaker, so the rules here are about
 * limiting the damage: drafts survive a restart, and a draft never holds a secret in plaintext.
 */

const draft = (namespace: string, overrides: Partial<Draft> = {}): Draft => ({
  namespace,
  document: 'MFA_ENFORCEMENT: all\n',
  changes: [{ key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all', secret: false }],
  saves: [{ keys: ['MFA_ENFORCEMENT'], actor: 'me@anudeep.pro', at: 1 }],
  actor: 'me@anudeep.pro',
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'config-drafts-'));
  path = join(dir, 'drafts.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('holding a draft', () => {
  it('reads back what was staged', async () => {
    const store = new DraftStore(path);
    await store.put(draft('iam/prod'));

    expect((await store.get('iam/prod'))?.document).toBe('MFA_ENFORCEMENT: all\n');
  });

  it('survives a restart', async () => {
    // The whole reason this is a file. An unpublished change lost to a container restart is
    // exactly the regression that staging introduces, so it must at least outlive the process.
    await new DraftStore(path).put(draft('iam/prod'));

    expect(await new DraftStore(path).get('iam/prod')).not.toBeNull();
  });

  it('replaces an earlier draft for the same namespace', async () => {
    const store = new DraftStore(path);
    await store.put(draft('iam/prod'));
    await store.put(draft('iam/prod', { document: 'MFA_ENFORCEMENT: admins\n' }));

    expect((await store.all()).filter((d) => d.namespace === 'iam/prod')).toHaveLength(1);
    expect((await store.get('iam/prod'))?.document).toBe('MFA_ENFORCEMENT: admins\n');
  });

  it('keeps drafts for different namespaces apart', async () => {
    const store = new DraftStore(path);
    await store.put(draft('iam/prod'));
    await store.put(draft('iam/dev'));
    await store.put(draft('api/prod'));

    expect((await store.all()).map((d) => d.namespace).sort()).toEqual([
      'api/prod',
      'iam/dev',
      'iam/prod',
    ]);
  });

  it('has nothing before anything is staged', async () => {
    expect(await new DraftStore(path).all()).toEqual([]);
  });
});

describe('secrets in a draft', () => {
  it('never writes a secret value to the file', async () => {
    // A draft sits on disk for as long as nobody publishes it. Storing the plaintext would put
    // the secret somewhere with none of the protections the repository has — not encrypted, not
    // in git, and not covered by the CI check that looks for exactly this.
    const store = new DraftStore(path);
    await store.put(
      draft('iam/prod', {
        document: 'SMTP_PASSWORD: ENC[AES256_GCM,data:x9Kd,type:str]\n',
        changes: [{ key: 'SMTP_PASSWORD', from: undefined, to: undefined, secret: true }],
      }),
    );

    const written = await readFile(path, 'utf8');
    expect(written).not.toContain('hunter2');
    expect(written).toContain('ENC[AES256_GCM');
  });

  it('refuses a change that claims to be secret while carrying a value', async () => {
    // The one way plaintext could reach this file is a caller forgetting to strip it. Refusing
    // is better than trusting every future call site to remember.
    const store = new DraftStore(path);

    await expect(
      store.put(
        draft('iam/prod', {
          changes: [{ key: 'SMTP_PASSWORD', from: 'old', to: 'hunter2', secret: true }],
        }),
      ),
    ).rejects.toThrow(/secret/i);
  });

  it('is readable only by the service that owns it', async () => {
    const store = new DraftStore(path);
    await store.put(draft('iam/prod'));

    const { mode } = await import('node:fs/promises').then((fs) => fs.stat(path));
    expect(mode & 0o777).toBe(0o600);
  });
});

describe('publishing drafts', () => {
  it('removes the ones that were published', async () => {
    const store = new DraftStore(path);
    await store.put(draft('iam/prod'));
    await store.put(draft('iam/dev'));

    await store.remove(['iam/prod']);

    expect((await store.all()).map((d) => d.namespace)).toEqual(['iam/dev']);
  });

  it('removes several at once, for a whole product', async () => {
    const store = new DraftStore(path);
    await store.put(draft('iam/prod'));
    await store.put(draft('iam/dev'));
    await store.put(draft('api/prod'));

    await store.remove(['iam/prod', 'iam/dev']);

    expect((await store.all()).map((d) => d.namespace)).toEqual(['api/prod']);
  });

  it('ignores a namespace with no draft rather than failing the publish', async () => {
    // A publish that raced another one must not error on the drafts the winner already took.
    const store = new DraftStore(path);
    await store.put(draft('iam/prod'));

    await expect(store.remove(['iam/prod', 'nothing/here'])).resolves.toBeUndefined();
  });
});

describe('surviving a broken file', () => {
  it('reports no drafts rather than refusing to start', async () => {
    await writeFile(path, '{"drafts": ', 'utf8');

    expect(await new DraftStore(path).all()).toEqual([]);
  });

  it('discards entries of the wrong shape but keeps the good ones', async () => {
    await writeFile(
      path,
      JSON.stringify({ drafts: [{ namespace: 'iam/prod' }, draft('api/prod')] }),
      'utf8',
    );

    expect((await new DraftStore(path).all()).map((d) => d.namespace)).toEqual(['api/prod']);
  });

  it('leaves no partial file behind when it writes', async () => {
    const store = new DraftStore(path);

    await store.put(draft('iam/prod'));

    expect(await readdir(dir)).toEqual(['drafts.json']);
  });
});

/**
 * A draft is one press of Save, and a namespace can hold several of them before anything is
 * published. The saves are what the console counts and what a publish folds into its commit
 * message, so they have to survive a restart like everything else here.
 */
describe('the saves inside a draft', () => {
  const save = (keys: string[]) => ({ keys, actor: 'me@anudeep.pro', at: 1_700_000_000_000 });

  it('round-trips every save, in the order they were made', async () => {
    const store = new DraftStore(path);
    await store.put({
      namespace: 'iam/dev',
      document: 'A: 1\n',
      changes: [{ key: 'A', from: 0, to: 1, secret: false }],
      saves: [save(['A']), save(['B'])],
      actor: 'me@anudeep.pro',
      updatedAt: 1,
    });

    const back = await new DraftStore(path).get('iam/dev');

    expect(back?.saves.map((entry) => entry.keys)).toEqual([['A'], ['B']]);
    expect(back?.saves[1]?.actor).toBe('me@anudeep.pro');
  });

  it('gives the migrated save the document it stood at, so a drop can replay it', async () => {
    // Without a document, dropping a later save replayed this one from the FINAL draft — which
    // holds exactly the values being dropped, so the drop restored them.
    await writeFile(
      path,
      JSON.stringify({
        drafts: [
          {
            namespace: 'iam/dev',
            document: 'A: 1\n',
            changes: [{ key: 'A', from: 0, to: 1, secret: false }],
            actor: 'me@anudeep.pro',
            updatedAt: 1,
          },
        ],
      }),
      'utf8',
    );

    const back = await new DraftStore(path).get('iam/dev');

    expect(back?.saves[0]?.document).toBe('A: 1\n');
  });

  it('reads a draft written before saves existed as a single save', async () => {
    // Every draft on disk today. Treating it as zero would say "Publish 0 drafts" over a draft
    // that plainly holds changes.
    await writeFile(
      path,
      JSON.stringify({
        drafts: [
          {
            namespace: 'iam/dev',
            document: 'A: 1\n',
            changes: [{ key: 'A', from: 0, to: 1, secret: false }],
            actor: 'me@anudeep.pro',
            updatedAt: 1,
          },
        ],
      }),
      'utf8',
    );

    const back = await new DraftStore(path).get('iam/dev');

    expect(back?.saves).toHaveLength(1);
    expect(back?.saves[0]?.keys).toEqual(['A']);
  });

  it('refuses a save whose keys are not names, rather than storing it', async () => {
    const store = new DraftStore(path);

    await expect(
      store.put({
        namespace: 'iam/dev',
        document: 'A: 1\n',
        changes: [],
        saves: [{ keys: [12] as unknown as string[], actor: 'x', at: 1 }],
        actor: 'x',
        updatedAt: 1,
      }),
    ).rejects.toThrow();
  });
});
