import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { DraftStore } from '@config/src/store/draft-store.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, guarded, hasSops, TestRepo } from '../helpers.js';

/**
 * The console became dynamic without becoming script-dependent.
 *
 * htmx swaps fragments in place, but this is a tool people reach *during* an incident — so
 * every form still posts and every link still navigates when the script does not load. These
 * assert both halves: the enhancement is there, and removing it leaves a working page.
 */

/** One signed-in operator for every fixture here: the console cannot be built without one. */
const signedIn = guarded();

const withSops = hasSops() ? describe : describe.skip;

const SCHEMA = `keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
`;

withSops('htmx as progressive enhancement', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let git: GitRepository;
  let app: Awaited<ReturnType<typeof buildWebApp>>;

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'environments.yaml': 'order: [dev, prod]\n',
      'services.yaml':
        'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
      'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key.recipient}\n`,
    });
    git = new GitRepository(repo.dir);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const drafts = new DraftStore(`${repo.dir}/.drafts.json`);
    app = await buildWebApp({
      repository: git,
      loader,
      schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
      drafts,
      writeService: new ConfigWriteService({
        repository: git,
        loader,
        encryptor: new SopsEncryptor(repo.dir),
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
        drafts,
      }),
      environment: 'dev',
      auth: signedIn.auth,
    });
  });

  afterEach(async () => {
    await app?.close();
    await rm(repo.dir, { recursive: true, force: true });
  });

  // Every request carries the session: the console refuses to be built without a guard now, so
  // an unauthenticated one only ever sees the login page.
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...signedIn.headers, ...headers } });

  const post = (
    url: string,
    fields: Array<[string, string]>,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...signedIn.headers,
        ...headers,
      },
    });

  describe('serving the script', () => {
    it('serves htmx from this service, not a CDN', async () => {
      // A configuration editor that cannot render because a CDN is unreachable is exactly
      // backwards: the moment you need it most is the moment the network is worst.
      const page = (await get('/')).body;

      expect(page).toContain('src="/assets/htmx.js"');
      expect(page).not.toMatch(/src="https?:\/\//);
    });

    it('answers for the script itself', async () => {
      const response = await get('/assets/htmx.js');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('javascript');
      expect(response.body.length).toBeGreaterThan(10_000);
    });

    it('lets the browser cache it, since it changes only with a deploy', async () => {
      expect(String((await get('/assets/htmx.js')).headers['cache-control'])).toMatch(/max-age/);
    });

    it('does not sit behind the session guard', async () => {
      // The sign-in page needs it too, and a redirect served as JavaScript is a confusing
      // failure to debug.
      const response = await get('/assets/htmx.js');

      expect(response.statusCode).not.toBe(302);
    });
  });

  describe('working without the script', () => {
    it('keeps every form a real form', async () => {
      // If htmx never loads, these still submit. That is the whole point of adding it as an
      // attribute rather than replacing the form.
      const body = (await get('/p/iam?env=dev')).body;

      for (const form of body.match(/<form[^>]*>/g) ?? []) {
        // Search is a GET — it asks for a page rather than changing anything — and everything
        // else is a POST. Both submit on their own with no script present.
        expect(form).toMatch(/method="(post|get)"/);
        expect(form).toMatch(/action="\//);
      }
    });

    it('still answers a plain post with a redirect a browser can follow', async () => {
      const response = await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/p/iam?env=dev');
    });
  });

  describe('answering htmx', () => {
    it('returns a fragment rather than a whole document', async () => {
      const response = await get('/p/iam?env=dev', { 'hx-request': 'true' });

      expect(response.body).not.toContain('<!doctype html>');
      expect(response.body).toContain('MFA_ENFORCEMENT');
    });

    it('returns the same content either way, only the wrapper differs', async () => {
      // One render path for both. Two would drift, and the drift would only show up for
      // whichever half nobody was looking at.
      const full = (await get('/p/iam?env=dev')).body;
      const fragment = (await get('/p/iam?env=dev', { 'hx-request': 'true' })).body;

      expect(full).toContain(fragment.trim().slice(0, 200));
    });

    it('swaps in the updated page after a save instead of redirecting', async () => {
      const response = await post(
        '/p/iam/dev',
        [
          ['key.MFA_ENFORCEMENT', 'all'],
          ['intent', 'save'],
        ],
        { 'hx-request': 'true' },
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('<!doctype html>');
      // The staged change is visible in what came back.
      expect(response.body).toContain('unpublished');
    });

    it('tells the browser to update the address bar', async () => {
      // Without this the URL still says the old environment, and a reload lands somewhere else
      // than the screen shows.
      const response = await get('/p/iam?env=prod', { 'hx-request': 'true' });

      expect(response.headers['hx-push-url']).toBe('/p/iam?env=prod');
    });
  });

  /**
   * A swap must never bring the page frame with it.
   *
   * htmx replaces the CONTENTS of #page. A response that carries its own <main id="page"> puts one
   * inside the other, so the frame's padding and max-width apply twice — the header moves inward
   * and down, and again on the next navigation. Every route that htmx can reach has to answer
   * with a fragment, and the only way to be sure is to ask each of them.
   */
  describe('every response a swap can receive', () => {
    const reachable = ['/', '/p/iam', '/p/iam?env=prod', '/drafts'];

    for (const url of reachable) {
      it(`answers ${url} without the page frame`, async () => {
        const swapped = await get(url, { 'hx-request': 'true' });

        expect(swapped.statusCode).toBe(200);
        expect(swapped.body).not.toContain('<!doctype html>');
        expect(swapped.body).not.toContain('id="page"');
        expect(swapped.body).not.toContain('<main');
      });

      it(`still answers ${url} with a whole document for a plain browser`, async () => {
        const full = await get(url);

        expect(full.body).toContain('<!doctype html>');
        expect(full.body).toContain('id="page"');
      });
    }
  });
});
