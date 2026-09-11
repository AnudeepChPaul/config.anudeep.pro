import { html, raw, type SafeHtml } from '@config/src/views/html.js';
export const layoutChrome = (options: {
  autoSync?: boolean;
  currentPath?: string;
}): { autoSync?: boolean; currentPath?: string } => ({
  ...(options.autoSync !== undefined ? { autoSync: options.autoSync } : {}),
  ...(options.currentPath ? { currentPath: options.currentPath } : {}),
});

export const layout = (
  title: string,
  body: SafeHtml,
  settingsLink = false,
  build = '',
  extras: { autoSync?: boolean; currentPath?: string } = {},
): SafeHtml => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/assets/base.css" defer/>
</head>
<body>
<main id="page">${body}</main>

${build || settingsLink || extras.autoSync !== undefined
    ? html`<footer class="pagefoot">${build ? html`<span class="build">${build}</span>` : html``}${extras.autoSync !== undefined
      ? html`<form class="autosync" method="post" action="/sync/auto" hx-post="/sync/auto" hx-target="#page" hx-swap="innerHTML">
            <input type="hidden" name="next" value="${extras.currentPath ?? '/'}">
            <input type="hidden" name="autoSync" value="false">
            <label class="switch policy">
              <span class="name">Auto sync</span>
              <input type="checkbox" name="autoSync" value="true" ${extras.autoSync ? raw('checked') : raw('')}
                     onchange="this.form.requestSubmit()" aria-label="Auto sync">
              <span class="track"><span class="knob"></span></span>
            </label>
          </form>`
      : html``
      }${settingsLink
        ? html`<a href="/settings" hx-get="/settings" hx-target="#page" hx-swap="innerHTML"
              hx-push-url="true">Settings</a>`
        : html``
      }</footer>`
    : html``
  }
<script src="/assets/htmx.js" defer></script>
<script src="/assets/ticks.js" defer></script>
<script src="/assets/keys.js" defer></script>
</body>
</html>`;
export function writeAction(options: {
  resting: SafeHtml;
  running: string;
  className?: string;
  attributes?: SafeHtml;

  post?: string;

  include?: string;

  vals?: string;
}): SafeHtml {
  // The form keeps its own method, action and hx-post: this is progressive enhancement, so a
  // keyboard submit and a no-JS browser must still work. htmx handles the click on a button that
  // carries hx-post and the form's submit never fires, so a click makes exactly one request.
  const request = options.post
    ? html`hx-post="${options.post}" hx-target="#page" hx-swap="innerHTML" hx-include="${options.include ?? 'closest form'
      }"${options.vals ? raw(` hx-vals='${options.vals}'`) : html``}`
    : html``;
  return html`<button type="submit" class="${options.className ?? 'linkbtn'}" ${request} ${options.attributes ?? html``}>
    <span class="resting">${options.resting}</span>
    <span class="running"><span class="spinner"></span>${options.running}</span>
  </button>`;
}

export interface PageNotice {
  readonly tone: 'done' | 'problem';
  readonly text: string;
}

export function noticeLine(notice: PageNotice | undefined, dismissTo: string): SafeHtml {
  if (!notice) return html``;
  const done = notice.tone === 'done';
  return html`<span class="notice ${done ? 'done' : 'problem'}" data-notice ${done ? raw('data-transient') : html``
    }><span class="notice-text">${notice.text}</span><a class="linkbtn no" data-dismiss
      href="${dismissTo}" hx-get="${dismissTo}" hx-target="#page" hx-swap="innerHTML"
      hx-push-url="true">Dismiss</a></span>`;
}

export function pageHeader(options: {
  title: SafeHtml;

  facts?: SafeHtml;

  actions?: SafeHtml;

  search?: SafeHtml;

  notice?: PageNotice;

  dismissTo?: string;
  /** Skip the reserved search and notice rows. A card that is not a page must not inherit their height. */
  compact?: boolean;
}): SafeHtml {
  return html`<div class="pagehead">
    ${options.compact
      ? html``
      : html`<div class="searchrow">${options.search ?? html``}</div>
    <div class="noticerow">${noticeLine(options.notice, options.dismissTo ?? '/')}</div>`
    }
    <div class="titlerow">
      <h1>${options.title}</h1>
      <div class="actions-right">${options.actions ?? html``}</div>
    </div>
    <div class="facts">${options.facts ?? html``}</div>
  </div>`;
}

/** Visible form of a product or environment id. Hrefs keep the raw name. */
export function titled(value: string): string {
  return value.replace(
    /(^|[^A-Za-z0-9])([A-Za-z])/g,
    (_match, sep: string, letter: string) => sep + letter.toUpperCase(),
  );
}

export function trail(here: string): SafeHtml {
  return html`<a href="/" hx-get="/" hx-target="#page" hx-swap="innerHTML"
      hx-push-url="true">Products</a><span class="crumb-sep">›</span><span>${here}</span>`;
}

export function consoleTabs(active: 'products' | 'features'): SafeHtml {
  return html`<nav class="tabs" aria-label="Console sections">
    <a class="tab ${active === 'products' ? 'on' : ''}" href="/" hx-get="/" hx-target="#page"
       hx-swap="innerHTML" hx-push-url="true">Products</a>
    <a class="tab ${active === 'features' ? 'on' : ''}" href="/features" hx-get="/features"
       hx-target="#page" hx-swap="innerHTML" hx-push-url="true">Features</a>
  </nav>`;
}

export function searchBox(options: {
  action: string;
  query: string;
  placeholder: string;
}): SafeHtml {
  return html`<form class="search" method="get" action="${options.action}"
        hx-get="${options.action}" hx-target="#page" hx-swap="innerHTML" hx-push-url="true">
    <input type="search" name="q" value="${options.query}" placeholder="${options.placeholder}"
           aria-label="${options.placeholder}">
    ${writeAction({ resting: html`Search`, running: 'Searching' })}
    ${
    // The same treatment as Search beside it. It was a hint — a size smaller, muted, not
    // underlined — so two controls on one row sat on different baselines and read as
    // misaligned. They are both actions, so they look like actions.
    options.query
      ? html`<a class="linkbtn no" href="${options.action}" hx-get="${options.action}"
              hx-target="#page" hx-swap="innerHTML" hx-push-url="true">Clear</a>`
      : html``
    }
  </form>`;
}
