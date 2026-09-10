import type { KeyDefinition } from '@config/src/schema/validator.js';
import { html, raw, type SafeHtml } from '@config/src/views/html.js';
import {
  consoleTabs,
  layout,
  type PageNotice,
  pageHeader,
  trail,
  writeAction,
} from '@config/src/views/page-frame.js';

export interface LiveKeyRow {
  key: string;
  definition: KeyDefinition;
  value: unknown;
  error?: string;
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
}
export interface LivePageOptions {
  fragment?: boolean;
  settingsLink?: boolean;
  build?: string;
  notice?: PageNotice;
}
export const livePage = (title: string, body: SafeHtml, options: LivePageOptions): SafeHtml =>
  options.fragment ? body : layout(title, body, options.settingsLink, options.build);

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
    pendingBackup: number;
    /** How many products are retiring overall, which the link reports. Counted across the whole
        registry, not the filtered page, so searching does not change what the link says. */
    retiring?: number;
    retiringOnly?: boolean;
    query?: string;
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
        : [],
    }))
    .filter(
      ({ product, matched }) =>
        !needle || product.name.toLowerCase().includes(needle) || matched.length > 0,
    );
  const body = html`${consoleTabs('products')}${pageHeader({
    title: options.retiringOnly ? trail('Retiring') : html`Products`,
    notice: options.notice,
    facts: html`${products.length} products · ${options.pendingBackup} changes awaiting backup`,
    actions: html`<a href="/p/new">Add a product</a>${retiringLink(
      options.retiring ?? options.products.filter((product) => product.retiring).length,
    )}<form method="post" action="/sync">${writeAction({ resting: html`Back up`, running: 'Backing up…' })}</form>`,
    search: html`<form class="search" method="get" action="/"><input type="search" name="q" value="${query}" aria-label="Search products"><button class="linkbtn" type="submit">Search</button>${query ? html`<a class="linkbtn no" href="/">Clear</a>` : html``}</form>`,
  })}
    <div class="rows">${products.map(({ product, matched }) => html`<div class="row"><a class="pname" href="/p/${product.name}">${product.name}${product.uid === undefined ? '' : ` (${product.uid})`}</a><span class="hint">${product.environments.join(', ')}</span>${matched.map((key) => html`<a class="chip-item" href="/p/${product.name}?env=${product.environments[0] ?? ''}&hl=${key}">${key}</a>`)}${product.retiring ? html`<span class="chip">retiring</span><form method="post" action="/p/${product.name}/retire"><input type="hidden" name="retiring" value="false">${writeAction({ resting: html`Cancel retirement`, running: 'Cancelling…' })}</form><form method="post" action="/p/${product.name}/archive">${writeAction({ resting: html`Archive…`, running: 'Archiving…' })}</form>` : html``}</div>`)}</div>`;
  return livePage(options.retiringOnly ? 'Retiring' : 'Products', body, options);
}

function field(row: LiveKeyRow): SafeHtml {
  const name = `key.${row.key}`;
  const value = row.definition.secret ? '' : row.value;
  const formatted = Array.isArray(value) ? value.join(', ') : (value ?? '');
  let control: SafeHtml;
  if (row.definition.secret)
    control = html`<input type="password" name="${name}" id="${name}" value="" autocomplete="off" placeholder="Leave blank to keep the current value">`;
  else if (row.definition.type === 'bool')
    control = html`<input type="hidden" name="${name}" value="false"><label class="switch"><input type="checkbox" name="${name}" id="${name}" value="true" ${value === true ? raw('checked') : html``}><span class="track"><span class="knob"></span></span><span class="state"></span></label>`;
  else if (row.definition.type === 'enum')
    control = html`<select name="${name}" id="${name}"><option value=""></option>${(row.definition.values ?? []).map((option) => html`<option value="${option}" ${option === value ? raw('selected') : html``}>${option}</option>`)}</select>`;
  else
    control = html`<input type="${row.definition.type === 'int' ? 'number' : row.definition.type === 'url' ? 'url' : 'text'}" name="${name}" id="${name}" value="${formatted}" ${row.definition.min !== undefined ? html`min="${row.definition.min}"` : html``} ${row.definition.max !== undefined ? html`max="${row.definition.max}"` : html``}>`;
  return html`<div class="field keyrow"><span class="keypick"><input type="checkbox" name="select" value="${row.key}" data-select="${row.key}" aria-label="Select ${row.key} for Promote or Delete"></span><div style="flex:1"><label for="${name}">${row.key}</label><span class="hint">${row.definition.description ?? row.definition.type}${row.definition.secret ? ' · secret' : ''}</span>${control}${row.error ? html`<p class="err">${row.error}</p>` : html``}</div></div>`;
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
  },
): SafeHtml {
  const action = `/p/${options.service}/${options.environment}`;
  const back = `/p/${options.service}?env=${encodeURIComponent(options.environment)}`;
  const body = html`${consoleTabs('products')}${pageHeader({
    title: trail(options.service),
    notice: options.notice,
    dismissTo: back,
    facts: html`${options.environment} · version ${options.version}${options.retiring ? ' · retiring' : ''}`,
    actions: html`<form method="post" action="/p/${options.service}/retire"><input type="hidden" name="retiring" value="${options.retiring ? 'false' : 'true'}">${writeAction(
      {
        resting: html`${options.retiring ? 'Cancel retirement' : 'Retire…'}`,
        running: options.retiring ? 'Cancelling…' : 'Retiring…',
      },
    )}</form>`,
  })}
    <nav class="tabs" aria-label="Product environments">${options.environments.map((environment) => html`<a class="tab ${environment === options.environment ? 'on' : ''}" href="/p/${options.service}?env=${environment}">${environment}</a>`)}</nav>
    ${
      options.missing
        ? html`<form method="post" action="${action}"><input type="hidden" name="intent" value="create">${writeAction({ resting: html`Create from schema defaults…`, running: 'Creating…' })}</form>`
        : html`
    <form id="config-form" method="post" action="${action}" hx-post="${action}" hx-target="#page" hx-swap="innerHTML" data-live-values>
      <input type="hidden" name="etag" value="${options.etag ?? ''}">
      <input type="hidden" name="environment" value="${options.environment}">
      <input type="hidden" name="service" value="${options.service}">
      <input type="hidden" name="from" value="${options.environment}">
      <input type="hidden" name="to" value="${options.next ?? ''}">
      <div class="actionline">${writeAction({
        resting: html`Save`,
        running: 'Saving…',
        post: action,
        include: '#config-form',
        // htmx does not send a submit button's name/value when the BUTTON issues the request,
        // so the intent travels in hx-vals. The name/value stays for the no-JS submit.
        vals: '{"intent":"save"}',
        attributes: html`name="intent" value="save"`,
      })}
      ${
        options.next
          ? writeAction({
              resting: html`Promote to ${options.next}`,
              running: 'Promoting…',
              post: '/promote',
              include: '#config-form',
              vals: '{"intent":"promote"}',
              attributes: html`formaction="/promote" name="intent" value="promote" data-selection-action`,
            })
          : html``
      }
      ${writeAction({
        resting: html`Delete keys…`,
        running: 'Checking…',
        post: `/p/${options.service}/delete-keys`,
        include: '#config-form',
        vals: '{"intent":"delete"}',
        attributes: html`formaction="/p/${options.service}/delete-keys" name="intent" value="delete" data-selection-action`,
      })}</div>
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
    <div class="card"><p>${options.message}</p><form method="post" action="${options.action}">${Object.entries(options.fields).flatMap(([name, values]) => (typeof values === 'string' ? [values] : values).map((value) => html`<input type="hidden" name="${name}" value="${value}">`))}<button name="confirm" value="yes">Yes, continue</button><a href="${options.back}">Cancel</a></form></div>`,
    options,
  );
}
