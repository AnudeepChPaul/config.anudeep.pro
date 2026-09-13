import { layoutChrome } from '@config/src/views/page-frame.js';
import { render } from '@config/src/views/render.js';
import { settingsRows } from '@config/src/views/settings.js';

export { renderFeatureAddRow, renderFeatures } from '@config/src/views/feature-pages.js';
export type {
  LiveKeyRow as KeyRow,
  LiveProduct as ProductSummary,
} from '@config/src/views/live-pages.js';
export {
  renderConfirmation,
  renderLiveProduct as renderProduct,
  renderLiveProducts as renderProducts,
  renderSyncPreview,
} from '@config/src/views/live-pages.js';
export { renderNewProduct } from '@config/src/views/new-product-page.js';
export type { PageNotice } from '@config/src/views/page-frame.js';

export function renderLogin(options: {
  iamReachable: boolean;
  iamConfigured?: boolean;
  iamLoginUrl: string;
  error?: string;
}): string {
  return render('pages/login', {
    title: 'Sign in',
    fragment: false,
    iamReachable: options.iamReachable,
    iamConfigured: options.iamConfigured,
    iamLoginUrl: options.iamLoginUrl,
    error: options.error,
  });
}

export function renderSettings(options: {
  env: NodeJS.ProcessEnv;
  /** What is running: version, commit and container id, for the footer. */
  build?: string;
  fragment?: boolean;
  autoSync?: boolean;
  updateFooter?: boolean;
  updateHeader?: boolean;
}): string {
  const rows = settingsRows(options.env);
  const set = rows.filter((row) => row.set).length;
  return render('pages/settings', {
    title: 'Settings',
    showHeader: true,
    trail: 'Settings',
    fragment: Boolean(options.fragment),
    settingsLink: true,
    build: options.build ?? '',
    ...layoutChrome(options),
    facts: `${set} of ${rows.length} variables set`,
    rows,
  });
}
