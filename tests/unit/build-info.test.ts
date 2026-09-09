import { buildInfo, buildLabel } from '@config/src/build-info.js';
import { renderProducts } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

/**
 * What is actually running here.
 *
 * A footer version exists to answer one question during an incident: is the thing in front of me
 * the thing I think I deployed? `package.json` alone cannot answer it — 0.1.0 is every build of
 * 0.1.0 — so the commit is baked in at image build time and shown beside it.
 *
 * The container id is the honest half of "which image". A container cannot know the name of the
 * image it came from; it knows its own id, and that is what is shown rather than a guess.
 */
describe('the build label', () => {
  it('names the version and the commit it was built from', () => {
    expect(
      buildLabel({ version: '0.1.0', sha: 'a1b2c3d4e5f6', containerId: 'deadbeef' }),
    ).toContain('0.1.0');
    expect(
      buildLabel({ version: '0.1.0', sha: 'a1b2c3d4e5f6', containerId: 'deadbeef' }),
    ).toContain('a1b2c3d');
  });

  // A forty-character sha in a footer is noise; the short form is what anyone types into git.
  it('shortens the commit to what a person would use', () => {
    const label = buildLabel({ version: '0.1.0', sha: 'a'.repeat(40), containerId: 'x' });
    expect(label).not.toContain('a'.repeat(40));
    expect(label).toContain('a'.repeat(7));
  });

  it('says the build is unknown rather than inventing one', () => {
    const label = buildLabel({ version: '0.1.0', sha: null, containerId: 'deadbeef' });
    expect(label).toContain('0.1.0');
    expect(label).not.toContain('+');
  });

  it('carries the container id, which is the part a container actually knows', () => {
    expect(buildLabel({ version: '0.1.0', sha: null, containerId: '7c7c0a6d842a' })).toContain(
      '7c7c0a6d842a',
    );
  });
});

describe('reading the build from the environment', () => {
  it('takes the commit from what the image was built with', () => {
    expect(buildInfo({ CONFIG_BUILD_SHA: 'abc1234' }).sha).toBe('abc1234');
  });

  // An unset build argument interpolates to an empty string, which is not a commit.
  it('treats an empty build argument as no commit at all', () => {
    expect(buildInfo({ CONFIG_BUILD_SHA: '' }).sha).toBeNull();
    expect(buildInfo({}).sha).toBeNull();
  });

  it('reports a version, whatever the environment says', () => {
    expect(buildInfo({}).version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/**
 * The label has to reach the page.
 *
 * A rule in the stylesheet and a value in the options are both invisible if the markup never
 * renders them -- which has now happened twice on this footer, because a reformatted template
 * silently stopped matching an edit.
 */
describe('the footer', () => {
  it('renders the build where a page is given one', () => {
    const page = String(
      renderProducts({
        products: [],
        commit: 'a'.repeat(40),
        build: '0.1.0+abc1234 · deadbeef',
      }),
    );

    expect(page).toContain('class="pagefoot"');
    expect(page).toContain('0.1.0+abc1234');
    expect(page).toContain('deadbeef');
  });

  it('renders the footer for the build alone, with no settings link', () => {
    const page = String(
      renderProducts({ products: [], commit: 'a'.repeat(40), build: '0.1.0 · deadbeef' }),
    );

    expect(page).toContain('0.1.0');
    expect(page).not.toContain('/settings');
  });

  it('renders no footer at all when there is nothing to put in it', () => {
    const page = String(renderProducts({ products: [], commit: 'a'.repeat(40) }));

    expect(page).not.toContain('class="pagefoot"');
  });
});
