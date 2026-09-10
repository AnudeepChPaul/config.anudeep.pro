import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DBEngine } from '@config/src/store/data-layer.js';
import { FileWriter } from '@config/src/store/file-writer.js';
import { describe, expect, it } from 'vitest';

const makeEngine = async () => {
  const root = await mkdtemp(join(tmpdir(), 'config-db-test-'));
  return { root, engine: new DBEngine(root) };
};

describe('FileWriter', () => {
  it('writes atomically with restrictive permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-file-writer-test-'));
    const path = join(root, 'nested', 'document.yaml');
    const writer = new FileWriter();

    await writer.write(path, 'value: true\n');

    expect(await readFile(path, 'utf8')).toBe('value: true\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('removes a file without affecting sibling files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-file-writer-test-'));
    const writer = new FileWriter();
    const first = join(root, 'first.yaml');
    const second = join(root, 'second.yaml');
    await writer.write(first, 'first');
    await writer.write(second, 'second');

    await writer.remove(first);

    await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(second, 'utf8')).toBe('second');
  });
});

describe('DBEngine', () => {
  it('writes, reads, and reports a stable content ETag', async () => {
    const { engine } = await makeEngine();

    const written = await engine.write({ path: 'config/web/prod.yaml', content: 'a: 1\n' });

    expect(written.kind).toBe('written');
    expect(await engine.read('config/web/prod.yaml')).toBe('a: 1\n');
    expect(await engine.etag('config/web/prod.yaml')).toBe(written.etag);
    expect(await engine.revision()).toBe('1');
  });

  it('does not change revision or write metadata for a no-op', async () => {
    const { engine } = await makeEngine();
    const first = await engine.write({ path: 'flags.yaml', content: 'version: 1\n' });
    if (first.kind === 'conflict') throw new Error('initial write unexpectedly conflicted');

    const second = await engine.write({
      path: 'flags.yaml',
      content: 'version: 1\n',
      expectedEtag: first.etag,
    });

    expect(second).toMatchObject({ kind: 'unchanged', etag: first.etag });
    expect(await engine.revision()).toBe('1');
  });

  it('rejects a stale same-file ETag', async () => {
    const { engine } = await makeEngine();
    const first = await engine.write({ path: 'flags.yaml', content: 'version: 1\n' });
    if (first.kind === 'conflict') throw new Error('initial write unexpectedly conflicted');

    const result = await engine.write({
      path: 'flags.yaml',
      content: 'version: 2\n',
      expectedEtag: 'stale',
    });

    expect(result).toMatchObject({ kind: 'conflict', expected: 'stale', actual: first.etag });
    expect(await engine.read('flags.yaml')).toBe('version: 1\n');
  });

  it('allows a write to a different path when another path has changed', async () => {
    const { engine } = await makeEngine();
    await engine.write({ path: 'config/a/prod.yaml', content: 'a: 1\n' });

    const result = await engine.write({
      path: 'config/b/prod.yaml',
      content: 'b: 1\n',
    });

    expect(result.kind).toBe('written');
    expect(await engine.revision()).toBe('2');
  });

  it('removes a file using its ETag and increments revision', async () => {
    const { engine } = await makeEngine();
    const first = await engine.write({ path: 'config/web/prod.yaml', content: 'a: 1\n' });
    if (first.kind === 'conflict') throw new Error('initial write unexpectedly conflicted');

    const result = await engine.remove({ path: 'config/web/prod.yaml', expectedEtag: first.etag });

    expect(result.kind).toBe('removed');
    expect(await engine.read('config/web/prod.yaml')).toBeNull();
    expect(await engine.revision()).toBe('2');
  });

  it('emits one attribution event for each successful mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-db-test-'));
    const events: unknown[] = [];
    const engine = new DBEngine(root, {
      onWrite: (event) => {
        events.push(event);
      },
    });

    await engine.write({
      path: 'flags.yaml',
      content: 'version: 1\n',
      actor: 'operator',
      keys: ['A'],
    });
    await engine.write({ path: 'flags.yaml', content: 'version: 1\n' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'operator', keys: ['A'], revision: '1' });
  });

  it('writes a validated batch with one revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-db-test-'));
    const engine = new DBEngine(root);

    const result = await engine.writeBatch([
      { path: 'services.yaml', content: 'version: 1\nservices: []\n' },
      { path: 'schema.yaml', content: 'version: 1\nservices: {}\n' },
    ]);

    expect(result.kind).toBe('written');
    expect(await engine.revision()).toBe('1');
    expect(await engine.read('services.yaml')).toContain('services');
    expect(await engine.read('schema.yaml')).toContain('version: 1');
  });
});
