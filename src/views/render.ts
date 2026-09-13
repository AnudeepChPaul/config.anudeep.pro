import { compiledTemplates } from '@config/src/views/generated/registry.js';
import { renderWithRegistry } from '@config/src/views/runtime.js';

interface ChromeModel {
  readonly fragment?: boolean;
  readonly updateFooter?: boolean;
  readonly updateHeader?: boolean;
}

export function render(name: string, model: object): string {
  const html = renderWithRegistry(compiledTemplates, name, model);
  const options = model as ChromeModel;
  if (!options.fragment) return html;
  const parts = [html];
  if (options.updateHeader) parts.push(renderWithRegistry(compiledTemplates, 'header', model));
  if (options.updateFooter) parts.push(renderWithRegistry(compiledTemplates, 'footer', model));
  return parts.join('');
}
