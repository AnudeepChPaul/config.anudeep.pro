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
  .rows { background: #fff; border: 1px solid #e2e5ea; border-radius: 8px; overflow: hidden; }
  .row { display: flex; align-items: flex-start; gap: 14px; padding: 14px 18px; }
  .row + .row { border-top: 1px solid #eef0f3; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid #e2e5ea; margin-bottom: 1.5rem; }
  .tab { display: flex; align-items: center; gap: 7px; padding: 8px 14px; font-size: .875rem;
         border-bottom: 2px solid transparent; color: #5b6070; text-decoration: none; }
  .tab.on { border-bottom-color: #16181d; color: #16181d; font-weight: 600; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #b45309; display: inline-block; }
  .chip { font-size: .6875rem; padding: 1px 7px; border-radius: 4px; border: 1px solid #e2e5ea;
          background: #f6f7f9; color: #5b6070; }
  .chip.wait { border-color: #f2d9a8; background: #fffbeb; color: #b45309; }
  /* Hover detail. No script: :hover and :focus-within are enough, and a keyboard reaches it. */
  .pending { position: relative; display: inline-flex; align-items: center; gap: 5px;
             font-size: .75rem; color: #b45309; cursor: help; }
  .detail { display: none; position: absolute; top: 20px; left: 0; z-index: 5; width: 320px;
            background: #fff; border: 1px solid #e2e5ea; border-radius: 6px; padding: 10px 12px;
            box-shadow: 0 4px 14px rgba(22,24,29,.10); color: #16181d; font-weight: 400;
            cursor: default; }
  .pending:hover .detail, .pending:focus-within .detail { display: block; }
  .detail h3 { font-size: .6875rem; text-transform: uppercase; letter-spacing: .02em;
               color: #5b6070; margin: 0 0 .5rem; }
  .detail .was { color: #9aa0ad; text-decoration: line-through; }
  .detail .is { color: #16181d; }
  .toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
  .ghost { background: #fff; color: #16181d; border: 1px solid #cbd0d9; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

/**
 * Published here but not yet on GitHub — a different state from "waiting to publish", and
 * worth its own line: one means an operator has not decided, the other means GitHub is
 * unreachable and the change has no off-host copy yet.
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

export interface PendingChange {
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly secret: boolean;
}

export interface EnvironmentSummary {
  readonly name: string;
  readonly namespace: string;
  readonly pending: readonly PendingChange[];
}

export interface ProductSummary {
  readonly name: string;
  readonly keys: string;
  readonly environments: readonly EnvironmentSummary[];
}

/**
 * What a pending change shows on hover.
 *
 * A secret shows that it changed and nothing more. Old and new are already absent from the
 * draft, so this cannot print them even by mistake — but it says so explicitly rather than
 * rendering two blanks, which would read as a bug.
 */
function pendingDetail(title: string, changes: readonly PendingChange[]): SafeHtml {
  const rows = changes.map((change) =>
    change.secret
      ? html`<div><strong>${change.key}</strong> <span class="hint">changed — value hidden</span></div>`
      : html`<div>
          <strong>${change.key}</strong>
          <span class="was">${change.from ?? '(unset)'}</span>
          <span class="hint">→</span>
          <span class="is">${change.to ?? '(removed)'}</span>
        </div>`,
  );

  return html`<span class="pending" tabindex="0">
    <span class="dot"></span>${changes.length} unpublished
    <span class="detail"><h3>${title}</h3>${rows}</span>
  </span>`;
}

/** The landing page: products, not namespaces. */
export function renderProducts(options: {
  products: readonly ProductSummary[];
  commit: string;
  unpushed?: readonly UnpushedCommit[];
  notice?: string;
  error?: string;
}): SafeHtml {
  const totalPending = options.products.reduce(
    (total, product) => total + product.environments.reduce((n, env) => n + env.pending.length, 0),
    0,
  );

  const rows = options.products.map((product) => {
    const pending = product.environments.flatMap((env) =>
      env.pending.map((change) => ({ ...change, key: `${env.name} · ${change.key}` })),
    );
    const chips = product.environments.map(
      (env) => html`<span class="chip ${env.pending.length > 0 ? 'wait' : ''}">${env.name}</span>`,
    );

    return html`<div class="row">
      <input type="checkbox" name="namespace" value="${product.name}"
             style="width:16px;height:16px;margin:3px 0 0;accent-color:#16181d;">
      <div style="display:flex;flex-direction:column;gap:4px;flex-grow:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:10px;">
          <a href="/p/${product.name}" style="font-size:.9375rem;font-weight:500;">${product.name}</a>
          ${pending.length > 0 ? pendingDetail('Waiting to publish', pending) : html``}
        </div>
        <div class="hint">${product.keys}</div>
        <div style="display:flex;gap:6px;margin-top:2px;">${chips}</div>
      </div>
    </div>`;
  });

  return layout(
    'Products',
    html`
      <form method="post" action="/publish">
        <div class="toolbar" style="margin-bottom:1.75rem;">
          <div>
            <h1>Products</h1>
            <p class="sub" style="margin:0;">
              Serving <code>${options.commit.slice(0, 8)}</code>${
                totalPending > 0
                  ? html` · ${totalPending} change(s) waiting to publish`
                  : html` · nothing waiting to publish`
              }
            </p>
          </div>
          <button type="submit">Publish selected</button>
        </div>
        ${options.notice ? html`<div class="card">${options.notice}</div>` : html``}
        ${options.error ? html`<div class="card error">${options.error}</div>` : html``}
        ${unpushedBanner(options.unpushed ?? [])}
        <div class="card" style="padding:.85rem 1.25rem;">
          <label for="message">Publish message <span class="hint">becomes the commit subject</span></label>
          <input type="text" id="message" name="message" value="">
        </div>
        <div class="rows">${rows}</div>
      </form>
    `,
  );
}

/** Inside a product: environments as tabs, each flagged when it holds unpublished changes. */
export function renderProduct(options: {
  service: string;
  environments: readonly EnvironmentSummary[];
  active: string;
  rows: readonly KeyRow[];
  commit: string;
  message?: string;
  notice?: string;
  error?: string;
}): SafeHtml {
  const activeEnv = options.environments.find((env) => env.name === options.active);
  const productPending = options.environments.reduce((n, env) => n + env.pending.length, 0);

  const tabs = options.environments.map(
    (env) => html`<a class="tab ${env.name === options.active ? 'on' : ''}"
                     href="/p/${options.service}?env=${env.name}">${env.name}${
                       env.pending.length > 0
                         ? html` <span class="dot" title="unpublished changes"></span>`
                         : html``
}</a>`,
  );

  const fields = options.rows.map((row) => renderField(row));

  return layout(
    options.service,
    html`
      <div class="toolbar" style="margin-bottom:1.25rem;">
        <div>
          <div style="font-size:.8125rem;margin-bottom:.35rem;"><a href="/">All products</a></div>
          <h1>${options.service}</h1>
        </div>
        <form method="post" action="/publish" style="display:flex;gap:8px;align-items:flex-start;">
          ${options.environments.map(
            (env) =>
              html`<input type="hidden" name="namespace" value="${options.service}/${env.name}">`,
          )}
          <input type="hidden" name="message" value="Publish all ${options.service} changes">
          <button type="submit" class="ghost" ${productPending === 0 ? 'disabled' : ''}>
            ${productPending === 0 ? 'Nothing to publish' : `Publish all ${options.service} (${productPending})`}
          </button>
        </form>
      </div>

      <div class="tabs">${tabs}</div>
      ${options.notice ? html`<div class="card">${options.notice}</div>` : html``}
      ${options.error ? html`<div class="card error">${options.error}</div>` : html``}

      <div class="toolbar" style="align-items:center;margin-bottom:.85rem;">
        <div class="hint">
          ${
            activeEnv && activeEnv.pending.length > 0
              ? pendingDetail(`Waiting in ${options.active}`, activeEnv.pending)
              : html`Everything in ${options.active} is published.`
          }
        </div>
        <form method="post" action="/publish" style="display:flex;gap:8px;">
          <input type="hidden" name="namespace" value="${options.service}/${options.active}">
          <input type="hidden" name="message" value="Publish ${options.service}/${options.active}">
          <button type="submit" ${!activeEnv || activeEnv.pending.length === 0 ? 'disabled' : ''}>
            Publish ${options.active}
          </button>
        </form>
      </div>

      <form method="post" action="/p/${options.service}/${options.active}">
        <div class="card" style="padding:.5rem 1.25rem 1rem;">${fields}</div>
        <button type="submit">Save as draft</button>
      </form>
    `,
  );
}
