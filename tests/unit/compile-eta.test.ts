import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileAll } from '@config/src/views/compile-eta.js';
import { renderWithRegistry } from '@config/src/views/runtime.js';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];

const fixture = async (): Promise<{ templates: string; generated: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'eta-compile-'));
  dirs.push(root);
  const templates = join(root, 'templates');
  const generated = join(root, 'generated');
  await mkdir(templates, { recursive: true });
  return { templates, generated };
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('compileAll', () => {
  it('emits a registry whose interpolations are escaped', async () => {
    const { templates, generated } = await fixture();
    await writeFile(join(templates, 'xss.eta'), '<p><%= it.value %></p>\n', 'utf8');

    const registry = await compileAll({ templatesDir: templates, outDir: generated });
    const html = renderWithRegistry(registry, 'xss', {
      value: '<script>alert(1)</script>',
    });

    expect(html).toContain('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toContain('<script>');
  });

  it('inserts an included partial without double-escaping its markup', async () => {
    const { templates, generated } = await fixture();
    await mkdir(join(templates, 'partials'));
    await writeFile(join(templates, 'partials', 'item.eta'), '<li><%= it.name %></li>\n', 'utf8');
    await writeFile(
      join(templates, 'list.eta'),
      '<ul><%~ include("partials/item") %></ul>\n',
      'utf8',
    );

    const registry = await compileAll({ templatesDir: templates, outDir: generated });
    const html = renderWithRegistry(registry, 'list', { name: 'a<b' });

    expect(html.replaceAll('\n', '')).toBe('<ul><li>a&lt;b</li></ul>');
  });

  it('fails when a template includes an unknown name', async () => {
    const { templates, generated } = await fixture();
    await writeFile(join(templates, 'page.eta'), '<%~ include("partials/missing") %>\n', 'utf8');

    await expect(compileAll({ templatesDir: templates, outDir: generated })).rejects.toThrow(
      /unknown include/i,
    );
  });

  it('fails on template syntax errors and does not write a registry', async () => {
    const { templates, generated } = await fixture();
    await writeFile(join(templates, 'broken.eta'), '<% if (true) { %>\n', 'utf8');

    await expect(compileAll({ templatesDir: templates, outDir: generated })).rejects.toThrow();
    await expect(access(join(generated, 'registry.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('renderWithRegistry', () => {
  it('throws for an unknown template name instead of returning empty HTML', async () => {
    const { templates, generated } = await fixture();
    await writeFile(join(templates, 'ok.eta'), '<p>ok</p>\n', 'utf8');
    const registry = await compileAll({ templatesDir: templates, outDir: generated });

    expect(() => renderWithRegistry(registry, 'missing', {})).toThrow(/run pnpm eta:compile/i);
  });
});
