import type { UnpushedCommit } from '../git/repository.js';
import type { KeyDefinition } from '../schema/validator.js';
import { html, raw, type SafeHtml } from './html.js';

/**
 * Server-rendered pages. No client framework: the whole UI is a list, a form and a redirect,
 * and a build step would be more machinery than the thing it builds.
 */

export interface KeyRow {
  readonly key: string;
  readonly definition: KeyDefinition | null;
  readonly value: unknown;
  readonly error?: string | undefined;
  /** The published value, when this key has an unpublished edit. */
  readonly publishedValue?: unknown;
  readonly pending?: boolean;
  /** What every other environment holds for this key, for the hover peek. */
  readonly elsewhere?: ReadonlyArray<{
    readonly environment: string;
    readonly value: unknown;
    readonly published?: unknown;
    readonly pending?: boolean;
  }>;
}

/**
 * Wraps a page body in the document.
 *
 * htmx asks for the body alone, so every page is authored as a fragment and this is the only
 * thing that turns one into a document. One render path serves both; two would drift, and the
 * drift would show up only for whichever half nobody was looking at.
 */
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
  /* NOT overflow: hidden. That rounds the corners and also clips every hover panel a row
     contains, cutting the detail off at the card's edge. The corners are rounded on the first
     and last rows instead. */
  .rows { background: #fff; border: 1px solid #e2e5ea; border-radius: 8px; }
  .rows > *:first-child { border-top-left-radius: 8px; border-top-right-radius: 8px; }
  .rows > *:last-child { border-bottom-left-radius: 8px; border-bottom-right-radius: 8px; }
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
  /* Above the trigger, not below: opening downward covered the value field the panel is
     describing, which is the one thing you are looking at when you open it. */
  .detail { display: none; position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 5; width: 320px;
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
  /* The two actions belong to the sentence that states what is selected, so they are set as
     part of it rather than as a boxed control bar sitting above the fields. */
  .linkbtn { background: none; border: 0; padding: 0; font: inherit; color: #1d4ed8;
             text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .linkbtn:hover:not(:disabled) { color: #1e3fa8; }
  .linkbtn:disabled { color: #9aa0ad; text-decoration: none; cursor: not-allowed; }
  /* Publishing is the consequential one, and carries the same amber as everything else that
     means "unpublished" on these pages. */
  .linkbtn.go { color: #b45309; }
  .linkbtn.go:hover:not(:disabled) { color: #8a4108; }
  /* Quieter than the fields it sits above: it states what you have selected, it is not the
     thing you came to the page to read. */
  .actions, .actionline { font-size: .8125rem; }
  /* One line of .8125rem text, the card's padding and its bottom margin. */
  .actionslot { min-height: 3.35rem; }
  .actionslot .card { margin-bottom: 0; }
  .actionline { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .actionline .count { color: #b45309; }
  .actionline .idle { color: #5b6070; }
  .selection { display: inline-flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .actionline .sep { color: #cbd0d9; }
  /* The selection count is a hover trigger like the others, but it is ordinary running text
     rather than an amber "unpublished" marker — it states what you are about to do, not a
     warning about the environment. */
  .pending.sel { color: inherit; font-size: inherit; }
  input[type=number] { max-width: 12rem; font-variant-numeric: tabular-nums; }
  select { max-width: 20rem; }
  .chip-item { display: inline-flex; align-items: center; gap: 6px; font-size: .8125rem;
               padding: 2px 9px; border-radius: 4px; border: 1px solid #dbe1ea; background: #f6f7f9; }
  /* The switch reflects the checkbox, not a class the server rendered: with no script on the
     page, a server-rendered state cannot move when you click it — the box toggled and nothing
     appeared to happen. These sibling rules are what make it respond. */
  .switch { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; font-size: .875rem; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .track { width: 34px; height: 20px; border-radius: 10px; background: #cbd0d9; position: relative;
           flex-shrink: 0; transition: background .12s ease; }
  .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
          background: #fff; transition: transform .12s ease; }
  .switch input:checked ~ .track { background: #16181d; }
  .switch input:checked ~ .track .knob { transform: translateX(14px); }
  .switch input:focus-visible ~ .track { outline: 2px solid #1d4ed8; outline-offset: 2px; }
  /* The word beside it is generated too, for the same reason. */
  .switch .state::after { content: 'false'; }
  .switch input:checked ~ .state::after { content: 'true'; }
  /* Hover peek on a key name — same mechanics as the pending detail, no script. */
  .peek { position: relative; display: inline-flex; cursor: help; border-bottom: 1px dotted #cbd0d9; }
  .peek .detail { bottom: calc(100% + 6px); }
  .peek:hover .detail, .peek:focus-within .detail { display: block; }
  .detail .envname { color: #9aa0ad; font-size: .75rem; }
  .keyline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: .25rem; }
  .keyrow { display: flex; align-items: flex-start; gap: 14px; }
  .keypick { width: 16px; flex-shrink: 0; padding-top: 2px; }
  .keypick input { width: 16px; height: 16px; accent-color: #16181d; cursor: pointer; margin: 0; }
  /* A tick on a value you have actually changed cannot be cleared — the change goes with the
     draft either way. It must not look like an ordinary box that simply failed to respond. */
  .keypick input.locked { accent-color: #b45309; cursor: not-allowed; }
  .keypick input:disabled { accent-color: #cbd0d9; cursor: not-allowed; opacity: .55; }
</style>
</head>
<body>
<main id="page">${body}</main>
<!-- Served from this origin, never a CDN: an editor that cannot render because someone
     else's network is down is exactly backwards for a tool reached during an incident. -->
<script src="/assets/htmx.js" defer></script>
<script src="/assets/ticks.js" defer></script>
</body>
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

/**
 * The control comes from the declared type, so a schema change moves the UI with it and nobody
 * has to remember that SESSION_TTL wants a number box.
 */
function renderField(row: KeyRow): SafeHtml {
  const name = `key.${row.key}`;
  const error = row.error ? html`<div class="err">${row.error}</div>` : html``;
  const definition = row.definition;
  const hint = definition?.description ?? typeHint(definition);

  // Every key gets one, not only the changed ones. A tick is how you say what goes — to a
  // publish, and to the next environment — and you cannot say "send this one along" about a key
  // the form refuses to offer. Changed keys start ticked because that is almost always the
  // intent; the rest start clear.
  const pick = html`<span class="keypick">
    <input type="checkbox" name="select" value="${row.key}" data-select="${row.key}"${row.pending ? ' checked' : ''}
           ${row.pending && !definition?.secret ? html`data-published="${format(row.publishedValue)}"` : html``}
           ${definition?.secret ? html`data-secret="true"` : html``}
           title="Include when publishing or promoting">
  </span>`;

  const header = html`<div class="keyline">
    <label for="${name}" style="margin: 0;">${peek(row)}</label>
    <span class="hint">${hint}</span>
    ${
      row.pending
        ? html`<span style="display:inline-flex;align-items:center;gap:6px;font-size:.8125rem;">
            <span class="dot"></span>
            <span class="was">${format(row.publishedValue)}</span>
            <span class="arrow">→</span>
            <span>${format(row.value)}</span>
          </span>`
        : html``
    }
  </div>`;

  // A secret is decrypted in this process, so it *could* be rendered — which is exactly why not
  // rendering it has to be a deliberate rule. A screenshot in a ticket or a browser cache would
  // otherwise leak it. The field sets a new value; it never shows the current one.
  if (definition?.secret) {
    return html`<div class="field keyrow">${pick}<div style="flex-grow:1;min-width:0;">${header}
      <input type="password" id="${name}" name="${name}" value="" data-key="${row.key}"
             data-original="" placeholder="leave blank to keep the current value" autocomplete="off">
      ${error}
    </div></div>`;
  }

  if (definition?.type === 'enum') {
    const options = (definition.values ?? []).map(
      (value) =>
        html`<option value="${value}"${row.value === value ? ' selected' : ''}>${value}</option>`,
    );
    return html`<div class="field keyrow">${pick}<div style="flex-grow:1;min-width:0;">${header}
      <select id="${name}" name="${name}" data-key="${row.key}" data-original="${row.value}"><option value=""></option>${options}</select>
      ${error}
    </div></div>`;
  }

  if (definition?.type === 'int') {
    // The schema's own bounds, so the browser refuses what the validator would refuse anyway —
    // one round trip saved, and the constraint is visible in the control.
    return html`<div class="field keyrow">${pick}<div style="flex-grow:1;min-width:0;">${header}
      <input type="number" id="${name}" name="${name}" value="${row.value}" step="1"
             data-key="${row.key}" data-original="${row.value}" ${bounds(definition)}>
      ${error}
    </div></div>`;
  }

  if (definition?.type === 'bool') {
    const on = row.value === true || row.value === 'true';
    // A hidden false before the checkbox, so an unticked box means false rather than "delete the
    // override" — but ONLY where an override already exists. For a key with no value, `false`
    // would look like an edit, and merely opening the page would stage every unset boolean.
    // The cost is that adding a first `false` override needs the file; that is rarer than
    // opening a page.
    const explicitFalse =
      row.value === undefined ? html`` : html`<input type="hidden" name="${name}" value="false">`;
    return html`<div class="field keyrow">${pick}<div style="flex-grow:1;min-width:0;">${header}
      ${explicitFalse}
      <label class="switch">
        <input type="checkbox" id="${name}" name="${name}" value="true"${on ? ' checked' : ''}
               data-key="${row.key}" data-original="${on ? 'true' : 'false'}">
        <span class="track"><span class="knob"></span></span>
        <span class="state"></span>
      </label>
      ${error}
    </div></div>`;
  }

  if (definition?.type === 'string[]') {
    const items = Array.isArray(row.value) ? row.value : [];
    const chips = items.map((item) => html`<span class="chip-item">${item}</span>`);
    return html`<div class="field keyrow">${pick}<div style="flex-grow:1;min-width:0;">${header}
      ${items.length > 0 ? html`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:.4rem;">${chips}</div>` : html``}
      <input type="text" id="${name}" name="${name}" value="${items.join(', ')}"
             data-key="${row.key}" data-original="${items.join(', ')}" placeholder="comma separated">
      ${error}
    </div></div>`;
  }

  return html`<div class="field keyrow">${pick}<div style="flex-grow:1;min-width:0;">${header}
    <input type="${definition?.type === 'url' ? 'url' : 'text'}" id="${name}" name="${name}"
           value="${row.value}" data-key="${row.key}" data-original="${row.value}">
    ${error}
  </div></div>`;
}

/**
 * The number box's own limits, as markup.
 *
 * Built with `raw` because an attribute pair is markup, not a value: interpolated as a string it
 * would arrive escaped and the browser would ignore it — the field would look right and enforce
 * nothing.
 */
function bounds(definition: KeyDefinition): SafeHtml {
  const parts: string[] = [];
  if (definition.min !== undefined) parts.push(`min="${Number(definition.min)}"`);
  if (definition.max !== undefined) parts.push(`max="${Number(definition.max)}"`);
  return raw(parts.join(' '));
}

/** The hint under a key comes from its declared type, not prose written per key. */
function typeHint(definition: KeyDefinition | null): string {
  if (!definition) return 'not in the schema';
  if (definition.type === 'enum') return (definition.values ?? []).join(' | ');
  if (definition.type === 'int') {
    return `whole number${definition.min === undefined ? '' : `, ${definition.min}–${definition.max ?? ''}`}`;
  }
  if (definition.type === 'bool') return 'true or false';
  if (definition.type === 'string[]') return 'list of values';
  if (definition.secret) return 'secret — never displayed';
  return definition.type;
}

const format = (value: unknown): string =>
  value === undefined ? '(unset)' : Array.isArray(value) ? value.join(', ') : String(value);

/** The key name, with what other environments hold for it on hover. */
function peek(row: KeyRow): SafeHtml {
  const elsewhere = row.elsewhere ?? [];
  if (elsewhere.length === 0) return html`${row.key}`;

  const lines = elsewhere.map(
    (
      other,
    ) => html`<div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:.8125rem;margin-bottom:3px;">
      <span class="envname">${other.environment}</span>
      ${
        other.pending
          ? html`<span class="was">${format(other.published)}</span><span class="arrow">→</span>`
          : html``
      }
      <span style="color:#5b6070;">${format(other.value)}</span>
    </div>`,
  );

  return html`<span class="peek" tabindex="0">${row.key}
    <span class="detail"><h3>In other environments</h3>${lines}</span>
  </span>`;
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
  return html`<span class="pending" tabindex="0">
    <span class="dot"></span>${changes.length} unpublished
    ${detailPanel(title, changes)}
  </span>`;
}

/** One line per change: what it was, what it becomes — and for a secret, neither. */
function changeLines(changes: readonly PendingChange[]): SafeHtml[] {
  return changes.map((change) =>
    change.secret
      ? html`<div><strong>${change.key}</strong> <span class="hint">changed — value hidden</span></div>`
      : html`<div>
          <strong>${change.key}</strong>
          <span class="was">${change.from ?? '(unset)'}</span>
          <span class="hint">→</span>
          <span class="is">${change.to ?? '(removed)'}</span>
        </div>`,
  );
}

/**
 * Where you are, for a toolbar with nothing to do.
 *
 * Four facts, in the order they are usually wanted: the size of this environment, how far it
 * has drifted from the one it promotes into, the commit being served, and the audit trail's
 * most recent entry — which is the line immediately above the one a publish is about to write.
 */
function idleLine(options: {
  active: string;
  rows: readonly KeyRow[];
  commit: string;
  nextEnvironment?: string | null;
  lastChange?: { subject: string; author: string; at: string } | null;
}): SafeHtml {
  const parts: SafeHtml[] = [
    html`${options.rows.length} variable${options.rows.length === 1 ? '' : 's'} in ${options.active}`,
  ];

  if (options.nextEnvironment) {
    // Counted against what the next environment actually holds, including keys it has not got
    // at all — those are drift too, and the ones a promotion would create.
    const drift = options.rows.filter((row) => {
      const there = row.elsewhere?.find((env) => env.environment === options.nextEnvironment);
      return !there || format(there.value) !== format(row.value);
    }).length;
    parts.push(
      drift === 0
        ? html`identical to ${options.nextEnvironment}`
        : html`${drift} differ from ${options.nextEnvironment}`,
    );
  }

  parts.push(html`serving <code>${options.commit.slice(0, 8)}</code>`);

  if (options.lastChange) {
    parts.push(
      html`last published ${ago(options.lastChange.at)} by ${options.lastChange.author} — “${options.lastChange.subject}”`,
    );
  }

  return html`<span class="idle">${joinDots(parts)}</span>`;
}

/** Separators between the idle line's facts, rendered once rather than at every call site. */
function joinDots(parts: readonly SafeHtml[]): SafeHtml[] {
  return parts.flatMap((part, index) =>
    index === 0 ? [part] : [html`<span class="sep"> · </span>`, part],
  );
}

/**
 * Coarse relative time. Deliberately not a precise one: "2h ago" is what the reader wants, and
 * a formatted timestamp would be in the server's timezone rather than theirs.
 */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return 'at an unknown time';
  if (seconds < 90) return 'just now';
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

/** The panel alone, for a trigger that is not the standard "N unpublished" marker. */
function detailPanel(title: string, changes: readonly PendingChange[]): SafeHtml {
  return html`<span class="detail" data-detail><h3>${title}</h3>${changeLines(changes)}</span>`;
}

/** The landing page: products, not namespaces. */
export function renderProducts(options: {
  products: readonly ProductSummary[];
  commit: string;
  unpushed?: readonly UnpushedCommit[];
  notice?: string;
  error?: string;
  /** True when htmx asked: the body alone, to be swapped into the page. */
  fragment?: boolean;
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
          <a href="/p/${product.name}" hx-get="/p/${product.name}" hx-target="#page"
             hx-swap="innerHTML" hx-push-url="true"
             style="font-size:.9375rem;font-weight:500;">${product.name}</a>
          ${pending.length > 0 ? pendingDetail('Waiting to publish', pending) : html``}
        </div>
        <div class="hint">${product.keys}</div>
        <div style="display:flex;gap:6px;margin-top:2px;">${chips}</div>
      </div>
    </div>`;
  });

  const body = html`
      <form method="post" action="/publish" hx-post="/publish" hx-target="#page" hx-swap="innerHTML">
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
    `;

  return options.fragment ? body : layout('Products', body);
}

/** Inside a product: environments as tabs, each flagged when it holds unpublished changes. */
export interface PromoteOffer {
  readonly nextEnvironment: string;
  /** What was just published and can move, with the target's current value. */
  readonly movable: ReadonlyArray<{ key: string; value: unknown; target: unknown }>;
  /** Published, but not movable — a secret cannot cross environments. */
  readonly blocked: ReadonlyArray<{ key: string; reason: string }>;
}

export function renderProduct(options: {
  service: string;
  environments: readonly EnvironmentSummary[];
  active: string;
  rows: readonly KeyRow[];
  commit: string;
  /** The environment this one promotes into, for the drift count. */
  nextEnvironment?: string | null;
  /** The audit trail's most recent entry for this namespace. */
  lastChange?: { subject: string; author: string; at: string } | null;
  message?: string;
  notice?: string;
  error?: string;
  offer?: PromoteOffer;
  fragment?: boolean;
}): SafeHtml {
  const activeEnv = options.environments.find((env) => env.name === options.active);
  const productPending = options.environments.reduce((n, env) => n + env.pending.length, 0);

  const tabs = options.environments.map(
    (env) => html`<a class="tab ${env.name === options.active ? 'on' : ''}"
                     href="/p/${options.service}?env=${env.name}"
                     hx-get="/p/${options.service}?env=${env.name}" hx-target="#page"
                     hx-swap="innerHTML" hx-push-url="true">${env.name}${
                       env.pending.length > 0
                         ? html` <span class="dot" title="unpublished changes"></span>`
                         : html``
}</a>`,
  );

  const fields = options.rows.map((row) => renderField(row));
  // The buttons follow the TICKS, not what happens to be staged: a tick is the statement of
  // intent, and the script keeps the count in step as values change.
  const ticked = options.rows.filter((row) => row.pending).length;
  // Something is written down, as opposed to merely typed into the page.
  const hasDraft = (activeEnv?.pending.length ?? 0) > 0;
  // Nothing ticked and nothing written down: the toolbar has nothing to act on, so it says
  // where you are instead.
  const idle = ticked === 0 && !hasDraft;

  const body = html`


      <div class="toolbar" style="margin-bottom:1.25rem;">
        <div>
          <div style="font-size:.8125rem;margin-bottom:.35rem;">
            <a href="/" hx-get="/" hx-target="#page" hx-swap="innerHTML" hx-push-url="true">All products</a>
          </div>
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
      ${promoteOffer(options)}
      ${options.notice ? html`<div class="card">${options.notice}</div>` : html``}
      ${options.error ? html`<div class="card error">${options.error}</div>` : html``}

      <!-- One form, opened here so the actions can sit under the tabs while the ticks and
           fields below them are still what a submit carries. A button outside the form would
           send neither. -->
      <form method="post" action="/p/${options.service}/${options.active}"
            hx-post="/p/${options.service}/${options.active}" hx-target="#page" hx-swap="innerHTML"
            data-keys>
        <!-- The slot holds the toolbar's height whether or not the toolbar is in it. Showing
             it on the first tick would otherwise push every field down the page, under a
             cursor that is aimed at one of them. -->
        <div class="actionslot">
        <div class="card actions" style="padding:.7rem 1.25rem;" data-actions${
          hasDraft ? html` data-has-draft` : html``
        }>
          <div class="actionline">
            ${
              // The slot's height is reserved either way, so an idle toolbar is space already
              // paid for. It says where you are: what this environment holds, how far it has
              // drifted from the one it promotes into, what is being served, and the audit
              // entry immediately above the one you are about to write. The script swaps it for
              // the selection the moment there is one.
              idle ? idleLine(options) : html``
            }
            <span class="selection" data-selection ${idle ? 'hidden' : ''}>
              <!-- The count says how many; hovering it says which. The script rebuilds the panel
                   as ticks move, because before a draft is saved the server has never seen the
                   edits the panel is describing. -->
              <span class="pending sel" tabindex="0">
                <span class="count" data-label="{n} of {t} unpublished changes."
                  >${ticked} of ${options.rows.length} unpublished changes.</span>
                ${detailPanel('Selected', activeEnv?.pending ?? [])}
              </span>
              <button type="submit" name="intent" value="save" class="linkbtn"
                      data-needs-ticks data-label="Draft {n} change{s}?"
                      ${ticked === 0 ? 'disabled' : ''}>Draft ${ticked} change${ticked === 1 ? '' : 's'}?</button>
              ${
                // Publishing appears only once something is actually saved. Not disabled —
                // absent: you cannot publish what has not been written down, and a permanently
                // greyed action invites clicking at it to find out why.
                hasDraft
                  ? html`<span class="sep">·</span>
                      <button type="submit" name="intent" value="publish" class="linkbtn go"
                              data-needs-ticks data-label="Publish {n} in ${options.active}?"
                              ${ticked === 0 ? 'disabled' : ''}>Publish ${ticked} in ${options.active}?</button>`
                  : html``
              }
            </span>
          </div>
          ${
            // The message comes with the publish action, and takes focus when it arrives: it is
            // the only thing left to supply, and it is required.
            hasDraft
              ? html`<div class="field" style="margin:.7rem 0 0;">
                  <label for="message">Publish message
                    <span class="hint">becomes the commit subject; the ticks choose what goes</span>
                  </label>
                  <input type="text" id="message" name="message" value="${options.message ?? ''}" autofocus>
                </div>`
              : html``
          }
        </div>
        </div>

        <div class="card" style="padding:.5rem 1.25rem 1rem;">${fields}</div>
      </form>
    `;
  return options.fragment ? body : layout(options.service, body);
}

/**
 * The offer to move what was just published into the next environment.
 *
 * It appears only after a publish and names exactly those keys — so the two environments stay
 * separate by default, and nothing moves that the operator did not just deliberately ship.
 */
function promoteOffer(options: {
  service: string;
  active: string;
  offer?: PromoteOffer;
}): SafeHtml {
  const offer = options.offer;
  if (!offer) return html``;

  const rows = offer.movable.map(
    (
      change,
    ) => html`<div style="font-size:.8125rem;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
      <strong style="font-size:.875rem;">${change.key}</strong>
      <span class="hint">${offer.nextEnvironment} has</span>
      <span class="was">${format(change.target)}</span>
      <span class="arrow">→</span>
      <span>${format(change.value)}</span>
    </div>`,
  );

  const blocked = offer.blocked.map(
    (entry) => html`<div style="font-size:.8125rem;color:#5b6070;">
      <strong style="font-size:.875rem;color:#16181d;">${entry.key}</strong> — ${entry.reason}
    </div>`,
  );

  const hidden = offer.movable.map(
    (change) => html`<input type="hidden" name="key" value="${change.key}">`,
  );

  return html`<div class="card" style="border-left: 3px solid #1d4ed8;">
    <div style="font-weight:600;">Published in ${options.active}.</div>
    <p class="sub" style="margin:3px 0 .85rem;">
      Move the same change to ${offer.nextEnvironment}? It is staged there for review — nothing
      is published in ${offer.nextEnvironment}.
    </p>
    <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:1rem;">${rows}${blocked}</div>
    <form method="post" action="/promote" hx-post="/promote" hx-target="#page" hx-swap="innerHTML"
          style="display:flex;align-items:center;gap:12px;">
      <input type="hidden" name="service" value="${options.service}">
      <input type="hidden" name="from" value="${options.active}">
      <input type="hidden" name="to" value="${offer.nextEnvironment}">
      ${hidden}
      <button type="submit" ${offer.movable.length === 0 ? 'disabled' : ''}>
        Stage in ${offer.nextEnvironment}
      </button>
      <a href="/p/${options.service}?env=${options.active}">Not now</a>
    </form>
  </div>`;
}
