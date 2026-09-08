import { createHmac } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { buildWebhookApp } from '@config/src/app.js';
import { GitRepository } from '@config/src/git/repository.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestRepo } from '../helpers.js';

/**
 * The one route on this service that the public internet can reach.
 *
 * Everything else is either behind a session or on a Unix socket. This is a URL GitHub posts to,
 * which means anyone can post to it — so the signature is the whole of its access control, and
 * every test here is about what happens when it is wrong.
 */

const SECRET = 'webhook-secret';

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const PUSH = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40) });

describe('the GitHub push webhook', () => {
  let repo: TestRepo;
  let app: Awaited<ReturnType<typeof buildWebhookApp>>;
  let onPush: ReturnType<typeof vi.fn>;

  const start = async (secret: string | null = SECRET) => {
    onPush = vi.fn(async () => {});
    app = await buildWebhookApp({
      secret,
      onPush: onPush as unknown as () => Promise<void>,
    });
    return app;
  };

  const post = (body: string, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: body,
      headers: { 'content-type': 'application/json', ...headers },
    });

  beforeEach(async () => {
    repo = await TestRepo.create();
    await start();
  });

  afterEach(async () => {
    await app?.close();
    await rm(repo.dir, { recursive: true, force: true });
  });

  describe('accepting a genuine push', () => {
    it('accepts a correctly signed push event', async () => {
      const response = await post(PUSH, {
        'x-hub-signature-256': sign(PUSH),
        'x-github-event': 'push',
      });

      expect(response.statusCode).toBe(202);
      expect(onPush).toHaveBeenCalledOnce();
    });

    it('accepts a payload whose formatting JSON.stringify would not reproduce', async () => {
      // The bug this catches: verifying against `JSON.stringify(request.body)` instead of the
      // bytes that arrived. That passes every other test here — a tampered body mismatches
      // either way — and then rejects real deliveries, because re-serialising drops whitespace
      // and reorders keys. Signed over the exact text below, this must be accepted.
      const spaced = '{\n  "ref": "refs/heads/main",\n  "after": "aaa"\n}';

      const response = await post(spaced, {
        'x-hub-signature-256': sign(spaced),
        'x-github-event': 'push',
      });

      expect(response.statusCode).toBe(202);
      expect(onPush).toHaveBeenCalledOnce();
    });

    it('answers before doing the work', async () => {
      // GitHub times out in ten seconds and retries. A pull that takes longer than that would
      // turn one push into a queue of duplicate deliveries.
      const response = await post(PUSH, {
        'x-hub-signature-256': sign(PUSH),
        'x-github-event': 'push',
      });

      expect(response.statusCode).toBe(202);
    });
  });

  describe('refusing anything else', () => {
    it('refuses a payload with no signature', async () => {
      const response = await post(PUSH, { 'x-github-event': 'push' });

      expect(response.statusCode).toBe(401);
      expect(onPush).not.toHaveBeenCalled();
    });

    it('refuses a signature made with the wrong secret', async () => {
      const response = await post(PUSH, {
        'x-hub-signature-256': sign(PUSH, 'not-the-secret'),
        'x-github-event': 'push',
      });

      expect(response.statusCode).toBe(401);
      expect(onPush).not.toHaveBeenCalled();
    });

    it('refuses a body that was changed after it was signed', async () => {
      // The signature must cover the bytes that arrived, not a re-serialisation of them. A
      // route that verifies against `JSON.stringify(request.body)` passes every other test here
      // and accepts a tampered payload whose keys happen to reorder identically.
      const tampered = JSON.stringify({ ref: 'refs/heads/main', after: 'b'.repeat(40) });

      const response = await post(tampered, {
        'x-hub-signature-256': sign(PUSH),
        'x-github-event': 'push',
      });

      expect(response.statusCode).toBe(401);
      expect(onPush).not.toHaveBeenCalled();
    });

    it('refuses a signature of the wrong shape without throwing', async () => {
      for (const bad of ['', 'sha256=', 'garbage', 'sha1=abc', 'sha256=zz']) {
        const response = await post(PUSH, {
          'x-hub-signature-256': bad,
          'x-github-event': 'push',
        });
        expect(response.statusCode).toBe(401);
      }
      expect(onPush).not.toHaveBeenCalled();
    });

    it('refuses everything when no secret is configured', async () => {
      // An unset secret must close the door, not open it. This route is reachable from the
      // internet, so failing open here is failing open to everyone.
      await app.close();
      await start(null);

      const response = await post(PUSH, {
        'x-hub-signature-256': sign(PUSH),
        'x-github-event': 'push',
      });

      expect(response.statusCode).toBe(503);
      expect(onPush).not.toHaveBeenCalled();
    });
  });

  describe('events that are not a push', () => {
    it('acknowledges a ping without pulling', async () => {
      // GitHub sends one when the webhook is created; answering anything but 2xx makes the UI
      // show the hook as broken.
      const body = JSON.stringify({ zen: 'Non-blocking is better than blocking.' });

      const response = await post(body, {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'ping',
      });

      expect(response.statusCode).toBe(204);
      expect(onPush).not.toHaveBeenCalled();
    });

    it('ignores a push to a branch that is not main', async () => {
      // A pull request branch is not the configuration being served.
      const body = JSON.stringify({ ref: 'refs/heads/some-feature' });

      const response = await post(body, {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'push',
      });

      expect(response.statusCode).toBe(204);
      expect(onPush).not.toHaveBeenCalled();
    });
  });
});

describe('GitRepository.pull', () => {
  const repos: string[] = [];

  afterEach(async () => {
    await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('brings in a commit made elsewhere', async () => {
    // What the webhook exists to trigger: someone edited the repository on GitHub.
    const origin = await TestRepo.create();
    repos.push(origin.dir);
    await origin.commit({ 'config/iam/prod.yaml': 'A: 1\n' });

    const clone = await TestRepo.cloneOf(origin.dir);
    repos.push(clone.dir);
    await origin.commit({ 'config/iam/prod.yaml': 'A: 2\n' });

    const git = new GitRepository(clone.dir);
    await git.pull();

    expect((await git.readSources()).sources.get('iam/prod')).toBe('A: 2\n');
  });

  it('reports the commit it moved to', async () => {
    const origin = await TestRepo.create();
    repos.push(origin.dir);
    await origin.commit({ 'config/iam/prod.yaml': 'A: 1\n' });
    const clone = await TestRepo.cloneOf(origin.dir);
    repos.push(clone.dir);
    const sha = await origin.commit({ 'config/iam/prod.yaml': 'A: 2\n' });

    expect(await new GitRepository(clone.dir).pull()).toBe(sha);
  });

  it('is a no-op when there is nothing new', async () => {
    const origin = await TestRepo.create();
    repos.push(origin.dir);
    await origin.commit({ 'config/iam/prod.yaml': 'A: 1\n' });
    const clone = await TestRepo.cloneOf(origin.dir);
    repos.push(clone.dir);
    const git = new GitRepository(clone.dir);
    const before = await git.headCommit();

    expect(await git.pull()).toBe(before);
  });

  it('fails rather than merging when local and remote have diverged', async () => {
    // A merge commit here would be config nobody wrote. The unpushed local commits are the
    // durable ones; resolving this is a human's decision, not a fast-forward.
    const origin = await TestRepo.create();
    repos.push(origin.dir);
    await origin.commit({ 'config/iam/prod.yaml': 'A: 1\n' });
    const clone = await TestRepo.cloneOf(origin.dir);
    repos.push(clone.dir);

    await origin.commit({ 'config/iam/prod.yaml': 'A: 2\n' });
    await clone.commit({ 'config/iam/prod.yaml': 'A: 3\n' });

    await expect(new GitRepository(clone.dir).pull()).rejects.toThrow();
  });
});
