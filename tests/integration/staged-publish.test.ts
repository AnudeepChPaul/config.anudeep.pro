import { rm, writeFile } from 'node:fs/promises';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { DraftStore } from '@config/src/store/draft-store.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { versionOf } from '@config/src/store/metadata.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, TestRepo } from '../helpers.js';

/**
 * Staging an edit, then publishing a chosen scope.
 *
 * The change the new console needs: an edit no longer commits on save. It becomes a draft, and
 * Publish commits the environment, the product, or several products as one commit each.
 *
 * The cost is real and these tests pin its limits: a draft is not durable the way a commit is,
 * so nothing may be lost silently and a publish must be all-or-nothing per namespace.
 */

const withSops = hasSops() ? describe : describe.skip;

const IAM_SCHEMA = `version: 1
keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
  SMTP_PASSWORD:
    type: string
    secret: true
`;
const API_SCHEMA = `version: 1
keys:
  RATE_LIMIT:
    type: int
    min: 1
    max: 10000
`;

const ACTOR = { email: 'me@anudeep.pro', id: '7f3a1c9e' };
const REQUEST = { id: '01JQZX', sourceIp: '203.0.113.7' };

withSops('staging and scoped publishing', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let git: GitRepository;
  let drafts: DraftStore;
  let service: ConfigWriteService;

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': IAM_SCHEMA,
      'schema/api.yaml': API_SCHEMA,
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
      'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\n',
      'config/api/prod.yaml': 'RATE_LIMIT: 100\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key.recipient}\n`,
    });
    git = new GitRepository(repo.dir);
    drafts = new DraftStore(`${repo.dir}/.drafts.json`);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    service = new ConfigWriteService({
      repository: git,
      loader,
      encryptor: new SopsEncryptor(repo.dir),
      schemas: () => SchemaSet.fromFiles({ iam: IAM_SCHEMA, api: API_SCHEMA }),
      drafts,
    });
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  const stage = (service_: string, environment: string, changes: Record<string, unknown>) =>
    service.stage({ service: service_, environment, changes }, ACTOR);

  const served = async (namespace: string) => {
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    return (await loader.resolve(await git.readSources())).namespaces.get(namespace);
  };

  /**
   * The revision counter each namespace file carries.
   *
   * It exists so two hosts editing one namespace can be told apart: a document numbered behind
   * the one on origin was written against something that has since moved. Nothing acts on that
   * yet — this keeps the number honest so the check has something to compare when it arrives.
   */
  const versionOfDraft = async (namespace: string) => {
    const draft = await drafts.get(namespace);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    return versionOf(await loader.resolveOne(namespace, draft?.document ?? ''));
  };

  describe('the document version', () => {
    it('starts at 1 on the first draft of a file that never carried one', async () => {
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      expect(await versionOfDraft('iam/dev')).toBe(1);
    });

    it('rises once for every draft save, not once per published state', async () => {
      // Five edits before a publish is five revisions of the document. Numbering from the
      // committed file instead would collapse them into one, and the counter would then say
      // less than the drafts it is counting.
      for (const value of ['all', 'admins', 'optional', 'all', 'admins']) {
        await stage('iam', 'dev', { MFA_ENFORCEMENT: value });
      }

      expect(await versionOfDraft('iam/dev')).toBe(5);
    });

    it('rises once per draft save, not once per publish', async () => {
      // Publishing writes down what a draft already decided; it is not a second revision of the
      // document, and counting it twice would make the number mean nothing in particular.
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      await service.publish(['iam/dev'], ACTOR, REQUEST);

      expect(versionOf((await served('iam/dev')) ?? {})).toBe(1);

      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'admins' });

      expect(await versionOfDraft('iam/dev')).toBe(2);
    });

    it('carries on from the number already in the file', async () => {
      await repo.commit({ 'config/iam/dev.yaml': 'version: 41\nMFA_ENFORCEMENT: optional\n' });

      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      expect(await versionOfDraft('iam/dev')).toBe(42);
    });

    it('is not itself a change: a save with neither an edit nor a tick stages nothing', async () => {
      await repo.commit({ 'config/iam/dev.yaml': 'version: 4\nMFA_ENFORCEMENT: optional\n' });

      const result = await stage('iam', 'dev', { MFA_ENFORCEMENT: 'optional' });

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error.code).toBe('nothing_staged');
    });

    it('never appears in the change list an operator reviews', async () => {
      // It moves on every save, so listing it would put a line in every hover panel and every
      // commit body saying the counter counted.
      const result = await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      expect(result.ok && result.value.changes.map((change) => change.key)).toEqual([
        'MFA_ENFORCEMENT',
      ]);
    });

    it('is committed with the file, so the next host reads the number this one wrote', async () => {
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      await service.publish(['iam/dev'], ACTOR, REQUEST);

      expect(await git.readFile('config/iam/dev.yaml')).toContain('version:');
    });
  });

  describe('a draft is one press of Save', () => {
    // The unit the console counts. Three keys saved together are one draft; saving twice against
    // the same namespace is two, even though they share one file.
    const message = () => repo.git('log', '-1', '--format=%B');

    it('records one save for one action, whatever it contained', async () => {
      const result = await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all', SESSION_TTL: 1800 });

      expect(result.ok && result.value.saves).toHaveLength(1);
      expect(result.ok && [...(result.value.saves[0]?.keys ?? [])].sort()).toEqual([
        'MFA_ENFORCEMENT',
        'SESSION_TTL',
      ]);
      expect(result.ok && result.value.saves[0]?.actor).toBe(ACTOR.email);
    });

    it('records a second save beside the first, oldest first', async () => {
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      const second = await stage('iam', 'dev', { SESSION_TTL: 1800 });

      expect(second.ok && second.value.saves.map((entry) => entry.keys)).toEqual([
        ['MFA_ENFORCEMENT'],
        ['SESSION_TTL'],
      ]);
    });

    it('gives every draft a generated line in the one commit a publish makes', async () => {
      // Nobody types a commit message. Each draft's line names the namespace, the day the edit
      // was made, and the keys it touched.
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { SESSION_TTL: 1800 });

      const published = await service.publish(['iam/dev'], ACTOR, REQUEST);
      expect(published.ok).toBe(true);

      const body = await message();
      const today = new Date().toISOString().slice(0, 10);

      expect(body).toContain('Publish 2 drafts in iam/dev');
      expect(body).toContain(`[iam-dev] ${today} MFA_ENFORCEMENT`);
      expect(body).toContain(`[iam-dev] ${today} SESSION_TTL`);
    });

    it('dates each line by when the save was made, not by when it was published', async () => {
      // The line describes an edit. Stamping it with the publish time would make every line in a
      // commit claim the same moment, which is the one thing the body is there to distinguish.
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      const draft = await drafts.get('iam/dev');
      await drafts.put({
        ...(draft as NonNullable<typeof draft>),
        saves: [{ keys: ['MFA_ENFORCEMENT'], actor: ACTOR.email, at: Date.parse('2020-03-04') }],
      });

      await service.publish(['iam/dev'], ACTOR, REQUEST);

      expect(await message()).toContain('[iam-dev] 2020-03-04 MFA_ENFORCEMENT');
    });

    it('makes exactly one commit for several drafts', async () => {
      const before = (await git.headCommit()).trim();
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { SESSION_TTL: 1800 });

      await service.publish(['iam/dev'], ACTOR, REQUEST);

      expect(await repo.git('rev-list', '--count', `${before}..HEAD`)).toContain('1');
    });

    it('names a secret key in its line, which is a name and not a value', async () => {
      await stage('iam', 'prod', { SMTP_PASSWORD: 'hunter2' });

      await service.publish(['iam/prod'], ACTOR, REQUEST);
      const body = await message();

      expect(body).toContain('SMTP_PASSWORD');
      expect(body).not.toContain('hunter2');
    });

    it('publishes every key in the draft, ticks or no ticks', async () => {
      // Drafts publish whole. The tick decides what enters a draft and what promotes; it no
      // longer narrows a publish, or the button would count drafts and ship keys.
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all', SESSION_TTL: 1800 });

      await service.publish(['iam/dev'], ACTOR, REQUEST);
      const values = await served('iam/dev');

      expect(values?.MFA_ENFORCEMENT).toBe('all');
      expect(values?.SESSION_TTL).toBe(1800);
      expect(await drafts.get('iam/dev')).toBeNull();
    });
  });

  describe('dropping a draft, as git drops a commit', () => {
    // The save's effect is removed and the others replay onto the committed state. Where git
    // would stop on a conflicting replay, a later save's value simply wins: every delta here is
    // "set this key to this value", so there is nothing to resolve.
    it('removes the effect of the save that is dropped', async () => {
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { SESSION_TTL: 1800 });

      const result = await service.dropSave('iam/dev', 0, ACTOR);
      expect(result.ok).toBe(true);

      const draft = await drafts.get('iam/dev');
      const document = await new ConfigLoader(new SopsDecryptor(key.secret)).resolveOne(
        'iam/dev',
        draft?.document ?? '',
      );

      expect(document.SESSION_TTL).toBe(1800);
      expect(document.MFA_ENFORCEMENT).toBe('optional');
      expect(draft?.saves).toHaveLength(1);
    });

    it('replays a later save that set the same key, so its value wins', async () => {
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'admins' });

      await service.dropSave('iam/dev', 0, ACTOR);
      const draft = await drafts.get('iam/dev');
      const document = await new ConfigLoader(new SopsDecryptor(key.secret)).resolveOne(
        'iam/dev',
        draft?.document ?? '',
      );

      expect(document.MFA_ENFORCEMENT).toBe('admins');
    });

    it('restores exactly what an earlier save had set, not just the committed value', async () => {
      // The reason each save keeps its own snapshot: without one, dropping the second save here
      // would revert the key all the way to `optional` rather than to `all`.
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'admins' });

      await service.dropSave('iam/dev', 1, ACTOR);
      const draft = await drafts.get('iam/dev');
      const document = await new ConfigLoader(new SopsDecryptor(key.secret)).resolveOne(
        'iam/dev',
        draft?.document ?? '',
      );

      expect(document.MFA_ENFORCEMENT).toBe('all');
    });

    it('removes the draft entirely when its only save is dropped', async () => {
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      const result = await service.dropSave('iam/dev', 0, ACTOR);

      expect(result.ok && result.value).toBeNull();
      expect(await drafts.get('iam/dev')).toBeNull();
    });

    it('commits nothing: a drop is not a change to the repository', async () => {
      const before = await git.headCommit();
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      await service.dropSave('iam/dev', 0, ACTOR);

      expect(await git.headCommit()).toBe(before);
    });

    it('carries a secret through a replay as ciphertext', async () => {
      await stage('iam', 'prod', { SMTP_PASSWORD: 'hunter2' });
      await stage('iam', 'prod', { SESSION_TTL: 1800 });

      await service.dropSave('iam/prod', 1, ACTOR);
      const draft = await drafts.get('iam/prod');

      expect(draft?.document).not.toContain('hunter2');
      expect(draft?.document).toContain('ENC[AES256_GCM');
    });

    it('refuses a save index that is not a number', async () => {
      // NaN passed `index < 0 || index >= length` and `filter((_, at) => at !== NaN)` kept every
      // save, so the draft was rebuilt identically, its version bumped, and the console said
      // "Draft dropped."
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      expect((await service.dropSave('iam/dev', Number.NaN, ACTOR)).ok).toBe(false);
      expect((await drafts.get('iam/dev'))?.saves).toHaveLength(1);
    });

    it('does not restore what it dropped when the draft predates snapshots', async () => {
      // A draft written by the old build, read back through the migration: its save carries the
      // document it stood at, so dropping a LATER save replays it from there rather than from
      // the final draft — which holds exactly the values being dropped.
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      const legacy = await drafts.get('iam/dev');
      await writeFile(
        `${repo.dir}/.drafts.json`,
        JSON.stringify({
          drafts: [
            {
              namespace: 'iam/dev',
              document: legacy?.document,
              changes: legacy?.changes,
              actor: ACTOR.email,
              updatedAt: 1,
            },
          ],
        }),
        'utf8',
      );

      await stage('iam', 'dev', { SESSION_TTL: 1800 });
      await service.dropSave('iam/dev', 1, ACTOR);

      const draft = await drafts.get('iam/dev');
      const document = await new ConfigLoader(new SopsDecryptor(key.secret)).resolveOne(
        'iam/dev',
        draft?.document ?? '',
      );

      expect(document.SESSION_TTL).toBeUndefined();
      expect(document.MFA_ENFORCEMENT).toBe('all');
    });

    it('refuses rather than guessing when a save carries no snapshot at all', async () => {
      // Only a hand-edited drafts.json can produce this now. Replaying it would revert its keys
      // further than the drop asked, which is a wrong answer offered as a right one.
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });
      const draft = await drafts.get('iam/dev');
      await drafts.put({
        ...(draft as NonNullable<typeof draft>),
        saves: [{ keys: ['MFA_ENFORCEMENT'], actor: ACTOR.email, at: 1 }, ...(draft?.saves ?? [])],
      });

      const result = await service.dropSave('iam/dev', 1, ACTOR);

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error.detail).toMatch(/snapshot/i);
    });

    it('refuses a save index that is not there', async () => {
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      expect((await service.dropSave('iam/dev', 7, ACTOR)).ok).toBe(false);
      expect((await service.dropSave('iam/nope', 0, ACTOR)).ok).toBe(false);
    });
  });

  describe('a draft that created a namespace', () => {
    // basedOn was only recorded when the file already existed, and the conflict check skips a
    // draft that has none — so a draft creating a namespace overwrote whatever another host
    // committed meanwhile, and wrote its own version over theirs.
    it('records that there was no file to base it on', async () => {
      await stage('api', 'dev', { RATE_LIMIT: 10 });

      expect((await drafts.get('api/dev'))?.basedOn).toBeNull();
    });

    it('refuses to publish once that file exists', async () => {
      await stage('api', 'dev', { RATE_LIMIT: 10 });
      // Another host commits the file this draft believed did not exist.
      await repo.commit({ 'config/api/dev.yaml': 'version: 41\nRATE_LIMIT: 99\n' });

      const result = await service.publish(['api/dev'], ACTOR, REQUEST);

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error.code).toBe('conflict');
    });

    it('publishes normally when the file still does not exist', async () => {
      await stage('api', 'dev', { RATE_LIMIT: 10 });

      expect((await service.publish(['api/dev'], ACTOR, REQUEST)).ok).toBe(true);
    });
  });

  describe('the version never goes backwards', () => {
    it('refuses to lower it even when a draft carries a stale number', async () => {
      // Reachable by restoring drafts.json from a backup: the draft's base still matches the
      // file, so nothing is in conflict, but its document carries a number from before. A
      // counter that goes backwards tells a consumer it is up to date when it is not.
      await repo.commit({ 'config/iam/dev.yaml': 'version: 41\nMFA_ENFORCEMENT: optional\n' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      const draft = await drafts.get('iam/dev');
      const stale = await new SopsEncryptor(repo.dir).encrypt(
        'iam/dev',
        'version: 2\nMFA_ENFORCEMENT: all\n',
      );
      await drafts.put({ ...(draft as NonNullable<typeof draft>), document: stale });

      await service.publish(['iam/dev'], ACTOR, REQUEST);

      expect(versionOf((await served('iam/dev')) ?? {})).toBe(42);
    });

    it('publishes above whatever the committed file carries', async () => {
      // A draft numbered 1 published over a file at 41 regressed the counter, and the counter
      // exists so a consumer can tell whether it has the latest.
      await repo.commit({ 'config/iam/dev.yaml': 'version: 41\nMFA_ENFORCEMENT: optional\n' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'all' });

      await service.publish(['iam/dev'], ACTOR, REQUEST);

      expect(versionOf((await served('iam/dev')) ?? {})).toBeGreaterThan(41);
    });
  });

  describe('staging a selection with no edit in it', () => {
    // Ticking a key whose value has not changed is how you say "send this one along" — to a
    // publish, and from there to the next environment. It has to be possible to write that
    // down, or the intent is lost the moment the page is left.
    it('drafts the ticked keys even though no value moved', async () => {
      const result = await service.stage(
        {
          service: 'iam',
          environment: 'dev',
          changes: { MFA_ENFORCEMENT: 'optional' },
          selected: ['MFA_ENFORCEMENT'],
        },
        ACTOR,
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.changes.map((c) => c.key)).toEqual(['MFA_ENFORCEMENT']);
      expect(await drafts.get('iam/dev')).not.toBeNull();
    });

    it('records it as unchanged, rather than as a value moving to itself', async () => {
      const result = await service.stage(
        {
          service: 'iam',
          environment: 'dev',
          changes: { MFA_ENFORCEMENT: 'optional' },
          selected: ['MFA_ENFORCEMENT'],
        },
        ACTOR,
      );

      const change = result.ok ? result.value.changes[0] : null;
      expect(change?.from).toEqual(change?.to);
    });

    it('counts as a revision, like any other draft save', async () => {
      await service.stage(
        {
          service: 'iam',
          environment: 'dev',
          changes: { MFA_ENFORCEMENT: 'optional' },
          selected: ['MFA_ENFORCEMENT'],
        },
        ACTOR,
      );

      expect(await versionOfDraft('iam/dev')).toBe(1);
    });

    it('does not shadow a real edit to the same key', async () => {
      const result = await service.stage(
        {
          service: 'iam',
          environment: 'dev',
          changes: { MFA_ENFORCEMENT: 'all' },
          selected: ['MFA_ENFORCEMENT'],
        },
        ACTOR,
      );

      expect(result.ok && result.value.changes).toEqual([
        { key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all', secret: false },
      ]);
    });
  });

  describe('staging', () => {
    it('does not commit', async () => {
      // The defining change. A save is now a draft, and the repository is untouched until
      // someone publishes.
      const before = await git.headCommit();

      const result = await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });

      expect(result.ok).toBe(true);
      expect(await git.headCommit()).toBe(before);
    });

    it('still refuses a value the schema rejects', async () => {
      // Validation must not move to publish time: an operator who staged nonsense should learn
      // at the moment they typed it, not when they try to ship three environments at once.
      const result = await stage('iam', 'prod', { SESSION_TTL: 1 });

      expect(result.ok).toBe(false);
      expect(await drafts.all()).toEqual([]);
    });

    it('records what changed, for the pending list', async () => {
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });

      const draft = await drafts.get('iam/prod');
      expect(draft?.changes).toEqual([
        { key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all', secret: false },
      ]);
    });

    it('records a secret change without recording the secret', async () => {
      // The hover diff shows old and new. For a secret both must be absent, or the console
      // displays exactly what encrypting it was for.
      await stage('iam', 'prod', { SMTP_PASSWORD: 'hunter2' });

      const draft = await drafts.get('iam/prod');
      expect(draft?.changes).toEqual([
        { key: 'SMTP_PASSWORD', from: undefined, to: undefined, secret: true },
      ]);
      expect(JSON.stringify(draft)).not.toContain('hunter2');
    });

    it('encrypts the secret at staging time, not at publish time', async () => {
      // A draft can sit for days. Holding the plaintext until publish would put it on disk with
      // none of the protections the repository has.
      await stage('iam', 'prod', { SMTP_PASSWORD: 'hunter2' });

      expect((await drafts.get('iam/prod'))?.document).toContain('ENC[AES256_GCM');
    });

    it('builds on an earlier draft rather than discarding it', async () => {
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'prod', { SESSION_TTL: 600 });

      const draft = await drafts.get('iam/prod');
      expect(draft?.document).toContain('all');
      expect(draft?.document).toContain('600');
    });
  });

  describe('publishing one environment', () => {
    it('commits only that namespace', async () => {
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'admins' });

      const result = await service.publish(['iam/prod'], ACTOR, REQUEST);

      expect(result.ok).toBe(true);
      expect(await served('iam/prod')).toMatchObject({ MFA_ENFORCEMENT: 'all' });
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'optional' });
    });

    it('leaves the drafts it did not publish', async () => {
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'admins' });

      await service.publish(['iam/prod'], ACTOR, REQUEST);

      expect((await drafts.all()).map((d) => d.namespace)).toEqual(['iam/dev']);
    });

    it('records the actor and the keys in the commit', async () => {
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });

      await service.publish(['iam/prod'], ACTOR, REQUEST);

      const body = await repo.git('log', '-1', '--format=%B');
      // The subject is generated; the trailers are what carry the audit facts.
      expect(body).toContain('Publish 1 draft in iam/prod');
      expect(body).toContain('Actor: me@anudeep.pro');
      expect(body).toContain('Key: MFA_ENFORCEMENT');
    });
  });

  describe('publishing a whole product', () => {
    it('commits every environment of it', async () => {
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'admins' });

      await service.publish(['iam/prod', 'iam/dev'], ACTOR, REQUEST);

      expect(await served('iam/prod')).toMatchObject({ MFA_ENFORCEMENT: 'all' });
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'admins' });
      expect(await drafts.all()).toEqual([]);
    });

    it('makes one commit, not one per environment', async () => {
      // The scope the operator chose is the unit of change. Two commits would let a rollback
      // undo half of a decision that was made as a whole.
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      await stage('iam', 'dev', { MFA_ENFORCEMENT: 'admins' });
      const before = Number(await repo.git('rev-list', '--count', 'HEAD'));

      await service.publish(['iam/prod', 'iam/dev'], ACTOR, REQUEST);

      expect(Number(await repo.git('rev-list', '--count', 'HEAD'))).toBe(before + 1);
    });
  });

  describe('publishing across products', () => {
    it('commits namespaces from more than one product together', async () => {
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      await stage('api', 'prod', { RATE_LIMIT: 500 });

      await service.publish(['iam/prod', 'api/prod'], ACTOR, REQUEST);

      expect(await served('iam/prod')).toMatchObject({ MFA_ENFORCEMENT: 'all' });
      expect(await served('api/prod')).toMatchObject({ RATE_LIMIT: 500 });
    });
  });

  describe('what publishing refuses', () => {
    it('refuses a namespace with nothing staged', async () => {
      const result = await service.publish(['iam/prod'], ACTOR, REQUEST);

      expect(result.ok).toBe(false);
    });

    it('publishes nothing when one namespace in the scope has no draft', async () => {
      // All or nothing. A partial publish would commit half of what the operator selected and
      // report success, leaving them to discover the rest later.
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      const before = await git.headCommit();

      const result = await service.publish(['iam/prod', 'iam/dev'], ACTOR, REQUEST);

      expect(result.ok).toBe(false);
      expect(await git.headCommit()).toBe(before);
      expect((await drafts.all()).map((d) => d.namespace)).toEqual(['iam/prod']);
    });

    it('asks for no message at all: the commit subject is generated', async () => {
      // An operator mid-incident has better things to do than compose a subject line, and a
      // generated one cannot be left as "wip".
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });

      const result = await service.publish(['iam/prod'], ACTOR, REQUEST);

      expect(result.ok).toBe(true);
      expect(await repo.git('log', '-1', '--format=%s')).toContain('Publish 1 draft in iam/prod');
    });

    it('refuses when the repository moved under a draft', async () => {
      // Someone edited the file on GitHub after this draft was built. Publishing would silently
      // overwrite their change with a document assembled from stale values.
      await stage('iam', 'prod', { MFA_ENFORCEMENT: 'all' });
      await repo.commit({ 'config/iam/prod.yaml': 'MFA_ENFORCEMENT: admins\nSESSION_TTL: 7200\n' });

      const result = await service.publish(['iam/prod'], ACTOR, REQUEST);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('conflict');
    });
  });
});
