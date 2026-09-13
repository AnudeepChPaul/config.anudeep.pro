import type { JournalEntry } from '@config/src/store/write-journal.js';
import { formatGistWhen, gistFromJournal, syncRowsFromJournal } from '@config/src/views/sync-gist.js';
import { describe, expect, it } from 'vitest';

const entry = (over: Partial<JournalEntry> & Pick<JournalEntry, 'path'>): JournalEntry => ({
  actor: 'ops@anudeep.pro',
  keys: ['SESSION_TTL'],
  revision: '1',
  timestamp: '2026-09-11T00:00:00.000Z',
  ...over,
});

describe('gistFromJournal', () => {
  it('turns a config path into a product · environment label and drops metadata keys', () => {
    const [gist] = gistFromJournal([
      entry({ path: 'config/iam/prod.yaml', keys: ['SESSION_TTL', 'version'] }),
    ]);
    expect(gist?.label).toBe('Iam · Prod');
    expect(gist?.keys).toEqual(['SESSION_TTL']);
    expect(gist?.actors).toEqual(['ops@anudeep.pro']);
    expect(gist?.writes).toBe(1);
    expect(gist?.lastAt).toBe('2026-09-11T00:00:00.000Z');
  });

  it('keeps the latest write time when several writes hit the same file', () => {
    const [gist] = gistFromJournal([
      entry({ path: 'config/iam/prod.yaml', timestamp: '2026-09-11T00:00:00.000Z' }),
      entry({ path: 'config/iam/prod.yaml', timestamp: '2026-09-12T15:04:00.000Z' }),
    ]);
    expect(gist?.lastAt).toBe('2026-09-12T15:04:00.000Z');
    expect(formatGistWhen(gist?.lastAt ?? '')).toBe('12 Sep 2026, 15:04 UTC');
  });

  it('collapses several writes to the same file into one gist', () => {
    const gists = gistFromJournal([
      entry({ path: 'config/iam/prod.yaml', keys: ['SESSION_TTL'] }),
      entry({
        path: 'config/iam/prod.yaml',
        keys: ['MFA_ENFORCEMENT'],
        actor: 'other@anudeep.pro',
      }),
      entry({ path: 'flags.yaml', keys: ['NewCheckout'] }),
    ]);
    expect(gists).toHaveLength(2);
    expect(gists[0]?.label).toBe('Iam · Prod');
    expect(gists[0]?.keys).toEqual(['MFA_ENFORCEMENT', 'SESSION_TTL']);
    expect(gists[0]?.actors).toEqual(['ops@anudeep.pro', 'other@anudeep.pro']);
    expect(gists[0]?.writes).toBe(2);
    expect(gists[1]?.label).toBe('Features');
    expect(gists[1]?.keys).toEqual(['NewCheckout']);
  });

  it('omits a retiring product from leftover gists', () => {
    const rows = syncRowsFromJournal(
      [
        entry({ path: 'config/iam/prod.yaml', keys: ['SESSION_TTL'] }),
        entry({ path: 'schema/iam.yaml', keys: ['retiring'] }),
        entry({ path: 'config/web/dev.yaml', keys: ['COUNT'] }),
      ],
      new Set(['iam']),
    );
    expect(rows.retiring).toEqual(['iam']);
    expect(rows.gists).toHaveLength(1);
    expect(rows.gists[0]?.label).toBe('Web · Dev');
  });

  it('omits a schema retirement write even when the retiring set was not passed in', () => {
    const rows = syncRowsFromJournal(
      [
        entry({ path: 'schema/wqertgh.yaml', keys: ['retiring'] }),
        entry({ path: 'config/iam/dev.yaml', keys: ['COUNT'] }),
      ],
      new Set(),
    );
    expect(rows.gists.map((gist) => gist.path)).toEqual(['config/iam/dev.yaml']);
    expect(rows.gists.map((gist) => gist.label).join()).not.toMatch(/schema/i);
  });

  it('nests a new product under the registry and keeps its env files with it', () => {
    const rows = syncRowsFromJournal(
      [
        entry({ path: 'services.yaml', keys: ['api'] }),
        entry({ path: 'schema/api.yaml', keys: ['api'] }),
        entry({ path: 'config/api/dev.yaml', keys: ['COUNT'] }),
        entry({ path: 'config/api/prod.yaml', keys: ['COUNT'] }),
        entry({ path: 'config/web/dev.yaml', keys: ['TIMEOUT'] }),
      ],
      new Set(),
    );
    expect(rows.added).toEqual(['api']);
    expect(rows.configsOf.api?.map((gist) => gist.path)).toEqual([
      'config/api/dev.yaml',
      'config/api/prod.yaml',
    ]);
    expect(rows.gists.map((gist) => gist.path)).toEqual(['config/web/dev.yaml']);
  });

  it('lists an archived product instead of hiding it as leftover gists', () => {
    const rows = syncRowsFromJournal(
      [
        entry({ path: 'services.yaml', keys: ['iam'] }),
        entry({ path: 'archived/iam.yaml', keys: ['iam'] }),
        entry({ path: 'schema/iam.yaml', keys: ['iam'] }),
        entry({ path: 'config/iam/dev.yaml', keys: ['iam'] }),
        entry({ path: 'config/web/dev.yaml', keys: ['COUNT'] }),
      ],
      new Set(),
    );
    expect(rows.archived).toEqual(['iam']);
    expect(rows.added).toEqual([]);
    expect(rows.gists.map((gist) => gist.path)).toEqual(['config/web/dev.yaml']);
  });

  it('shows an archive even when the product was also marked retiring', () => {
    const rows = syncRowsFromJournal(
      [
        entry({ path: 'schema/iam.yaml', keys: ['retiring', 'iam'] }),
        entry({ path: 'archived/iam.yaml', keys: ['iam'] }),
        entry({ path: 'config/web/dev.yaml', keys: ['COUNT'] }),
      ],
      new Set(['iam']),
    );
    expect(rows.archived).toEqual(['iam']);
    expect(rows.gists.map((gist) => gist.path)).toEqual(['config/web/dev.yaml']);
  });
});
