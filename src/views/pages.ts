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
  /* One size for every button in the console. This lived under .actionline, which set the
     toolbar's actions at one size and left every button outside it — Sign in, the product
     list's actions — at another, beside text of the same size. */
  button { background: #16181d; color: #fff; border: 0; border-radius: 5px; padding: .55rem 1.1rem;
           font: inherit; font-size: .8125rem; cursor: pointer; }
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
  /* Deliberately no font shorthand here: it resets font-size to the inherited value, which
     overrode the size the base button rule sets — so a link action was one size inside .actions
     and another in the drafts list, the promote card and the product list. Family and weight
     inherit on their own; the size stays the base rule's, which is the toolbar's. */
  .linkbtn { background: none; border: 0; padding: 0; color: #1d4ed8;
             text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .linkbtn:hover:not(:disabled) { color: #1e3fa8; }
  .linkbtn:disabled { color: #9aa0ad; text-decoration: none; cursor: not-allowed; }
  /* Publishing is the consequential one, and carries the same amber as everything else that
     means "unpublished" on these pages. */
  .linkbtn.go { color: #b45309; }
  .linkbtn.go:hover:not(:disabled) { color: #8a4108; }
  /* Quieter than the fields it sits above: it states what you have selected, it is not the
     thing you came to the page to read. */
  /* The bar's text matches its actions, which are sized with every other button above. A
     link-styled action a step larger than the sentence it belongs to reads as a button
     pretending to be a word. */
  .actions { font-size: .8125rem; }
  .actionline input, .actionline code { font-size: inherit; }
  /* One line of .8125rem text, the card's padding and its bottom margin. */
  .actionslot { min-height: 3.35rem; }
  .actionslot .card { margin-bottom: 0; }
  .actionline { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .actionline .count { color: #b45309; }
  .actionline .idle { color: #5b6070; }
  /* A write in flight. htmx sets .htmx-request on the element that issued the request and
     removes it when the request ends — including when it ends by replacing that element — so
     the running state cannot outlive its request the way a script-driven one can. */
  .running { display: none; align-items: center; gap: 6px; }
  .htmx-request .resting { display: none; }
  .htmx-request .running { display: inline-flex; }
  .htmx-request { cursor: progress; }
  .spinner { width: 11px; height: 11px; border: 2px solid currentColor; border-right-color: transparent;
             border-radius: 50%; display: inline-block; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* A publish is the slow one, and it is the only action whose duration is not ours to bound:
     it runs sops, git commit and git push over SSH. */
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .selection { display: inline-flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  /* The hidden attribute is only a UA "display: none", so any author display rule — the one
     on .selection, for instance — beats it and leaves a hidden element on screen. Everything
     the script hides is display-typed, which makes this the mechanism, not a nicety. */
  [hidden] { display: none !important; }
  /* #cbd0d9 on white is under 2:1 — the dots were invisible and the facts ran together. */
  .sep { color: #8a90a0; }
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
  /* Where a search result landed. A rule beside it, in the amber this console uses for
     "look here", rather than a scroll the reader did not ask for. */
  .found { border-left: 3px solid #b45309; margin-left: -1.25rem; padding-left: calc(1.25rem - 3px); }
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
function renderField(row: KeyRow, highlight?: string): SafeHtml {
  const name = `key.${row.key}`;
  // The key a search result arrived for. A marker rather than a scroll: the page is short, and
  // an unknown key marks nothing rather than erroring.
  const found = highlight === row.key ? ' found' : '';
  const error = row.error ? html`<div class="err">${row.error}</div>` : html``;
  const definition = row.definition;
  const hint = definition?.description ?? typeHint(definition);

  // Every key gets one, not only the changed ones: a tick is how you say "send this one along",
  // and you cannot say it about a key the form refuses to offer.
  //
  // None start ticked. A tick is a selection an action consumes — the save takes it, and after
  // that it has been acted on; leaving it set reads as a selection still waiting for something.
  // Publishing does not use it at all, since a draft publishes whole.
  const pick = html`<span class="keypick">
    <input type="checkbox" name="select" value="${row.key}" data-select="${row.key}"
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
    return html`<div class="field keyrow${found}">${pick}<div style="flex-grow:1;min-width:0;">${header}
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
    return html`<div class="field keyrow${found}">${pick}<div style="flex-grow:1;min-width:0;">${header}
      <select id="${name}" name="${name}" data-key="${row.key}" data-original="${row.value}"><option value=""></option>${options}</select>
      ${error}
    </div></div>`;
  }

  if (definition?.type === 'int') {
    // The schema's own bounds, so the browser refuses what the validator would refuse anyway —
    // one round trip saved, and the constraint is visible in the control.
    return html`<div class="field keyrow${found}">${pick}<div style="flex-grow:1;min-width:0;">${header}
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
    return html`<div class="field keyrow${found}">${pick}<div style="flex-grow:1;min-width:0;">${header}
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
    return html`<div class="field keyrow${found}">${pick}<div style="flex-grow:1;min-width:0;">${header}
      ${items.length > 0 ? html`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:.4rem;">${chips}</div>` : html``}
      <input type="text" id="${name}" name="${name}" value="${items.join(', ')}"
             data-key="${row.key}" data-original="${items.join(', ')}" placeholder="comma separated">
      ${error}
    </div></div>`;
  }

  return html`<div class="field keyrow${found}">${pick}<div style="flex-grow:1;min-width:0;">${header}
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
  /** How many presses of Save are waiting here. One draft is one save, not one key. */
  readonly drafts?: number;
  readonly name: string;
  readonly namespace: string;
  readonly pending: readonly PendingChange[];
}

export interface ProductSummary {
  /** The keys a search matched, replacing the usual summary when one is running. */
  readonly matched?: readonly string[];
  /** No schema file for this service: it cannot be edited, so the list says so and stops here. */
  readonly schemaMissing?: boolean;
  /** What the reader sees: "iam (1002)". The uid decides which process may read this product. */
  readonly name: string;
  /** What the links and the form use. The label carries the uid; the address must not. */
  readonly service: string;
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
  repoWebUrl?: string | null;
  revision?: number;
  lastChange?: { subject: string; author: string; at: string } | null;
}): SafeHtml {
  const parts: SafeHtml[] = [
    html`${options.rows.length} variable${options.rows.length === 1 ? '' : 's'} in ${options.active}`,
  ];

  // Absent on a file that has never been written through the console, where saying "revision 0"
  // would imply a counter that is running when none is.
  if (options.revision) parts.push(html`revision ${options.revision}`);

  parts.push(
    options.repoWebUrl
      ? html`serving <a href="${options.repoWebUrl}/commit/${options.commit}" target="_blank"
              rel="noreferrer"><code>${options.commit.slice(0, 8)}</code></a>`
      : html`serving <code>${options.commit.slice(0, 8)}</code>`,
  );

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
function ago(when: string | number): string {
  const at = typeof when === 'number' ? when : Date.parse(when);
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (!Number.isFinite(seconds)) return 'at an unknown time';
  if (seconds < 90) return 'just now';
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

/**
 * A button that performs a write, with what it says at rest and what it says while running.
 *
 * The two labels are siblings rather than one label the script rewrites: htmx swaps which is
 * visible by class alone, so the running state needs no script and cannot be left behind — the
 * element carrying it is destroyed by the swap that ends the request.
 */
function writeAction(options: {
  resting: SafeHtml;
  running: string;
  className?: string;
  attributes?: SafeHtml;
}): SafeHtml {
  return html`<button type="submit" class="${options.className ?? 'linkbtn'}" ${options.attributes ?? html``}>
    <span class="resting">${options.resting}</span>
    <span class="running"><span class="spinner"></span>${options.running}</span>
  </button>`;
}

/**
 * The search box.
 *
 * A plain GET form: it works with the script disabled, the address bar carries the search, and a
 * result can be linked to. `hx-get` makes it a swap when the script is there.
 */
function searchBox(options: { action: string; query: string; placeholder: string }): SafeHtml {
  return html`<form method="get" action="${options.action}" hx-get="${options.action}"
        hx-target="#page" hx-swap="innerHTML" hx-push-url="true"
        style="display:flex;gap:8px;align-items:center;margin:0 0 1.25rem;">
    <input type="search" name="q" value="${options.query}" placeholder="${options.placeholder}"
           style="max-width:22rem;" aria-label="${options.placeholder}">
    ${writeAction({ resting: html`Search`, running: 'Searching…' })}
    ${
      options.query
        ? html`<a class="hint" href="${options.action}" hx-get="${options.action}"
              hx-target="#page" hx-swap="innerHTML" hx-push-url="true">Clear</a>`
        : html``
    }
  </form>`;
}

/** The panel alone, for a trigger that is not the standard "N unpublished" marker. */
function detailPanel(title: string, changes: readonly PendingChange[]): SafeHtml {
  return html`<span class="detail" data-detail><h3>${title}</h3>${changeLines(changes)}</span>`;
}

export interface DraftListEntry {
  readonly namespace: string;
  readonly saves: ReadonlyArray<{
    readonly keys: readonly string[];
    readonly actor: string;
    readonly at: number;
  }>;
}

/**
 * Everything unpublished, in one place.
 *
 * A draft in an environment nobody has open is otherwise invisible: a number on the product
 * list and no way to see what it holds, or to undo it short of publishing it and reverting the
 * commit.
 */
export function renderDrafts(options: {
  drafts: readonly DraftListEntry[];
  notice?: string;
  fragment?: boolean;
}): SafeHtml {
  const rows = options.drafts.map(
    (entry) => html`<div class="row" style="flex-direction:column;align-items:stretch;gap:8px;">
      <div class="keyline">
        <strong>${entry.namespace}</strong>
        <span class="hint">${entry.saves.length} draft${entry.saves.length === 1 ? '' : 's'}</span>
        <a class="hint" style="margin-left:auto;"
           href="/p/${entry.namespace.split('/')[0]}?env=${entry.namespace.split('/')[1]}"
           hx-get="/p/${entry.namespace.split('/')[0]}?env=${entry.namespace.split('/')[1]}"
           hx-target="#page" hx-swap="innerHTML" hx-push-url="true">Open the environment</a>
      </div>
      ${entry.saves.map(
        (save, index) => html`<div class="keyrow" style="align-items:center;gap:10px;">
          <span class="hint" style="width:2.5rem;">#${index + 1}</span>
          <span style="flex-grow:1;">${save.keys.join(', ')}</span>
          <span class="hint">${ago(save.at)} · ${save.actor}</span>
          <form method="post" action="/drafts/drop" hx-post="/drafts/drop" hx-target="#page"
                hx-swap="innerHTML"
                hx-confirm="Drop draft #${index + 1} of ${entry.namespace}? A draft is not in git, so this cannot be undone.">
            <input type="hidden" name="namespace" value="${entry.namespace}">
            <input type="hidden" name="index" value="${index}">
            ${writeAction({ resting: html`Drop`, running: 'Dropping…' })}
          </form>
        </div>`,
      )}
    </div>`,
  );

  const body = html`
      <div class="toolbar" style="margin-bottom:1.25rem;">
        <div>
          <div style="font-size:.8125rem;margin-bottom:.35rem;">
            <a href="/" hx-get="/" hx-target="#page" hx-swap="innerHTML" hx-push-url="true">All products</a>
          </div>
          <h1>Unpublished drafts</h1>
        </div>
      </div>
      ${options.notice ? html`<div class="card" data-transient>${options.notice}</div>` : html``}
      ${
        options.drafts.length === 0
          ? html`<div class="card">Nothing is drafted anywhere. Every environment is published.</div>`
          : html`<div class="rows">${rows}</div>`
      }
    `;

  return options.fragment ? body : layout('Unpublished drafts', body);
}

/** The landing page: products, not namespaces. */
export function renderProducts(options: {
  products: readonly ProductSummary[];
  commit: string;
  unpushed?: readonly UnpushedCommit[];
  /** What was searched for, if anything. Matching is on key names only. */
  query?: string;
  /** How many presses of Save are waiting across every product, for the link to the draft list. */
  draftCount?: number;
  notice?: string;
  error?: string;
  /** True when htmx asked: the body alone, to be swapped into the page. */
  fragment?: boolean;
}): SafeHtml {
  // Counted in drafts — presses of Save — like every other number the console reports.
  const totalDrafts = options.products.reduce(
    (total, product) => total + product.environments.reduce((n, env) => n + (env.drafts ?? 0), 0),
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
      <input type="checkbox" name="namespace" value="${product.service}"
             style="width:16px;height:16px;margin:3px 0 0;accent-color:#16181d;">
      <div style="display:flex;flex-direction:column;gap:4px;flex-grow:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:10px;">
          ${
            product.schemaMissing
              ? html`<span style="font-size:.9375rem;font-weight:500;">${product.name}</span>
                  <span class="chip wait" title="schema/${product.service}.yaml is absent"
                    >schema is missing</span>`
              : html`<a href="/p/${product.service}" hx-get="/p/${product.service}" hx-target="#page"
                  hx-swap="innerHTML" hx-push-url="true"
                  style="font-size:.9375rem;font-weight:500;">${product.name}</a>`
          }
          ${pending.length > 0 ? pendingDetail('Waiting to publish', pending) : html``}
        </div>
        <div class="hint">${
          product.matched && product.matched.length > 0
            ? html`${product.matched.map((key) => {
                // The first environment this service declares — which is where the page lands
                // anyway. `dev` was hard-coded here from before tabs came from environments.yaml,
                // so the link named an environment a service need not have.
                const landing = product.environments[0]?.name ?? '';
                return html`<a href="/p/${product.service}?env=${landing}&hl=${key}"
                    hx-get="/p/${product.service}?env=${landing}&hl=${key}" hx-target="#page"
                    hx-swap="innerHTML" hx-push-url="true">${key}</a> `;
              })}`
            : html`${product.keys}`
        }</div>
        <div style="display:flex;gap:6px;margin-top:2px;">${chips}</div>
      </div>
    </div>`;
  });

  const body = html`
      <!-- The search form is opened and closed BEFORE the publish form. A form inside another
           form is dropped by every parser, which left its input and its button belonging to the
           publish form — so pressing Search published whatever was ticked. -->
      ${searchBox({ action: '/', query: options.query ?? '', placeholder: 'Find a variable' })}
      ${
        options.query && options.products.length === 0
          ? html`<div class="card">No key matches “${options.query}”.</div>`
          : html``
      }
      <form method="post" action="/publish" hx-post="/publish" hx-target="#page" hx-swap="innerHTML">
        <div class="toolbar" style="margin-bottom:1.75rem;">
          <div>
            <h1>Products</h1>
            <p class="sub" style="margin:0;">
              ${
                (options.draftCount ?? 0) > 0
                  ? html`<a href="/drafts" hx-get="/drafts" hx-target="#page" hx-swap="innerHTML"
                        hx-push-url="true">${options.draftCount} unpublished draft${
                          options.draftCount === 1 ? '' : 's'
                        }</a> · `
                  : html``
              }Serving <code>${options.commit.slice(0, 8)}</code>${
                totalDrafts > 0
                  ? html` · ${totalDrafts} draft${totalDrafts === 1 ? '' : 's'} to publish`
                  : html` · nothing unpublished`
              }
            </p>
          </div>
          ${
            // Absent when there is nothing waiting anywhere, like every other publish here: a
            // permanently greyed action invites clicking at it to find out why.
            totalDrafts > 0
              ? writeAction({
                  className: 'linkbtn go',
                  resting: html`Publish selected drafts?`,
                  running: 'Publishing…',
                })
              : html``
          }
        </div>
        ${options.notice ? html`<div class="card">${options.notice}</div>` : html``}
        ${options.error ? html`<div class="card error">${options.error}</div>` : html``}
        ${unpushedBanner(options.unpushed ?? [])}
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
  /** Where this repository lives in a browser, for linking the commit being served. */
  repoWebUrl?: string | null;
  /** True when the notice is a confirmation the page clears itself after a few seconds. */
  transientNotice?: boolean;
  /** What was searched for inside this product, if anything. */
  query?: string;
  /** The key a search result linked to, marked so the eye lands on it. */
  highlight?: string;
  /** True when this environment is declared but has no file yet: nothing is editable until it
   *  exists, and the page offers to create it from the schema's defaults. */
  missingFile?: boolean;
  /** True once the offer has been declined for this view; the action stays, the prompt goes. */
  offerDeclined?: boolean;
  /** Keys the draft already holds, so the page can tell a fresh tick from a saved one. */
  drafted?: readonly string[];
  /** The document's revision counter, 0 for a file that has never carried one. */
  revision?: number;
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
  const productDrafts = options.environments.reduce((n, env) => n + (env.drafts ?? 0), 0);

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

  const query = (options.query ?? '').trim().toLowerCase();
  const shownRows = query
    ? options.rows.filter((row) => row.key.toLowerCase().includes(query))
    : options.rows;
  const fields = shownRows.map((row) => renderField(row, options.highlight));
  // The buttons follow the TICKS, not what happens to be staged: a tick is the statement of
  // intent, and the script keeps the count in step as values change.
  const ticked = options.rows.filter((row) => row.pending).length;
  // Something is written down, as opposed to merely typed into the page.
  const hasDraft = (activeEnv?.pending.length ?? 0) > 0;
  // Nothing ticked and nothing written down: the toolbar has nothing to act on, so it says
  // where you are instead.
  const idle = ticked === 0 && !hasDraft;
  // Everything ticked is already in the draft, so there is nothing left to write down. Pressing
  // Draft again would rewrite the same document and count a revision for it.
  const drafted = options.drafted ?? [];
  // One press of Save is one draft, so this is a count of saves and not of keys.
  const drafts = activeEnv?.drafts ?? 0;
  const tickedKeys = options.rows.filter((row) => row.pending).map((row) => row.key);
  // Unticking a drafted key narrows what a publish would ship; it does not create something new
  // to write down. So the action is about what is ticked and NOT yet drafted.
  // Nothing on the page that the draft does not already hold. Ticks are cleared by a save, so a
  // freshly loaded drafted page has none — which is exactly the state where publishing is the
  // only thing left to offer.
  const nothingToDraft = hasDraft && tickedKeys.every((key) => drafted.includes(key));

  const body = html`


      <div class="toolbar" style="margin-bottom:1.25rem;">
        <div>
          <div style="font-size:.8125rem;margin-bottom:.35rem;">
            <a href="/" hx-get="/" hx-target="#page" hx-swap="innerHTML" hx-push-url="true">All products</a>
          </div>
          <h1>${options.service}</h1>
        </div>
        ${
          productDrafts === 0
            ? html``
            : html`<form method="post" action="/publish"
                    style="display:flex;gap:8px;align-items:flex-start;font-size:.8125rem;">
                ${options.environments.map(
                  (env) =>
                    html`<input type="hidden" name="namespace" value="${options.service}/${env.name}">`,
                )}
                <input type="hidden" name="message" value="Publish all ${options.service} changes">
                ${writeAction({
                  className: 'linkbtn go',
                  resting: html`Publish all ${productDrafts} draft${
                    productDrafts === 1 ? '' : 's'
                  } in ${options.service}?`,
                  running: 'Publishing…',
                })}
              </form>`
        }
      </div>

      <div class="tabs">${tabs}</div>
      ${searchBox({
        action: `/p/${options.service}`,
        query: options.query ?? '',
        placeholder: `Find a variable in ${options.service}`,
      })}
      ${
        query && shownRows.length === 0
          ? html`<div class="card">No key in ${options.service} matches “${options.query}”.</div>`
          : html``
      }
      ${promoteOffer(options)}
      ${
        // Marked transient only when it is a confirmation. A notice reporting something still to
        // act on — a failed write, a commit that never reached the remote — must not be erased
        // on a timer: the page would quietly delete the only report of it.
        options.notice
          ? html`<div class="card" ${options.transientNotice ? raw('data-transient') : html``}>${options.notice}</div>`
          : html``
      }
      ${options.error ? html`<div class="card error">${options.error}</div>` : html``}

      ${
        // Declared but not yet written. Nothing is editable until the file exists, so the page
        // shows what it WOULD contain and offers to create it — as a draft, like every other
        // write, rather than committing something nobody reviewed.
        options.missingFile
          ? html`<form method="post" action="/p/${options.service}/${options.active}"
                  hx-post="/p/${options.service}/${options.active}" hx-target="#page"
                  hx-swap="innerHTML">
              ${
                options.offerDeclined
                  ? html``
                  : html`<div class="card" style="border-left:3px solid #b45309;">
                      <div style="font-weight:600;">
                        ${options.service}/${options.active} has no file yet.
                      </div>
                      <p class="sub" style="margin:3px 0 .85rem;">
                        Create <code>config/${options.service}/${options.active}.yaml</code> from
                        the schema's defaults? It is staged as a draft — nothing is committed
                        until you publish it.
                      </p>
                      <div class="actionline">
                        ${writeAction({
                          className: 'linkbtn go',
                          attributes: html`name="intent" value="create"`,
                          resting: html`Create ${options.service}/${options.active}.yaml?`,
                          running: 'Creating the draft…',
                        })}
                        <a class="hint"
                           href="/p/${options.service}?env=${options.active}&create=no"
                           hx-get="/p/${options.service}?env=${options.active}&create=no"
                           hx-target="#page" hx-swap="innerHTML">Not now</a>
                      </div>
                    </div>`
              }
              ${
                options.offerDeclined
                  ? html`<div class="card actions" style="padding:.7rem 1.25rem;">
                      <div class="actionline">
                        <span class="idle">No file yet · every key below is the schema's default</span>
                        <span class="sep">·</span>
                        ${writeAction({
                          className: 'linkbtn go',
                          attributes: html`name="intent" value="create"`,
                          resting: html`Create ${options.service}/${options.active}.yaml?`,
                          running: 'Creating the draft…',
                        })}
                      </div>
                    </div>`
                  : html``
              }
            </form>
            <div class="card" style="padding:.5rem 1.25rem 1rem;">${options.rows.map(
              (row) =>
                html`<div class="keyrow" style="padding:10px 0;">
                <div style="flex-grow:1;">
                  <div class="keyline"><strong>${row.key}</strong>
                    <span class="hint">${typeHint(row.definition)}</span></div>
                  <div class="hint">${
                    row.definition?.secret
                      ? 'secret — set it once the file exists'
                      : format(row.value)
                  }</div>
                </div>
              </div>`,
            )}</div>`
          : html``
      }
      ${
        options.missingFile
          ? html``
          : html`
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
            <span class="selection" data-selection ${idle ? 'hidden' : ''}
                  data-drafted="${drafted.join(',')}">
              <!-- The count says how many; hovering it says which. The script rebuilds the panel
                   as ticks move, because before a draft is saved the server has never seen the
                   edits the panel is describing. -->
              <span class="pending sel" tabindex="0">
                <!-- Two states, two words. Edited here and not yet saved is UNSAVED; written
                     into the draft and not yet committed is UNPUBLISHED. They differ in where
                     they live and in which action leaves them, so one word would be wrong in
                     one of them. -->
                <!-- Two counts behind one sentence. What is UNSAVED is counted from the page,
                     by the script, because the server has never seen it. What is UNPUBLISHED is
                     counted from the draft, by the server, because that is where it lives —
                     ticks have nothing to do with it now that a draft publishes whole. -->
                <span class="count" data-label="{n} unsaved change{s}."
                      data-drafted-label="${drafted.length} unpublished change${
                        drafted.length === 1 ? '' : 's'
                      }."
                  >${
                    nothingToDraft && hasDraft
                      ? html`${drafted.length} unpublished change${drafted.length === 1 ? '' : 's'}.`
                      : html`${ticked} unsaved change${ticked === 1 ? '' : 's'}.`
                  }</span>
                ${detailPanel(hasDraft ? 'Unpublished changes' : 'Unsaved changes', activeEnv?.pending ?? [])}
              </span>
              <!-- Hidden rather than absent: the script shows it again the moment something on
                   the page is not in the draft, without a round trip to find that out. -->
              <span data-draft-action ${nothingToDraft ? 'hidden' : ''}>
                ${writeAction({
                  attributes: html`name="intent" value="save" data-needs-ticks ${
                    ticked === 0 ? raw('disabled') : html``
                  }`,
                  resting: html`<span data-label="Save {n} change{s} as draft?"
                    >Save ${ticked} change${ticked === 1 ? '' : 's'} as draft?</span>`,
                  running: 'Saving the draft…',
                })}
              </span>
              ${
                // Publishing appears only once something is actually saved, and withdraws again
                // the moment the page holds something the draft does not: two states competing
                // for one toolbar, where offering a publish beside unsaved edits invites
                // publishing a draft that leaves out what is on the screen.
                //
                // Hidden rather than absent, so the script can bring it back without a round
                // trip. The draft count is the SERVER's — publishing ships whole drafts, so it
                // has nothing to do with what is ticked.
                hasDraft
                  ? html`<span class="sep" data-publish-action ${nothingToDraft ? '' : 'hidden'}>·</span>
                      <span data-publish-action ${nothingToDraft ? '' : 'hidden'}>
                        ${writeAction({
                          className: 'linkbtn go',
                          attributes: html`name="intent" value="publish"`,
                          resting: html`Publish ${drafts} draft${drafts === 1 ? '' : 's'} in ${options.active}?`,
                          running: 'Publishing…',
                        })}
                      </span>`
                  : html``
              }
            </span>
          </div>
        </div>
        </div>

        <div class="card" style="padding:.5rem 1.25rem 1rem;">${fields}</div>
      </form>`
      }
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
      ${
        offer.movable.length === 0
          ? html``
          : writeAction({
              className: 'linkbtn go',
              resting: html`Save ${offer.movable.length} as a draft in ${offer.nextEnvironment}?`,
              running: 'Saving the draft…',
            })
      }
      <a href="/p/${options.service}?env=${options.active}">Not now</a>
    </form>
  </div>`;
}
