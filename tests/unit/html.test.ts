import { compileAll } from '@config/src/views/compile-eta.js';
import { escapeHtml } from '@config/src/views/html.js';
import { renderWithRegistry } from '@config/src/views/runtime.js';
import { describe, expect, it } from 'vitest';

/**
 * Escaping, tested on its own because everything the UI renders is attacker-influenced.
 *
 * Config values arrive from the repository, which is edited by people and by GitHub pushes, and
 * key names come from schema files. A value like `</textarea><script>` reaching the page
 * unescaped turns the config editor into a way to run script in an operator's session — the
 * same session that is about to be given permission to change MFA enforcement.
 */

describe('escapeHtml', () => {
  it('escapes the characters that end an element or an attribute', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a"b')).toBe('a&quot;b');
    expect(escapeHtml("a'b")).toBe('a&#39;b');
  });

  it('escapes ampersands first so escapes are not double-decoded', () => {
    // Replacing < before & would turn `&lt;` into `&amp;lt;` and display the wrong text; doing
    // the other way round can produce a live `<` from `&amp;#60;`.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('invite_only')).toBe('invite_only');
  });

  it('handles values that are not strings', () => {
    // YAML gives us numbers, booleans and lists; none of them may reach the page unconverted.
    expect(escapeHtml(3600)).toBe('3600');
    expect(escapeHtml(true)).toBe('true');
    expect(escapeHtml(['ua', '<b>'])).toBe('[&quot;ua&quot;,&quot;&lt;b&gt;&quot;]');
  });

  it('renders null and undefined as empty rather than as the words', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('compiled Eta interpolations', () => {
  it('escapes interpolated values by default', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'eta-escape-'));
    const templates = join(root, 'templates');
    await mkdir(templates);
    await writeFile(join(templates, 'p.eta'), '<p><%= it.value %></p>', 'utf8');
    const registry = await compileAll({ templatesDir: templates, outDir: join(root, 'out') });
    expect(renderWithRegistry(registry, 'p', { value: '<script>alert(1)</script>' })).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    await rm(root, { recursive: true, force: true });
  });

  it('does not escape an included fragment that was already escaped', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'eta-include-esc-'));
    const templates = join(root, 'templates');
    await mkdir(join(templates, 'partials'), { recursive: true });
    await writeFile(join(templates, 'partials', 'item.eta'), '<li><%= it.name %></li>', 'utf8');
    await writeFile(
      join(templates, 'list.eta'),
      '<ul><%~ include("partials/item") %></ul>',
      'utf8',
    );
    const registry = await compileAll({ templatesDir: templates, outDir: join(root, 'out') });
    expect(renderWithRegistry(registry, 'list', { name: 'a<b' }).replaceAll('\n', '')).toBe(
      '<ul><li>a&lt;b</li></ul>',
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe('page templates escape repository strings', () => {
  it('escapes a script in a key name and a value', async () => {
    const { renderProduct } = await import('@config/src/views/pages.js');
    const page = renderProduct({
      service: 'iam',
      environment: 'dev',
      environments: ['dev'],
      etag: 'e',
      rows: [
        {
          key: '<script>x</script>',
          definition: { type: 'string', secret: false },
          value: '</textarea><script>alert(1)</script>',
        },
      ],
      version: 1,
      next: null,
      retiring: false,
      missing: false,
    });
    expect(page).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(page).toContain('&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>x</script>');
    expect(page).not.toContain('</textarea><script>alert(1)</script>');
  });
});
