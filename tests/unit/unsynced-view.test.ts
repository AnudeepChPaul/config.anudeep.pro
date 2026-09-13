// @vitest-environment jsdom
import { type KeyRow, renderProduct, renderProducts } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

const definition = (over: Record<string, unknown> = {}) =>
  ({ type: 'string', secret: false, ...over }) as unknown as KeyRow['definition'];

describe('unsynced changes on the product list', () => {
  it('states how many keys are unsynced on the facts line and on the product row', () => {
    document.body.innerHTML = String(
      renderProducts({
        products: [
          {
            name: 'iam',
            environments: ['dev'],
            retiring: false,
            keys: ['SESSION_TTL'],
            unsynced: 2,
          },
        ],
        unsynced: 2,
      }),
    );

    expect(document.querySelector('.facts')?.textContent).toMatch(/2 unsynced/);
    expect(document.querySelector('.chip.wait')?.textContent).toBe('2 unsynced');
  });
});

describe('unsynced changes on the product page', () => {
  it('badges unsynced count on the idle line and peeks the changelog on hover', () => {
    document.body.innerHTML = String(
      renderProduct({
        service: 'iam',
        environment: 'dev',
        environments: ['dev'],
        etag: 'e',
        rows: [
          {
            key: 'SESSION_TTL',
            definition: definition({ type: 'int' }),
            value: 1200,
            change: { key: 'SESSION_TTL', from: 900, to: 1200 },
          },
        ],
        version: 2,
        next: null,
        retiring: false,
        missing: false,
        unsynced: [{ key: 'SESSION_TTL', from: 900, to: 1200 }],
      }),
    );

    const idle = document.querySelector('.idle') as HTMLElement;
    expect(idle.querySelector('.unsynced-badge .chip.wait')?.textContent).toBe('1 unsynced change');
    expect(idle.querySelector('.unsynced-badge .sync-env-name')?.textContent).toBe('Dev');
    expect(idle.querySelector('.unsynced-badge .sync-vars .was')?.textContent).toBe('900');
    expect(idle.querySelector('.unsynced-badge .sync-vars .is')?.textContent).toBe('1200');

    const peek = document.querySelector('.keyline .peek') as HTMLElement;
    expect(peek.querySelector('label')?.textContent).toBe('SESSION_TTL');
    expect(peek.querySelector('.detail .was')?.textContent).toBe('900');
    expect(peek.querySelector('.detail .is')?.textContent).toBe('1200');
  });

  it('masks a secret in the idle changelog and the key hover', () => {
    document.body.innerHTML = String(
      renderProduct({
        service: 'iam',
        environment: 'dev',
        environments: ['dev'],
        etag: 'e',
        rows: [
          {
            key: 'SMTP_PASSWORD',
            definition: definition({ secret: true }),
            value: undefined,
            change: { key: 'SMTP_PASSWORD', from: 'old', to: 'new', secret: true },
          },
        ],
        version: 1,
        next: null,
        retiring: false,
        missing: false,
        unsynced: [{ key: 'SMTP_PASSWORD', from: 'old', to: 'new', secret: true }],
      }),
    );

    expect(document.querySelector('.idle')?.textContent).not.toMatch(/old|new/);
    expect(document.querySelector('.keyline .peek')?.textContent).not.toMatch(/old|new/);
    expect(document.querySelector('.idle .was')?.textContent).toBe('••••');
    expect(document.querySelector('.keyline .peek .is')?.textContent).toBe('••••');
  });
});
