import { html, raw, type SafeHtml } from '@config/src/views/html.js';
import {
  layout,
  layoutChrome,
  pageHeader,
  trail,
  writeAction,
} from '@config/src/views/page-frame.js';

function renderKeyRow(
  row: Record<string, string>,
  index: number,
  problems: ReadonlyArray<{ key: string; message: string }>,
): SafeHtml {
  const name = row.name ?? '';
  return html`<div class="card keydraft" data-key-row>
      <div class="fieldrow">
        <label class="field">
          <span class="fieldlabel">Key</span>
          <input type="text" name="key.${index}.name" value="${name}" placeholder="SESSION_TTL"
                 spellcheck="false">
        </label>
        <label class="field">
          <span class="fieldlabel">Type</span>
          <select name="key.${index}.type" data-key-type>
            ${['string', 'int', 'bool', 'url', 'string[]'].map(
              (type) =>
                html`<option value="${type}" ${row.type === type ? raw('selected') : html``}>${type}</option>`,
            )}
          </select>
        </label>
      </div>
      <div class="fieldrow" data-when="string">
        <label class="field checkfield">
          <input type="checkbox" name="key.${index}.secret" value="1" data-key-secret ${
            row.secret ? raw('checked') : html``
          }>
          <span class="fieldlabel">This will be treated as secret</span>
        </label>
      </div>
      <div class="fieldrow">
        <label class="field" data-when="string" data-not-secret>
          <span class="fieldlabel">Values <span class="hint">comma separated</span></span>
          <input type="text" name="key.${index}.values" value="${row.values ?? ''}" placeholder="optional, all">
        </label>
        <label class="field" data-when="int">
          <span class="fieldlabel">Min</span>
          <input type="number" step="1" name="key.${index}.min" value="${row.min ?? ''}">
        </label>
        <label class="field" data-when="int">
          <span class="fieldlabel">Max</span>
          <input type="number" step="1" name="key.${index}.max" value="${row.max ?? ''}">
        </label>
        <label class="field" data-when="string int url string[]" data-not-secret>
          <span class="fieldlabel">Default <span class="hint">blank means none</span></span>
          <input type="text" data-key-default name="key.${index}.default" value="${row.default ?? ''}">
        </label>
        <label class="field checkfield" data-when="bool">
          <input type="checkbox" name="key.${index}.defaultBool" value="true" ${
            row.defaultBool === 'true' ? raw('checked') : html``
          }>
          <span class="fieldlabel">Default <span class="hint">unticked means none</span></span>
        </label>
      </div>
      <div class="fieldrow">
        <label class="field wide">
          <span class="fieldlabel">Description</span>
          <input type="text" name="key.${index}.description" value="${row.description ?? ''}"
                 placeholder="What this key does">
        </label>
      </div>
      ${problems.map((problem) => html`<p class="err">${problem.message}</p>`)}
    </div>`;
}

export function renderNewProduct(options: {
  environments: readonly string[];

  typed?: {
    name?: string;
    uid?: string;
    environments?: readonly string[];
    keys?: ReadonlyArray<Record<string, string>>;
  };

  problems?: ReadonlyArray<{ key: string; message: string }>;
  settingsLink?: boolean;
  build?: string;
  fragment?: boolean;
  autoSync?: boolean;
  currentPath?: string;
}): SafeHtml {
  const typed = options.typed ?? {};
  const problems = options.problems ?? [];
  const about = (key: string) => problems.filter((problem) => problem.key === key);
  // One blank row is always offered: a schema with no keys is allowed, but making someone press
  // add before they can type the first one asks a question nobody has a reason to answer.
  const rows = typed.keys && typed.keys.length > 0 ? typed.keys : [{}];
  const keyRows = rows.map((row, index) => renderKeyRow(row, index, about(row.name ?? '')));
  const named = rows.some((row) => (row.name ?? '').trim().length > 0);

  const body = html`
      ${pageHeader({
        title: trail('Add a product'),
        facts: html`An identity, a schema, and the environments it lives in`,
      })}
      ${about('').map((problem) => html`<div class="card error">${problem.message}</div>`)}
      <form method="post" action="/p/new" hx-post="/p/new" hx-target="#page"
            hx-swap="innerHTML" id="new-product">
        
        <div class="actionline">
          ${writeAction({
            className: 'linkbtn go',
            post: '/p/new',
            include: '#new-product',
            resting: html`Create product`,
            running: 'Creating',
          })}
          <span class="sep">·</span>
          
          <a class="linkbtn no" data-discard href="/" hx-get="/" hx-target="#page"
             hx-swap="innerHTML" hx-push-url="true">Discard</a>
          <span class="discard-ask" data-discard-confirm hidden>
            <span>You have unsaved changes. You still want to Discard?</span>
            <a class="linkbtn no" href="/" hx-get="/" hx-target="#page" hx-swap="innerHTML"
               hx-push-url="true">Yes, discard</a>
            <span class="sep">·</span>
            <button type="button" class="linkbtn" data-keep>Keep editing</button>
          </span>
        </div>
        <div class="card">
          <div class="fieldrow">
            <label class="field">
              <span class="fieldlabel">Name</span>
              <input type="text" name="name" value="${typed.name ?? ''}" placeholder="audit"
                     spellcheck="false">
            </label>
            <label class="field">
              <span class="fieldlabel">uid <span class="hint">must be unique</span></span>
              <input type="text" name="uid" value="${typed.uid ?? ''}" inputmode="numeric" placeholder="1004">
            </label>
          </div>
          <div class="fieldrow">
            <span class="fieldlabel">Environments</span>
            ${options.environments.map(
              (environment) => html`<label class="field checkfield">
                <input type="checkbox" name="environment" value="${environment}" ${
                  (typed.environments ?? options.environments).includes(environment)
                    ? raw('checked')
                    : html``
                }>
                <span>${environment}</span>
              </label>`,
            )}
          </div>
        </div>
        <div id="key-rows">${keyRows}</div>
        <div class="actionline" data-add-key-line ${named ? html`` : raw('hidden')}>
          <button type="submit" class="linkbtn" name="intent" value="add-key" data-add-key>Add a variable</button>
        </div>
      </form>
    `;

  return options.fragment
    ? body
    : layout('Add a product', body, options.settingsLink, options.build, layoutChrome(options));
}
