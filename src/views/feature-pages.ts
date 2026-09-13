import { layoutChrome, type PageNotice, titled } from '@config/src/views/page-frame.js';
import { render } from '@config/src/views/render.js';

export function renderFeatureAddRow(environment = ''): string {
  return render('pages/feature-add-row', {
    environment,
    environmentEncoded: encodeURIComponent(environment),
  });
}

export function renderFeatures(options: {
  flags: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  environment: string;
  environments?: readonly string[];
  commit?: string;
  adding?: boolean;
  notice?: PageNotice;
  error?: string;
  settingsLink?: boolean;
  build?: string;
  fragment?: boolean;
  autoSync?: boolean;
  updateFooter?: boolean;
  updateHeader?: boolean;
}): string {
  const names = Object.keys(options.flags).sort((left, right) => left.localeCompare(right));
  const featureRows = names.map((name) => {
    const enabled = options.flags[name]?.[options.environment] === true;
    return {
      name,
      enabled,
      environment: options.environment,
      action: `/features/${encodeURIComponent(name)}`,
    };
  });
  return render('pages/features', {
    title: 'Features',
    showHeader: true,
    heading: 'Features',
    fragment: Boolean(options.fragment),
    settingsLink: Boolean(options.settingsLink),
    build: options.build ?? '',
    notice: options.notice,
    dismissTo: '/features',
    ...layoutChrome(options),
    activeTab: 'features',
    environment: options.environment,
    adding: Boolean(options.adding),
    error: options.error,
    facts: `Feature flags · ${options.environment}`,
    addUrl: `/features/new?env=${encodeURIComponent(options.environment)}`,
    environmentEncoded: encodeURIComponent(options.environment),
    envTabsLabel: 'Feature environments',
    envTabs: (options.environments ?? []).map((environment) => {
      const url = `/features?env=${encodeURIComponent(environment)}`;
      return { href: url, label: titled(environment), on: environment === options.environment };
    }),
    featureRows,
  });
}
