import { escapeHtml } from '@config/src/views/html.js';
import { Eta, type TemplateFunction } from 'eta/core';

const hosts = new WeakMap<object, Eta>();

const hostFor = (templates: Readonly<Record<string, TemplateFunction>>): Eta => {
  const existing = hosts.get(templates);
  if (existing) return existing;
  const eta = new Eta({
    autoEscape: true,
    escapeFunction: escapeHtml,
    autoTrim: false,
    cache: true,
  });
  for (const [templateName, templateFn] of Object.entries(templates)) {
    eta.loadTemplate(templateName, templateFn);
  }
  hosts.set(templates, eta);
  return eta;
};

export function renderWithRegistry(
  templates: Readonly<Record<string, TemplateFunction>>,
  name: string,
  model: object,
): string {
  if (!templates[name]) throw new Error(`Unknown template "${name}". Run pnpm eta:compile.`);
  return hostFor(templates).render(name, model);
}
