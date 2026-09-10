import { html, raw, type SafeHtml } from '@config/src/views/html.js';
import { consoleTabs, layout, type PageNotice, pageHeader } from '@config/src/views/page-frame.js';
export function renderFeatureAddRow(environment = ''): SafeHtml {
  return html`<li class="row feature-row">
    <form method="post" action="/features" hx-post="/features" hx-target="#page"
          hx-swap="innerHTML" class="fieldrow" style="width:100%;margin:0;">
      ${environment ? html`<input type="hidden" name="environment" value="${environment}">` : html``}
      <label class="field" style="flex:1;margin:0;">Feature name
        <input type="text" name="name" required pattern="[A-Z][A-Z0-9_]*" autofocus>
      </label>
      <button type="submit">Save</button>
      <a class="linkbtn no" href="/features?env=${encodeURIComponent(environment)}" hx-get="/features?env=${encodeURIComponent(environment)}" hx-target="#page"
         hx-swap="innerHTML" hx-push-url="true">Cancel</a>
    </form>
  </li>`;
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
}): SafeHtml {
  const names = Object.keys(options.flags).sort((left, right) => left.localeCompare(right));
  const rows = names.map((name) => {
    const enabled = options.flags[name]?.[options.environment] === true;
    const action = `/features/${encodeURIComponent(name)}`;
    return html`<li class="row feature-row">
      <span class="feature-name">${name}</span>
      <form class="feature-switch" method="post" action="${action}" hx-post="${action}"
            hx-target="#page" hx-swap="innerHTML">
        <input type="hidden" name="environment" value="${options.environment}">
        <label class="switch" title="${enabled ? 'Disable' : 'Enable'} ${name}">
          <input type="checkbox" name="value" value="true" ${enabled ? raw('checked') : raw('')}
                 onchange="this.form.requestSubmit()" aria-label="${name}">
          <span class="track"><span class="knob"></span></span><span class="state"></span>
        </label>
      </form>
    </li>`;
  });
  const addRow = options.adding ? renderFeatureAddRow(options.environment) : html``;
  const addUrl = `/features/new?env=${encodeURIComponent(options.environment)}`;
  const body = html`
    ${consoleTabs('features')}
    ${pageHeader({
      ...(options.notice ? { notice: options.notice } : {}),
      dismissTo: '/features',
      title: html`Features`,
      facts: html`Feature flags · ${options.environment}`,
      actions: options.environment
        ? html`<a class="linkbtn" href="${addUrl}" hx-get="${addUrl}"
        hx-target="#feature-list" hx-swap="beforeend">Add a feature</a>`
        : html``,
    })}
    <nav class="tabs" aria-label="Feature environments">${(options.environments ?? []).map(
      (environment) => {
        const url = `/features?env=${encodeURIComponent(environment)}`;
        return html`<a class="tab ${environment === options.environment ? 'on' : ''}" href="${url}" hx-get="${url}" hx-target="#page" hx-swap="innerHTML" hx-push-url="true">${environment}</a>`;
      },
    )}</nav>
    ${options.error ? html`<div class="card error">${options.error}</div>` : html``}
    <ul class="rows" id="feature-list">
      ${addRow}
      ${rows.length > 0 ? rows : html`<li class="row"><span class="hint">No features yet.</span></li>`}
    </ul>`;
  return options.fragment ? body : layout('Features', body, options.settingsLink, options.build);
}
