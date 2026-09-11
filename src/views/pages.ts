import { html, type SafeHtml } from '@config/src/views/html.js';
import { layout, layoutChrome, pageHeader, trail } from '@config/src/views/page-frame.js';
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
}): SafeHtml {
  const breakGlass = options.iamReachable
    ? html``
    : html`<div class="card">
        <div class="banner inset">
          <strong>Every attempt raises an alert.</strong>
          <span class="hint">Successful or not — this credential cannot be revoked through iam.</span>
        </div>
        <form method="post" action="/login/break-glass">
          <div class="field">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" autocomplete="off" required>
          </div>
          <div class="field">
            <label for="code">Authenticator code <span class="hint">6 digits, single use</span></label>
            <input type="text" id="code" name="code" inputmode="numeric" autocomplete="off" required>
          </div>
          <button type="submit">Sign in</button>
        </form>
      </div>`;

  const primary = options.iamReachable
    ? html`<div class="card">
        <p class="sub">Sign in with iam to continue.</p>
        ${
          options.iamConfigured === false
            ? html`<span class="hint">iam sign-in is not configured on this instance.</span>`
            : html`<a href="${options.iamLoginUrl}">Sign in with iam</a>`
        }
      </div>`
    : html`<div class="card">
        <p class="sub">iam is unreachable, so break-glass sign-in is available.</p>
      </div>`;

  return layout(
    'Sign in',
    html`
      <h1>Sign in</h1>
      <p class="sub">config.anudeep.pro</p>
      ${options.error ? html`<div class="card error">${options.error}</div>` : html``}
      ${primary} ${breakGlass}
    `,
  );
}

export function renderSettings(options: {
  env: NodeJS.ProcessEnv;
  /** What is running: version, commit and container id, for the footer. */
  build?: string;
  fragment?: boolean;
  autoSync?: boolean;
  currentPath?: string;
}): SafeHtml {
  const rows = settingsRows(options.env).map(
    (row) => html`<div class="keyrow settings-row">
      <span class="keyname">${row.name}</span>
      <span class="${row.set ? 'settings-value' : 'settings-unset'}">${row.shown}</span>
      ${row.secret ? html`<span class="chip">secret</span>` : html``}
    </div>`,
  );
  const set = settingsRows(options.env).filter((row) => row.set).length;

  const body = html`
      ${pageHeader({
        title: trail('Settings'),
        facts: html`${set} of ${settingsRows(options.env).length} variables set`,
      })}
      <div class="rows">${rows}</div>
    `;

  return options.fragment
    ? body
    : layout('Settings', body, true, options.build, layoutChrome(options));
}
