import type { UnpushedCommit } from '../git/repository.js';
import type { KeyDefinition } from '../schema/validator.js';
import { html, type SafeHtml } from './html.js';

/**
 * Server-rendered pages. No client framework: the whole UI is a list, a form and a redirect,
 * and a build step would be more machinery than the thing it builds.
 */

export interface KeyRow {
  readonly key: string;
  readonly definition: KeyDefinition | null;
  readonly value: unknown;
  readonly error?: string | undefined;
}

const layout = (title: string, body: SafeHtml): SafeHtml => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #16181d; }
  main { max-width: 52rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .sub { color: #5b6070; margin: 0 0 1.5rem; font-size: .875rem; }
  a { color: #1d4ed8; }
  .card { background: #fff; border: 1px solid #e2e5ea; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .banner { border-left: 3px solid #b45309; background: #fffbeb; }
  .error { border-left: 3px solid #b91c1c; background: #fef2f2; }
  label { display: block; font-weight: 600; font-size: .8125rem; margin-bottom: .25rem; }
  .hint { color: #5b6070; font-size: .75rem; font-weight: 400; }
  .field { margin-bottom: 1.1rem; }
  input[type=text], select, textarea { width: 100%; padding: .45rem .6rem; border: 1px solid #cbd0d9; border-radius: 5px; font: inherit; box-sizing: border-box; }
  .err { color: #b91c1c; font-size: .78rem; margin-top: .3rem; }
  button { background: #16181d; color: #fff; border: 0; border-radius: 5px; padding: .55rem 1.1rem; font: inherit; cursor: pointer; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  ul { list-style: none; padding: 0; margin: 0; }
  li + li { margin-top: .5rem; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export function renderIndex(options: {
  namespaces: readonly string[];
  commit: string;
  unpushed: readonly UnpushedCommit[];
}): SafeHtml {
  const rows = options.namespaces.map(
    (namespace) => html`<li><a href="/ns/${namespace}">${namespace}</a></li>`,
  );

  return layout(
    'Configuration',
    html`
      <h1>Configuration</h1>
      <p class="sub">Serving <code>${options.commit.slice(0, 8)}</code></p>
      ${unpushedBanner(options.unpushed)}
      <div class="card"><ul>${rows}</ul></div>
    `,
  );
}

/**
 * The unpublished state the write path needs somewhere to show.
 *
 * A save is durable once committed, so this is not an error — but it does mean the change has
 * no off-host copy yet, and silently hiding that would make a GitHub outage invisible.
 */
function unpushedBanner(unpushed: readonly UnpushedCommit[]): SafeHtml {
  if (unpushed.length === 0) return html``;
  const rows = unpushed.map(
    (commit) => html`<li><code>${commit.sha.slice(0, 8)}</code> ${commit.subject}</li>`,
  );
  return html`<div class="card banner">
    <strong>${unpushed.length} change(s) not yet pushed to GitHub.</strong>
    <p class="sub">Saved and being served locally. Retrying in the background.</p>
    <ul>${rows}</ul>
  </div>`;
}

export function renderNamespace(options: {
  namespace: string;
  commit: string;
  rows: readonly KeyRow[];
  message?: string;
  formError?: string;
}): SafeHtml {
  const fields = options.rows.map((row) => renderField(row));

  return layout(
    options.namespace,
    html`
      <h1>${options.namespace}</h1>
      <p class="sub"><a href="/">All namespaces</a> · <code>${options.commit.slice(0, 8)}</code></p>
      ${options.formError ? html`<div class="card error">${options.formError}</div>` : html``}
      <form method="post" action="/ns/${options.namespace}">
        <input type="hidden" name="baseCommit" value="${options.commit}">
        <div class="card">${fields}</div>
        <div class="card">
          <div class="field">
            <label for="message">Audit message
              <span class="hint">Becomes the commit subject. Say why, not what.</span>
            </label>
            <input type="text" id="message" name="message" value="${options.message ?? ''}" required>
          </div>
          <button type="submit">Save</button>
        </div>
      </form>
    `,
  );
}

function renderField(row: KeyRow): SafeHtml {
  const name = `key.${row.key}`;
  const error = row.error ? html`<div class="err">${row.error}</div>` : html``;
  const hint = row.definition?.description ?? row.definition?.type ?? 'unknown key';

  // A secret is decrypted in this process, so it *could* be rendered — which is exactly why not
  // rendering it has to be a deliberate rule. A screenshot in a ticket or a browser cache would
  // otherwise leak it. The field sets a new value; it never shows the current one.
  if (row.definition?.secret) {
    return html`<div class="field">
      <label for="${name}">${row.key} <span class="hint">secret — hidden${row.value === undefined ? '' : ', currently set'}</span></label>
      <input type="text" id="${name}" name="${name}" value="" placeholder="leave blank to keep unchanged" autocomplete="off">
      ${error}
    </div>`;
  }

  if (row.definition?.type === 'enum') {
    const options = (row.definition.values ?? []).map(
      (value) =>
        html`<option value="${value}"${row.value === value ? ' selected' : ''}>${value}</option>`,
    );
    return html`<div class="field">
      <label for="${name}">${row.key} <span class="hint">${hint}</span></label>
      <select id="${name}" name="${name}"><option value=""></option>${options}</select>
      ${error}
    </div>`;
  }

  return html`<div class="field">
    <label for="${name}">${row.key} <span class="hint">${hint}</span></label>
    <input type="text" id="${name}" name="${name}" value="${row.value}">
    ${error}
  </div>`;
}

/**
 * The sign-in page.
 *
 * The break-glass form is rendered only while iam is unreachable. Showing it the rest of the
 * time would invite people to spend one-time codes against a form that always refuses, and
 * would advertise a second way in that is meant to be unremarkable.
 */
export function renderLogin(options: {
  iamReachable: boolean;
  iamConfigured?: boolean;
  iamLoginUrl: string;
  error?: string;
}): SafeHtml {
  const breakGlass = options.iamReachable
    ? html``
    : html`<div class="card">
        <div class="banner" style="border: 0; border-left: 3px solid #b45309; background: #fffbeb; margin: -1rem -1.25rem 1rem; padding: .75rem 1.25rem;">
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
        <p class="sub" style="margin: 0 0 1rem;">Sign in with iam to continue.</p>
        ${
          options.iamConfigured === false
            ? html`<span class="hint">iam sign-in is not configured on this instance.</span>`
            : html`<a href="${options.iamLoginUrl}">Sign in with iam</a>`
        }
      </div>`
    : html`<div class="card">
        <p class="sub" style="margin: 0;">iam is unreachable, so break-glass sign-in is available.</p>
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
