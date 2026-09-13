import { nextPathFromRequest, safeNextPath } from '@config/src/routes/safe-next-path.js';
import { describe, expect, it } from 'vitest';

describe('safeNextPath', () => {
  it('keeps a relative console path', () => {
    expect(safeNextPath('/p/iam?env=prod')).toBe('/p/iam?env=prod');
  });

  it('rejects an open redirect', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
  });
});

describe('nextPathFromRequest', () => {
  it('uses htmx current URL when the footer does not post a next path', () => {
    expect(
      nextPathFromRequest({
        hxCurrentUrl: 'http://127.0.0.1:8200/p/iam?env=prod',
      }),
    ).toBe('/p/iam?env=prod');
  });
});
