import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DBEngine } from '@config/src/store/data-layer.js';
import { FileWriter } from '@config/src/store/file-writer.js';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-config-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('recoverable database transactions', () => {
  it('allows another product to finish while the first is still staging', async () => {
    const root = await directory();
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowStage extends FileWriter {
      override async write(path: string, content: string) {
        if (content === 'slow') {
          entered();
          await barrier;
        }
        await super.write(path, content);
      }
    }
    const db = new DBEngine(root, { writer: new SlowStage() });
    const first = db.write({ path: 'config/a/dev.yaml', content: 'slow' });
    await reached;
    try {
      expect(await db.write({ path: 'config/b/dev.yaml', content: 'fast' })).toMatchObject({
        kind: 'written',
        revision: '1',
      });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ kind: 'written', revision: '2' });
  });
  it('holds snapshot readers until all replacements finish', async () => {
    const root = await directory();
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    class PausingWriter extends FileWriter {
      override async install(staged: string, target: string) {
        await super.install(staged, target);
        if (target.endsWith('schema.yaml')) {
          entered();
          await barrier;
        }
      }
    }
    const db = new DBEngine(root, { writer: new PausingWriter() });
    const write = db.writeMany([
      { path: 'schema.yaml', content: 'schema' },
      { path: 'services.yaml', content: 'registry' },
    ]);
    await reached;
    let readFinished = false;
    const reading = db.snapshot().then((snapshot) => {
      readFinished = true;
      return snapshot;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readFinished).toBe(false);
    release();
    await write;
    expect((await reading).files.size).toBe(2);
  });

  it('leaves files unchanged on a staging failure and removes orphan stages', async () => {
    const root = await directory();
    class FailingStage extends FileWriter {
      override async write(path: string, content: string) {
        if (path.endsWith('1.stage')) throw new Error('disk full');
        await super.write(path, content);
      }
    }
    const db = new DBEngine(root, { writer: new FailingStage() });
    await expect(
      db.writeMany([
        { path: 'a.yaml', content: 'a' },
        { path: 'b.yaml', content: 'b' },
      ]),
    ).rejects.toThrow('disk full');
    expect(await db.readAll()).toEqual(new Map());
    expect(await db.revision()).toBe('0');
    expect(await readdir(join(root, '.journal', 'transactions'))).toEqual([]);
  });

  it('refuses recovery of a corrupt staged payload', async () => {
    const root = await directory();
    class FailBeforeInstall extends FileWriter {
      override async install() {
        throw new Error('interrupted');
      }
    }
    await expect(
      new DBEngine(root, { writer: new FailBeforeInstall() }).writeMany([
        { path: 'a.yaml', content: 'a' },
        { path: 'b.yaml', content: 'b' },
      ]),
    ).rejects.toThrow('interrupted');
    const [id] = await readdir(join(root, '.journal', 'transactions'));
    if (!id) throw new Error('expected transaction intent');
    await writeFile(join(root, '.journal', 'transactions', id, '1.stage'), 'corrupt');
    await expect(new DBEngine(root).snapshot()).rejects.toThrow(/missing or corrupt/);
    await expect(readFile(join(root, 'a.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes a create in caller order and advances the revision once', async () => {
    const root = await directory();
    const installed: string[] = [];
    class RecordingWriter extends FileWriter {
      override async install(staged: string, target: string) {
        installed.push(target.slice(root.length + 1));
        await super.install(staged, target);
      }
    }
    const db = new DBEngine(root, { writer: new RecordingWriter() });
    const result = await db.writeMany([
      { path: 'schema.yaml', content: 'schema', expectedEtag: null },
      { path: 'config/web/dev.yaml', content: 'values', expectedEtag: null },
      { path: 'services.yaml', content: 'registry', expectedEtag: null },
    ]);
    expect(result.kind).toBe('written');
    expect(installed).toEqual(['schema.yaml', 'config/web/dev.yaml', 'services.yaml']);
    expect(await db.revision()).toBe('1');
    expect([...(await db.readAll())].map(([path]) => path).sort()).toEqual([
      'config/web/dev.yaml',
      'schema.yaml',
      'services.yaml',
    ]);
  });

  it('checks every ETag before replacing anything, including expected absence', async () => {
    const db = new DBEngine(await directory());
    await db.write({ path: 'services.yaml', content: 'existing' });
    expect(
      await db.writeMany([
        { path: 'schema.yaml', content: 'new schema', expectedEtag: null },
        { path: 'services.yaml', content: 'new registry', expectedEtag: null },
      ]),
    ).toMatchObject({ kind: 'conflict', path: 'services.yaml' });
    expect(await db.read('schema.yaml')).toBeNull();
    expect(await db.revision()).toBe('1');
  });

  it('collects validation errors across the entire request and leaves no intent', async () => {
    const root = await directory();
    const db = new DBEngine(root);
    const result = await db.writeMany(
      ['a.yaml', 'b.yaml'].map((path) => ({
        path,
        content: 'bad',
        validate: () => [{ key: path, message: 'invalid' }],
      })),
    );
    expect(result).toMatchObject({
      kind: 'invalid',
      errors: [
        { key: 'a.yaml', message: 'invalid' },
        { key: 'b.yaml', message: 'invalid' },
      ],
    });
    expect(await db.revision()).toBe('0');
    expect(await db.readAll()).toEqual(new Map());
    expect(await readdir(join(root, '.journal', 'transactions')).catch(() => [])).toEqual([]);
  });

  it('recovers an interrupted create before serving it and never double-increments', async () => {
    const root = await directory();
    class InterruptedWriter extends FileWriter {
      override async install(staged: string, target: string) {
        if (target.endsWith('services.yaml')) throw new Error('simulated process interruption');
        await super.install(staged, target);
      }
    }
    const db = new DBEngine(root, { writer: new InterruptedWriter() });
    await expect(
      db.writeMany([
        { path: 'schema.yaml', content: 'schema' },
        { path: 'config/web/dev.yaml', content: 'values' },
        { path: 'services.yaml', content: 'registry' },
      ]),
    ).rejects.toThrow('simulated process interruption');
    await expect(readFile(join(root, 'services.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(db.readAll()).rejects.toThrow(/recover/i);
    const restarted = new DBEngine(root);
    await restarted.recover();
    expect(await restarted.read('services.yaml')).toBe('registry');
    expect(await restarted.read('config/web/dev.yaml')).toBe('values');
    expect(await restarted.revision()).toBe('1');
    await restarted.recover();
    expect(await restarted.revision()).toBe('1');
  });

  it('recovers deletions as well as replacements, in the supplied safe order', async () => {
    const root = await directory();
    const db = new DBEngine(root);
    await db.writeMany([
      { path: 'services.yaml', content: 'web' },
      { path: 'config/web/dev.yaml', content: 'values' },
      { path: 'schema.yaml', content: 'web schema' },
    ]);
    const result = await db.writeMany([
      { path: 'services.yaml', content: 'empty registry' },
      { path: 'config/web/dev.yaml', content: null },
      { path: 'schema.yaml', content: 'empty schema' },
    ]);
    expect(result.kind).toBe('written');
    expect(await db.read('config/web/dev.yaml')).toBeNull();
    expect(await db.revision()).toBe('2');
  });

  it('serializes a single-file write with a batch touching the same file', async () => {
    const db = new DBEngine(await directory());
    await db.write({ path: 'a.yaml', content: 'old' });
    const expectedEtag = await db.etag('a.yaml');
    const results = await Promise.all([
      db.writeMany([{ path: 'a.yaml', content: 'batch', expectedEtag }]),
      db.write({ path: 'a.yaml', content: 'single', expectedEtag }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'written']);
    expect(await db.revision()).toBe('2');
  });

  it('allocates unique revisions for concurrent writes to different products', async () => {
    const db = new DBEngine(await directory());
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        db.write({ path: `config/product-${n}/dev.yaml`, content: 'value' }),
      ),
    );
    expect(new Set(results.map((result) => result.revision)).size).toBe(12);
    expect(await db.revision()).toBe('12');
  });

  it('rejects duplicate and private transaction paths', async () => {
    const db = new DBEngine(await directory());
    await expect(
      db.writeMany([
        { path: 'a.yaml', content: 'a' },
        { path: 'a.yaml', content: 'b' },
      ]),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      db.write({ path: '.journal/transactions/intent.json', content: 'bad' }),
    ).rejects.toThrow(/path/i);
    expect(await db.revision()).toBe('0');
  });
});
