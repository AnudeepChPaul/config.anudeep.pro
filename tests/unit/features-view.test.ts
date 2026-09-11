import { renderFeatures } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

describe('feature flags view', () => {
  it('renders the features tab, toolbar add action, list items, and switches', () => {
    const page = String(
      renderFeatures({
        flags: { NEW_CHECKOUT: { dev: true }, OLD_CHECKOUT: { dev: false } },
        environment: 'dev',
        commit: 'a'.repeat(40),
      }),
    );

    expect(page).toContain('>Features</a>');
    expect(page).toContain('hx-get="/features/new?env=dev"');
    expect(page).toContain('id="feature-list"');
    expect(page).toContain('NEW_CHECKOUT');
    expect(page).toContain('name="value"');
    expect(page).toContain('checked');
  });

  it('renders the add form as a list item with only a name field', () => {
    const page = String(renderFeatures({ flags: {}, environment: 'dev', adding: true }));

    expect(page).toContain('<li');
    expect(page).toContain('action="/features"');
    expect(page).toContain('name="name"');
    expect(page).toContain('type="hidden" name="environment" value="dev"');
    expect(page).toContain('Save');
  });
});
