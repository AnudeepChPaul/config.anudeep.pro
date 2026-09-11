import type { KeyDefinition } from '@config/src/schema/validator.js';
import { html, raw, type SafeHtml } from '@config/src/views/html.js';
import {
  consoleTabs,
  layout,
  layoutChrome,
  type PageNotice,
  pageHeader,
  titled,
  trail,
  writeAction,
} from '@config/src/views/page-frame.js';

/** A live value that has not reached Git yet, compared with the last committed copy. */
export interface UnsyncedChange {
  key: string;
  from: unknown;
  to: unknown;
  secret?: boolean;
}

export interface LiveKeyRow {
  key: string;
  definition: KeyDefinition;
  value: unknown;
  error?: string;
  /** What the same key holds in the other declared environments, for the hover panel. */
  elsewhere?: Readonly<Record<string, unknown>>;
  /** Last Git value vs live, when this key is saved and not yet synced. */
  change?: UnsyncedChange;
  /** Marks the row a search link arrived for, so the eye lands on it without a scroll. */
  found?: boolean;
}
export interface LiveProduct {
  name: string;
  /** The unix uid the grant belongs to, shown beside the name because "which uid gets this"
      is the question the registry exists to answer. */
  uid?: number;
  environments: readonly string[];
  retiring: boolean;
  /** Every key the product declares, so a search can find a key without knowing which product
      holds it — which is how you look for one when you cannot remember where it lives. */
  keys?: readonly string[];
  /** Declared in the registry but with no schema: the list must say so, and must not link. */
  missingSchema?: boolean;
  /** Unique keys saved in the database that have not reached Git. */
  unsynced?: number;
}

const shownValue = (value: unknown, secret?: boolean): string => {
  if (secret) return '••••';
  if (value === undefined) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const wasNow = (change: UnsyncedChange): SafeHtml =>
  html`<span class="wasnow"><span class="was">${shownValue(change.from, change.secret)}</span><span class="arrow">→</span><span class="is">${shownValue(change.to, change.secret)}</span></span>`;

const changePeek = (change: UnsyncedChange): SafeHtml =>
  html`<span class="detail">${wasNow(change)}</span>`;

const idleDiffs = (changes: readonly UnsyncedChange[]): SafeHtml =>
  changes.length === 0
    ? html``
    : html`${changes.map(
      (change) =>
        html`<span class="wasnow"><span class="diffkey">${change.key}</span> <span class="was">${shownValue(change.from, change.secret)}</span><span class="arrow">→</span><span class="is">${shownValue(change.to, change.secret)}</span></span>`,
    )}`;
export interface LivePageOptions {
  fragment?: boolean;
  settingsLink?: boolean;
  build?: string;
  notice?: PageNotice;
  autoSync?: boolean;
  currentPath?: string;
  dismissTo?: string;
}
export const livePage = (title: string, body: SafeHtml, options: LivePageOptions): SafeHtml =>
  options.fragment
    ? body
    : layout(title, body, options.settingsLink, options.build, layoutChrome(options));

/**
 * The way back to the retiring list. Three operator rules live here, and each was asked for:
 *   - it says how many, singular or plural, because "Retiring" alone made you open the page to
 *     find out whether there was anything on it;
 *   - it is danger-coloured like Drop, Clear and Not now, because retiring a product takes
 *     something away;
 *   - it is not rendered at all when nothing is retiring, rather than sitting there reading
 *     zero, which is a link to an empty page.
 */
const retiringLink = (retiring: number): SafeHtml =>
  retiring === 0
    ? html``
    : html`<a class="linkbtn no" href="/p/retiring">${retiring} ${retiring === 1 ? 'product' : 'products'} retiring</a>`;

export function renderLiveProducts(
  options: LivePageOptions & {
    products: readonly LiveProduct[];
    /** How many products are retiring overall, which the link reports. Counted across the whole
        registry, not the filtered page, so searching does not change what the link says. */
    retiring?: number;
    retiringOnly?: boolean;
    query?: string;
    /** Unique unsynced keys across every product, for the facts line. */
    unsynced?: number;
    /** Manual git backup is offered only when auto-sync is off and local differs from the remote. */
    showSyncNow?: boolean;
  },
): SafeHtml {
  const query = options.query ?? '';
  const needle = query.toLowerCase();
  // A product matches on its own name or on any key it declares. `matched` carries WHICH keys
  // matched, because the result has to link to the key rather than to the product and leave you
  // to find it again.
  const products = options.products
    .filter((product) => !options.retiringOnly || product.retiring)
    .map((product) => ({
      product,
      matched: needle
        ? (product.keys ?? []).filter((key) => key.toLowerCase().includes(needle))
        : (product.keys ?? []),
    }))
    .filter(
      ({ product, matched }) =>
        !needle || product.name.toLowerCase().includes(needle) || matched.length > 0,
    );
  const emptySearch = needle.length > 0 && products.length === 0;
  const syncNow = options.showSyncNow
    ? html`<a class="linkbtn" href="/sync" hx-get="/sync" hx-target="#sync-preview" hx-swap="innerHTML">Sync changes now</a>`
    : html``;
  const body = html`${consoleTabs('products')}${pageHeader({
    title: options.retiringOnly ? trail('Retiring') : html`Products`,
    notice: options.notice,
    dismissTo: options.dismissTo,
    facts: html`${products.length} products${options.unsynced
      ? ` · ${options.unsynced} unsynced`
      : ''
      }`,
    actions: html`<a href="/p/new" class="linkbtn">Add a product</a>${retiringLink(
      options.retiring ?? options.products.filter((product) => product.retiring).length,
    )}${syncNow}`,
    search: html`<form class="search" method="get" action="/"><input type="search" name="q" value="${query}" placeholder="Search products" aria-label="Search products">${writeAction({ resting: html`Search`, running: 'Searching' })}${query ? html`<a class="linkbtn no" href="/">Clear</a>` : html``}</form>`,
  })}
    <div id="sync-preview"></div>
    ${emptySearch ? html`<p class="hint">No key matched.</p>` : html``}
    <div class="rows">${products.map(({ product, matched }) => {
    const label = `${titled(product.name)}${product.uid === undefined ? '' : ` (${product.uid})`}`;
    const unsyncedChip = product.unsynced
      ? html`<span class="chip wait">${product.unsynced} unsynced</span>`
      : html``;
    const name = product.missingSchema
      ? html`<span class="pname">${label}</span><span class="chip wait">schema is missing</span>${unsyncedChip}`
      : html`<a class="pname" href="/p/${product.name}">${label}</a>${unsyncedChip}`;
    const shownKeys = needle ? matched : matched.slice(0, 12);
    return html`<div class="row"><div class="product-info">${name}<span class="hint">${product.environments.map(titled).join(', ')}</span></div><span class="row-keys">${shownKeys.map((key) => {
      const dest = `/p/${product.name}?env=${product.environments[0] ?? ''}&hl=${key}`;
      return html`<a class="chip-item" href="${dest}#found" hx-get="${dest}" hx-target="#page" hx-swap="innerHTML show:none" hx-push-url="true">${key}</a>`;
    })}</span>${product.retiring ? html`<span class="row-end"><span class="chip">retiring</span><form method="post" action="/p/${product.name}/retire"><input type="hidden" name="retiring" value="false">${writeAction({ resting: html`Cancel retirement`, running: 'Cancelling' })}</form><form method="post" action="/p/${product.name}/archive">${writeAction({ className: 'linkbtn no', resting: html`Archive`, running: 'Archiving' })}</form></span>` : html``}</div>`;
  })}</div>`;
  return livePage(options.retiringOnly ? 'Retiring' : 'Products', body, options);
}

function field(row: LiveKeyRow): SafeHtml {
  const name = `key.${row.key}`;
  const value = row.definition.secret ? '' : row.value;
  const formatted = Array.isArray(value) ? value.join(', ') : (value ?? '');
  const original = String(formatted);
  let control: SafeHtml;
  if (row.definition.secret)
    control = html`<input type="password" name="${name}" id="${name}" value="" autocomplete="off" data-key="${row.key}" data-original="${original}" data-secret placeholder="Leave blank to keep the current value">`;
  else if (row.definition.type === 'bool')
    control = html`${value !== undefined ? html`<input type="hidden" name="${name}" value="false">` : html``
      }<label class="switch"><input type="checkbox" name="${name}" id="${name}" value="true" data-key="${row.key}" data-original="${original}" ${value === true ? raw('checked') : html``}><span class="track"><span class="knob"></span></span><span class="state"></span></label>`;
  else if (row.definition.type === 'enum')
    control = html`<select name="${name}" id="${name}" data-key="${row.key}" data-original="${original}"><option value=""></option>${(row.definition.values ?? []).map((option) => html`<option value="${option}" ${option === value ? raw('selected') : html``}>${option}</option>`)}</select>`;
  else
    control = html`<input type="${row.definition.type === 'int' ? 'number' : row.definition.type === 'url' ? 'url' : 'text'}" name="${name}" id="${name}" value="${formatted}" data-key="${row.key}" data-original="${original}" ${row.definition.min !== undefined ? html`min="${row.definition.min}"` : html``} ${row.definition.max !== undefined ? html`max="${row.definition.max}"` : html``}>`;
  const elsewhere = Object.entries(row.elsewhere ?? {});
  const chips =
    row.definition.type === 'string[]' && Array.isArray(row.value)
      ? html`<div class="chips">${row.value.map((member) => html`<span class="chip-item">${String(member)}</span>`)}</div>`
      : html``;
  const keyName = row.change
    ? html`<span class="peek" tabindex="0"><label for="${name}">${row.key}</label>${changePeek(row.change)}</span>`
    : html`<label for="${name}">${row.key}</label>`;
  return html`<div class="row keyrow ${row.found ? 'found' : ''}" ${row.found ? raw('id="found"') : html``}><span class="keypick"><input type="checkbox" name="select" value="${row.key}" data-select="${row.key}" aria-label="Select ${row.key} for Promote or Delete"></span><div class="keybody"><div class="keyline">${keyName}${elsewhere.length ? html`<span class="peek" tabindex="0">In other environments<span class="detail">${elsewhere.map(([environment, held]) => html`<div><span class="envname">${environment}</span> <span class="is">${held === undefined ? '—' : String(held)}</span></div>`)}</span></span>` : html``}</div><span class="hint">${row.definition.description ?? row.definition.type}${row.definition.secret ? ' · secret' : ''}</span>${control}${chips}${row.error ? html`<p class="err">${row.error}</p>` : html``}</div></div>`;
}

export function renderLiveProduct(
  options: LivePageOptions & {
    service: string;
    environment: string;
    environments: readonly string[];
    etag: string | null;
    rows: readonly LiveKeyRow[];
    version: number;
    next: string | null;
    retiring: boolean;
    missing: boolean;
    query?: string;
    unsynced?: readonly UnsyncedChange[];
  },
): SafeHtml {
  const action = `/p/${options.service}/${options.environment}`;
  const back = `/p/${options.service}?env=${encodeURIComponent(options.environment)}`;
  const query = options.query ?? '';
  const body = html`${consoleTabs('products')}${pageHeader({
    title: trail(titled(options.service)),
    notice: options.notice,
    dismissTo: back,
    facts: html`${options.environment} · version ${options.version}${options.retiring ? ' · retiring' : ''}`,
    search: html`<form class="search" method="get" action="/p/${options.service}"><input type="hidden" name="env" value="${options.environment}"><input type="search" name="q" value="${query}" placeholder="Search keys" aria-label="Search keys">${writeAction({ resting: html`Search`, running: 'Searching' })}${query ? html`<a class="linkbtn no" href="${back}">Clear</a>` : html``}</form>`,
    actions: html`<form method="post" action="/p/${options.service}/retire"><input type="hidden" name="retiring" value="${options.retiring ? 'false' : 'true'}">${writeAction(
      {
        className: options.retiring ? 'linkbtn' : 'linkbtn no',
        resting: html`${options.retiring ? 'Cancel retirement' : 'Retire'}`,
        running: options.retiring ? 'Cancelling' : 'Retiring',
      },
    )}</form>`,
  })}
    <nav class="tabs" aria-label="Product environments">${options.environments.map((environment) => html`<a class="tab ${environment === options.environment ? 'on' : ''}" href="/p/${options.service}?env=${environment}" hx-get="/p/${options.service}?env=${environment}" hx-target="#page" hx-swap="innerHTML" hx-push-url="true">${titled(environment)}</a>`)}</nav>
    ${options.missing
      ? html`<p class="hint">No file for ${options.environment} yet.</p>
    <form method="post" action="${action}" class="actionslot"><div class="actionline"><input type="hidden" name="intent" value="create">${writeAction({ resting: html`Create from schema defaults`, running: 'Creating' })}</div></form>
    <div class="rows"><div class="row"><span class="row-keys">${options.rows.map((row) => html`<span class="chip-item">${row.key}</span>`)}</span></div></div>`
      : html`
    <form id="config-form" method="post" action="${action}" hx-post="${action}" hx-target="#page" hx-swap="innerHTML" data-live-values data-keys data-save-post="${action}" data-delete-post="/p/${options.service}/delete-keys"${options.next
          ? html` data-promote-post="/promote" data-promote-label="Promote to ${options.next}"`
          : html``
        }>
      <input type="hidden" name="etag" value="${options.etag ?? ''}">
      <input type="hidden" name="environment" value="${options.environment}">
      <input type="hidden" name="service" value="${options.service}">
      <input type="hidden" name="from" value="${options.environment}">
      <input type="hidden" name="to" value="${options.next ?? ''}">
      <div class="actionslot"><div class="actionline"><span class="idle">${options.rows.length} variables in ${options.environment} · serving revision ${options.version}${idleDiffs(options.unsynced ?? [])}</span></div></div>
      <div class="rows">${options.rows.map(field)}</div>
    </form>`
    }`;
  return livePage(options.service, body, options);
}

export function renderConfirmation(
  options: LivePageOptions & {
    title: string;
    message: string;
    action: string;
    fields: Readonly<Record<string, string | readonly string[]>>;
    back: string;
  },
): SafeHtml {
  return livePage(
    options.title,
    html`${consoleTabs('products')}${pageHeader({ title: html`${options.title}`, notice: options.notice })}
    <div class="card"><p>${options.message}</p><form method="post" action="${options.action}">${Object.entries(options.fields).flatMap(([name, values]) => (typeof values === 'string' ? [values] : values).map((value) => html`<input type="hidden" name="${name}" value="${value}">`))}<div class="actionline end">${writeAction({ resting: html`Yes, continue`, running: 'Continuing', attributes: html`name="confirm" value="yes"` })}<a class="linkbtn no" href="${options.back}">Cancel</a></div></form></div>`,
    options,
  );
}

export function renderSyncPreview(
  options: LivePageOptions & {
    entries: readonly { path: string; keys: readonly string[]; actor: string }[];
    unpushed: readonly { subject: string }[];
  },
): SafeHtml {
  const actions = [
    ...options.entries.map(
      (entry) => html`<li>${entry.path}: ${entry.keys.join(', ') || 'keys'} · ${entry.actor}</li>`,
    ),
    ...options.unpushed.map((commit) => html`<li>${commit.subject}</li>`),
  ];
  const count = options.entries.length + options.unpushed.length;
  const card = html`<div class="card" id="sync-card">
    ${pageHeader({
    title: html`Sync changes now`,
    facts: html`${count} ${count === 1 ? 'action' : 'actions'} to sync`,
    compact: true,
  })}
    <ul class="sync-actions">${actions}</ul>
    <form method="post" action="/sync" hx-post="/sync" hx-target="#page" hx-swap="innerHTML">
      <div class="actionline end">
        ${writeAction({ resting: html`Confirm`, running: 'Syncing', attributes: html`name="confirm" value="yes"` })}
        <a class="linkbtn no" href="/" hx-get="/" hx-target="#sync-preview" hx-select="#sync-preview">Cancel</a>
      </div>
    </form>
  </div>`;
  if (options.fragment) return card;
  return livePage('Sync changes now', html`${consoleTabs('products')}${card}`, options);
}
