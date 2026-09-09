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
  /* ---------------------------------------------------------------------------
     The palette, as roles.
     Twelve hex values used to be written inline through this file, several of them
     near-duplicates, and nothing said what any of them meant — so a new element got whichever
     value looked closest. A colour is a role now, and this block is the only place one is
     written down. Five roles carry meaning; nothing else gets a colour.
     --------------------------------------------------------------------------- */
  :root {
    --ground: #faf9f7;        /* the page */
    --surface: #ffffff;       /* cards, rows, the header */
    --ink: #1c1b19;           /* text, the active tab, a switch that is on */
    --muted: #6b6760;         /* facts, hints, anything secondary */
    --line: #e7e3db;          /* borders */
    --hair: #f1ede6;          /* rules between rows */
    /* Anything you can press or follow, inline: links, link-styled actions, the marker showing
       where a search landed. Two things deliberately do NOT take it, and this is the place that
       says so rather than leaving the next reader to "fix" them:
         - a solid button carries its affordance in its shape, so it stays ink;
         - tabs show position, not pressability, so the current one is ink and the rest muted.
       Nothing else may borrow it, and no ACTION may take a state colour instead. */
    --accent: #0f766e;
    /* A state, never an action: the count, the tab's dot, the waiting chip, a tick that cannot
       be cleared. The publish action used to take this, which made an action and the fact beside
       it the same colour while Save — equally an action — was another. */
    --unpublished: #a16207;
    --unpublished-fill: #fdf8ec;
    --unpublished-line: #e8d9b0;
    --danger: #a52a2a;        /* what cannot be undone: dropping a draft, a missing schema */
    --danger-fill: #fbf1ef;
    --danger-line: #e6cac4;
    --field-line: #d8d2c7;
    --focus: #0f766e;

    /* Metrics. One control height is what makes every field row line up, whatever it holds. */
    --control-h: 34px;
    --radius: 6px;
    --radius-lg: 10px;
    --type-sm: .8125rem;      /* toolbar, facts, chips, buttons */
    --type-base: .9375rem;    /* field values, body copy */
    --type-title: 1.15rem;    /* the page title */
  }

  /* The gutter stays whether or not the page needs a scrollbar. Filtering the list shortens it,
     the scrollbar goes, and without this everything slides sideways by its width. */
  html { scrollbar-gutter: stable; }
  body { font: var(--type-base)/1.5 system-ui, -apple-system, sans-serif; margin: 0;
         background: var(--ground); color: var(--ink); }
  main { max-width: 54rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  ul { list-style: none; padding: 0; margin: 0; }
  li + li { margin-top: .5rem; }

  /* ---------------------------------------------------------------- the page header
     Fixed row heights, rendered whether or not they hold anything, so the title sits at the
     same place on every page and navigating does not move it. */
  /* Every row is a fixed HEIGHT, not a minimum, and each states the line-height its content
     will use. A floor one pixel under the line box is not a floor: the row grew on the page
     that had more in it, so the title moved as you navigated. */
  .pagehead { margin-bottom: 1.25rem; }
  .pagehead .searchrow { display: flex; justify-content: flex-end; align-items: center;
                         height: var(--control-h); margin-bottom: .6rem; }
  /* The heading IS the trail: "Products › iam", with Products the way back. A separate crumb
     row said where you were above a heading that said it again, and cost a row of height. */
  .pagehead h1 a { color: var(--muted); text-decoration: none; }
  .pagehead h1 a:hover { color: var(--accent); text-decoration: underline; }
  .pagehead .crumb-sep { color: var(--line); font-weight: 400; margin: 0 .35rem; }
  .pagehead .titlerow { display: flex; align-items: center; justify-content: space-between;
                        gap: 1rem; height: 2.25rem; }
  .pagehead h1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pagehead h1 { font-size: var(--type-title); line-height: 2.25rem; font-weight: 600; margin: 0;
                 letter-spacing: -.01em; }
  .pagehead .facts { height: 1.25rem; line-height: 1.25rem; font-size: var(--type-sm);
                     color: var(--muted); white-space: nowrap; overflow: hidden;
                     text-overflow: ellipsis; }
  .pagehead .actions-right { display: flex; align-items: center; gap: 10px; }

  /* ---------------------------------------------------------------- surfaces */
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 1rem 1.15rem; margin-bottom: 1rem; }
  .banner { border-left: 3px solid var(--unpublished); background: var(--unpublished-fill); }
  /* The offer to move what was just published into the next environment: a thing to act on,
     not a state, so it takes the accent. */
  .offer { border-left: 3px solid var(--accent); }
  /* A banner that fills the top of the card it sits in, rather than floating inside it. */
  .inset { border: 0; border-left: 3px solid var(--unpublished); margin: -1rem -1.15rem 1rem;
           padding: .75rem 1.15rem; }
  .error { border-left: 3px solid var(--danger); background: var(--danger-fill); }
  /* NOT overflow: hidden. That rounds the corners and also clips every hover panel a row
     contains, cutting the detail off at the card's edge. The corners are rounded on the first
     and last rows instead. */
  .rows { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); }
  .rows > *:first-child { border-top-left-radius: var(--radius-lg); border-top-right-radius: var(--radius-lg); }
  .rows > *:last-child { border-bottom-left-radius: var(--radius-lg); border-bottom-right-radius: var(--radius-lg); }
  .row { display: flex; align-items: flex-start; gap: 14px; padding: 13px 16px; }
  .row + .row { border-top: 1px solid var(--hair); }

  /* ---------------------------------------------------------------- controls
     One height for everything a value is typed or chosen in, so rows line up whatever they
     hold. The switch keeps its own shape — the on/off read is the point of it — inside a row
     of the same height. */
  label { display: block; font-weight: 600; font-size: var(--type-sm); margin-bottom: .25rem; }
  .hint { color: var(--muted); font-size: .75rem; font-weight: 400; }
  .field { margin-bottom: 1rem; }
  input[type=text], input[type=password], input[type=number], input[type=search], select, textarea {
    width: 100%; height: var(--control-h); padding: 0 .6rem; border: 1px solid var(--field-line);
    border-radius: var(--radius); font: inherit; font-size: var(--type-base);
    background: var(--surface); color: var(--ink); box-sizing: border-box; }
  textarea { height: auto; padding: .5rem .6rem; }
  input[type=number] { max-width: 12rem; font-variant-numeric: tabular-nums; }
  select { max-width: 20rem; }
  input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
    outline: 2px solid var(--focus); outline-offset: 1px; }
  .err { color: var(--danger); font-size: .75rem; margin-top: .3rem; }

  button { background: var(--ink); color: var(--surface); border: 0; border-radius: var(--radius);
           height: var(--control-h); padding: 0 1rem; font: inherit; font-size: var(--type-sm);
           cursor: pointer; }
  .ghost { background: var(--surface); color: var(--ink); border: 1px solid var(--field-line); }
  /* Deliberately no font shorthand: it resets font-size to the inherited value, which overrode
     the size the base button rule sets — so a link action was one size inside the toolbar and
     another in the drafts list, the promote card and the product list. */
  /* Its own size, and its own box. Without a font-size a <button> took the base button rule's
     and an <a> inherited the body's, so Search sat beside Clear — and "Save 3 as a draft?"
     beside "Not now" — at two sizes, on two baselines, with their underlines at two heights. */
  .linkbtn { background: none; border: 0; padding: 0; height: auto; color: var(--accent);
             font-size: var(--type-sm); line-height: 1.4; display: inline-flex;
             align-items: center; text-decoration: underline; text-underline-offset: 3px;
             cursor: pointer; }
  .linkbtn:hover:not(:disabled) { color: var(--ink); }
  .linkbtn:disabled { color: var(--muted); text-decoration: none; cursor: not-allowed; }
  /* The consequential action — publishing, promoting — is heavier, not a different colour.
     Colour says what a thing IS: --accent is anything you can press, --unpublished is a state.
     Painting this one in the state colour made the publish action and the count it sits beside
     look like the same kind of thing, while Save, equally an action, looked like another. */
  .linkbtn.go { font-weight: 600; }
  /* A negative or destructive action — Drop, Not now, Clear — is danger-coloured. Accepting an
     offer and declining it were both --accent, so the two read as the same kind of move. A
     modifier only: size, box and underline stay with .linkbtn, because restating a size here is
     exactly what put Search and Clear on two baselines. */
  .linkbtn.no { color: var(--danger); }
  .linkbtn.no:hover:not(:disabled) { color: var(--ink); }
  /* The row kept for the outcome of the last write, between the search and the title. It is
     rendered on every page whether or not it holds anything and has a fixed height, so a notice
     appears in place rather than pushing the title and everything under it down the page.

     Not a banner: a bordered, filled block for one sentence shouted louder than the thing it
     reported. Underlined text carries it, and the colour says which kind of news it is --
     --accent for something that worked, --danger for something that did not. */
  .noticerow { height: 22px; display: flex; align-items: center; overflow: hidden; }
  .notice { display: inline-flex; align-items: baseline; gap: 10px; font-size: var(--type-sm);
            font-weight: 500; text-decoration: underline; text-underline-offset: 3px; }
  .notice.done { color: var(--accent); }
  .notice.problem { color: var(--danger); }
  .notice-dismiss { color: inherit; font-weight: 400; text-decoration: underline;
                    text-underline-offset: 3px; }
  .hidden-attr-guard {}
  /* The hidden attribute is only a UA "display: none", so any author display rule — the one on
     .selection, for instance — beats it and leaves a hidden element on screen. Everything the
     script hides is display-typed, which makes this the mechanism, not a nicety. */
  [hidden] { display: none !important; }

  /* ---------------------------------------------------------------- search */
  /* One row: the field, then its actions, all centred on the same line. */
  .search { display: flex; gap: 10px; align-items: center; }
  .search input[type=search] { width: 18rem; }


  /* ---------------------------------------------------------------- tabs */
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 1.25rem; }
  .tab { display: flex; align-items: center; gap: 7px; padding: 8px 14px; font-size: var(--type-sm);
         border-bottom: 2px solid transparent; color: var(--muted); text-decoration: none; }
  .tab.on { border-bottom-color: var(--ink); color: var(--ink); font-weight: 600; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--unpublished);
         display: inline-block; }

  /* What a key was, and what it is about to be, beside its name. */
  .wasnow { display: inline-flex; align-items: center; gap: 6px; font-size: var(--type-sm); }
  .wasnow .was { color: var(--muted); text-decoration: line-through; }
  .wasnow .arrow { color: var(--muted); }

  /* A product's name on the list: the one thing on that page you are looking for. */
  .pname { font-size: var(--type-base); font-weight: 600; }
  /* A line in the promote offer: what would move, and what is refused. */
  .moveline { font-size: var(--type-sm); display: flex; align-items: baseline; gap: 8px;
              flex-wrap: wrap; }
  .moveline strong { font-size: var(--type-base); }
  .moveline.blocked { color: var(--muted); }

  /* ---------------------------------------------------------------- chips and markers */
  .chip { font-size: .6875rem; padding: 2px 7px; border-radius: 4px; border: 1px solid var(--line);
          background: var(--ground); color: var(--muted); }
  .chip.wait { border-color: var(--unpublished-line); background: var(--unpublished-fill);
               color: var(--unpublished); }
  .chip.gone { border-color: var(--danger-line); background: var(--danger-fill); color: var(--danger); }
  .chip-item { display: inline-flex; align-items: center; gap: 6px; font-size: var(--type-sm);
               padding: 2px 9px; border-radius: 4px; border: 1px solid var(--line);
               background: var(--ground); }

  /* Hover detail. No script: :hover and :focus-within are enough, and a keyboard reaches it. */
  .pending { position: relative; display: inline-flex; align-items: center; gap: 5px;
             font-size: var(--type-sm); color: var(--unpublished); cursor: help; }
  /* Above the trigger, not below: opening downward covered the value field the panel is
     describing, which is the one thing you are looking at when you open it. */
  .detail { display: none; position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 5;
            width: 320px; background: var(--surface); border: 1px solid var(--line);
            border-radius: var(--radius); padding: 10px 12px;
            box-shadow: 0 6px 18px rgba(28,27,25,.10); color: var(--ink); font-weight: 400;
            cursor: default; }
  .pending:hover .detail, .pending:focus-within .detail { display: block; }
  .detail h3 { font-size: .6875rem; text-transform: uppercase; letter-spacing: .02em;
               color: var(--muted); margin: 0 0 .5rem; }
  .detail .was { color: var(--muted); text-decoration: line-through; }
  .detail .is { color: var(--ink); }

  /* ---------------------------------------------------------------- the toolbar */
  .actions { font-size: var(--type-sm); }
  .actionslot { min-height: 3.35rem; }
  .actionslot .card { margin-bottom: 0; }
  .actionline { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .actionline input, .actionline code { font-size: inherit; }
  .actionline .count { color: var(--unpublished); }
  .actionline .idle { color: var(--muted); }
  .sep { color: var(--muted); }
  .selection { display: inline-flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  /* The selection count is a hover trigger like the others, but it is ordinary running text
     rather than a marker — it states what you are about to do, not a warning. */
  .pending.sel { color: inherit; font-size: inherit; }

  /* ---------------------------------------------------------------- key rows */
  .keyline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: .25rem; }
  .keyrow { display: flex; align-items: flex-start; gap: 14px; min-height: var(--control-h); }
  .keypick { width: 16px; flex-shrink: 0; padding-top: 9px; }
  .keypick input, .pick { width: 16px; height: 16px; accent-color: var(--ink); cursor: pointer;
                          margin: 0; }
  .pick { margin-top: 3px; }
  /* A tick on a value you have actually changed cannot be cleared — the change goes with the
     draft either way. It must not look like an ordinary box that failed to respond. */
  .keypick input.locked { accent-color: var(--unpublished); cursor: not-allowed; }
  .keypick input:disabled { accent-color: var(--line); cursor: not-allowed; opacity: .55; }
  /* Where a search result landed: a rule in the margin rather than a scroll nobody asked for.
     In the accent, because it marks where you are looking — it is not a state of the file. */
  .found { border-left: 3px solid var(--accent); margin-left: -1.15rem;
           padding-left: calc(1.15rem - 3px); }

  /* The switch reflects the checkbox, not a class the server rendered: with no script on the
     page a server-rendered state cannot move when you click it. */
  .switch { display: inline-flex; align-items: center; gap: 9px; cursor: pointer;
            font-size: var(--type-base); height: var(--control-h); }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .track { width: 34px; height: 20px; border-radius: 10px; background: var(--field-line);
           position: relative; flex-shrink: 0; transition: background .12s ease; }
  .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
          background: var(--surface); transition: transform .12s ease; }
  .switch input:checked ~ .track { background: var(--ink); }
  .switch input:checked ~ .track .knob { transform: translateX(14px); }
  .switch input:focus-visible ~ .track { outline: 2px solid var(--focus); outline-offset: 2px; }
  /* The word beside it is generated too, for the same reason. */
  .switch .state::after { content: 'false'; }
  .switch input:checked ~ .state::after { content: 'true'; }

  /* Hover peek on a key name — same mechanics as the pending detail, no script. */
  .peek { position: relative; display: inline-flex; cursor: help;
          border-bottom: 1px dotted var(--field-line); }
  .peek .detail { bottom: calc(100% + 6px); }
  .peek:hover .detail, .peek:focus-within .detail { display: block; }
  .detail .envname { color: var(--muted); font-size: .75rem; }

  /* ---------------------------------------------------------------- a write in flight
     htmx sets .htmx-request on the element that issued the request and removes it when the
     request ends — including when it ends by replacing that element — so the running state
     cannot outlive its request the way a script-driven one can. */
  .running { display: none; align-items: center; gap: 6px; }
  .htmx-request .resting { display: none; }
  .htmx-request .running { display: inline-flex; }
  .htmx-request { cursor: progress; }
  .spinner { width: 11px; height: 11px; border: 2px solid currentColor;
             border-right-color: transparent; border-radius: 50%; display: inline-block;
             animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
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
        ? html`<span class="wasnow">
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
  /**
   * Where this action posts. Given, the BUTTON issues the request rather than the form around
   * it, which is the whole point: htmx marks the issuing element with .htmx-request, and
   * `.htmx-request .resting` then matches this button alone.
   *
   * With the request on the form the class landed on the form, so the toolbar's two actions --
   * Save and Publish share one form -- both showed a spinner whichever was pressed, and the
   * global publish, whose button sits in the header and submits through `form=`, was outside
   * the form and showed none at all.
   */
  post?: string;
  /**
   * What to send with it. The button is not the form, so the fields have to be named: "closest
   * form" for an action inside one, an id for the header action that submits a form it is not in.
   */
  include?: string;
  /**
   * The intent, as htmx values. A submit button's name and value are sent when the FORM submits;
   * when the button issues the request they are not, so an intent left as name/value would
   * simply be missing and the route would have to guess.
   */
  vals?: string;
}): SafeHtml {
  // The form keeps its own method, action and hx-post: this is progressive enhancement, so a
  // keyboard submit and a no-JS browser must still work. htmx handles the click on a button that
  // carries hx-post and the form's submit never fires, so a click makes exactly one request.
  const request = options.post
    ? html`hx-post="${options.post}" hx-target="#page" hx-swap="innerHTML" hx-include="${
        options.include ?? 'closest form'
      }"${options.vals ? raw(` hx-vals='${options.vals}'`) : html``}`
    : html``;
  return html`<button type="submit" class="${options.className ?? 'linkbtn'}" ${request} ${options.attributes ?? html``}>
    <span class="resting">${options.resting}</span>
    <span class="running"><span class="spinner"></span>${options.running}</span>
  </button>`;
}

/**
 * One notice, in one place, on every page.
 *
 * It used to be a plain card in the body of whichever page produced it: the same weight whether
 * it reported a publish or a failure, nothing to close it, and a confirmation that stayed until
 * the next navigation while an error could be swept away by the same timer as a success.
 *
 * A confirmation is transient — `data-transient` is what the script removes after five seconds —
 * and a problem is not, because an error nobody read is an error nobody handled. Both can be
 * dismissed, and the dismiss is a link back to the same page without the outcome code, so it
 * works with no script at all; htmx upgrades it to a swap.
 */
export interface PageNotice {
  readonly tone: 'done' | 'problem';
  readonly text: string;
}

function noticeLine(notice: PageNotice | undefined, dismissTo: string): SafeHtml {
  if (!notice) return html``;
  const done = notice.tone === 'done';
  return html`<span class="notice ${done ? 'done' : 'problem'}" data-notice ${
    done ? raw('data-transient') : html``
  }><span class="notice-text">${notice.text}</span><a class="notice-dismiss" data-dismiss
      href="${dismissTo}" hx-get="${dismissTo}" hx-target="#page" hx-swap="innerHTML"
      hx-push-url="true">Dismiss</a></span>`;
}

/**
 * The page header, identical on every page that has one.
 *
 * Each page used to grow its own — an h1 in a flex row here, a breadcrumb and a separate facts
 * line there, no facts at all on a third — so navigating moved the title down the page and
 * across it. Every row is rendered whether or not it holds anything, and each carries a fixed
 * height in CSS, which is what keeps the title in the same place from page to page.
 */
function pageHeader(options: {
  /** The heading, which doubles as the trail: "Products › iam". */
  title: SafeHtml;
  /** One muted line: what this page is looking at. */
  facts?: SafeHtml;
  /** Page-level actions, right-aligned on the title row. */
  actions?: SafeHtml;
  /** The search box, top right. Rendered only where searching does something. */
  search?: SafeHtml;
  /** The outcome of the last write, in the row kept for it. */
  notice?: PageNotice;
  /** Where "dismiss" goes: this page, without the outcome code. */
  dismissTo?: string;
}): SafeHtml {
  return html`<div class="pagehead">
    <div class="searchrow">${options.search ?? html``}</div>
    <!-- Rendered whether or not it holds anything. A notice that appears in a row created for it
         pushes the title, the tabs and every row below down the page as it arrives and back up
         as it clears; the reserved row is what makes it appear in place instead. -->
    <div class="noticerow">${noticeLine(options.notice, options.dismissTo ?? '/')}</div>
    <div class="titlerow">
      <h1>${options.title}</h1>
      <div class="actions-right">${options.actions ?? html``}</div>
    </div>
    <div class="facts">${options.facts ?? html``}</div>
  </div>`;
}

/**
 * The heading of a page below the landing one, which is also the way back to it.
 *
 * There is no separate breadcrumb: one said where you were directly above a heading that said it
 * again, and cost a row of the header's height to do it. The last item is where you are and is
 * not a link — there is nowhere for it to go.
 */
function trail(here: string): SafeHtml {
  return html`<a href="/" hx-get="/" hx-target="#page" hx-swap="innerHTML"
      hx-push-url="true">Products</a><span class="crumb-sep">›</span><span>${here}</span>`;
}

/**
 * The search box.
 *
 * A plain GET form: it works with the script disabled, the address bar carries the search, and a
 * result can be linked to. `hx-get` makes it a swap when the script is there.
 */
function searchBox(options: { action: string; query: string; placeholder: string }): SafeHtml {
  return html`<form class="search" method="get" action="${options.action}"
        hx-get="${options.action}" hx-target="#page" hx-swap="innerHTML" hx-push-url="true">
    <input type="search" name="q" value="${options.query}" placeholder="${options.placeholder}"
           aria-label="${options.placeholder}">
    ${writeAction({ resting: html`Search`, running: 'Searching…' })}
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
  notice?: PageNotice;
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
            ${writeAction({
              className: 'linkbtn no',
              post: '/drafts/drop',
              resting: html`Drop`,
              running: 'Dropping…',
            })}
          </form>
        </div>`,
      )}
    </div>`,
  );

  const body = html`
      ${pageHeader({
        ...(options.notice ? { notice: options.notice } : {}),
        dismissTo: '/drafts',
        title: trail('Unpublished drafts'),
        facts: html`${options.drafts.length} namespace${
          options.drafts.length === 1 ? '' : 's'
        } with unpublished work`,
      })}
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
  notice?: PageNotice;
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
      <input type="checkbox" name="namespace" value="${product.service}" class="pick">
      <div style="display:flex;flex-direction:column;gap:4px;flex-grow:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:10px;">
          ${
            product.schemaMissing
              ? html`<span class="pname">${product.name}</span>
                  <span class="chip wait" title="schema/${product.service}.yaml is absent"
                    >schema is missing</span>`
              : html`<a href="/p/${product.service}" hx-get="/p/${product.service}" hx-target="#page"
                  hx-swap="innerHTML" hx-push-url="true"
                  class="pname">${product.name}</a>`
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
      <!-- The header is rendered OUTSIDE the publish form. A form inside another form is
           dropped by every parser, which is how the search box came to belong to the publish
           form and a Search click came to publish. The header's publish action reaches its form
           by id instead, which needs no script. -->
      ${pageHeader({
        ...(options.notice ? { notice: options.notice } : {}),
        dismissTo: options.query ? `/?q=${encodeURIComponent(options.query)}` : '/',
        title: html`Products`,
        search: searchBox({
          action: '/',
          query: options.query ?? '',
          placeholder: 'Find a variable',
        }),
        facts: html`${
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
        }`,
        actions:
          totalDrafts > 0
            ? writeAction({
                className: 'linkbtn go',
                attributes: html`form="publish-products"`,
                post: '/publish',
                include: '#publish-products',
                resting: html`Publish selected drafts?`,
                running: 'Publishing…',
              })
            : html``,
      })}
      ${
        options.query && options.products.length === 0
          ? html`<div class="card">No key matches “${options.query}”.</div>`
          : html``
      }
      <form id="publish-products" method="post" action="/publish" hx-post="/publish"
            hx-target="#page" hx-swap="innerHTML">

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
  notice?: PageNotice;
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


      ${pageHeader({
        ...(options.notice ? { notice: options.notice } : {}),
        dismissTo: `/p/${options.service}?env=${encodeURIComponent(options.active)}`,
        title: trail(options.service),
        search: searchBox({
          action: `/p/${options.service}`,
          query: options.query ?? '',
          placeholder: `Find a variable in ${options.service}`,
        }),
        facts: html`${options.environments.length} environment${
          options.environments.length === 1 ? '' : 's'
        } · serving ${
          options.repoWebUrl
            ? html`<a href="${options.repoWebUrl}/commit/${options.commit}" target="_blank"
                rel="noreferrer"><code>${options.commit.slice(0, 8)}</code></a>`
            : html`<code>${options.commit.slice(0, 8)}</code>`
        }`,
        actions:
          productDrafts === 0
            ? html``
            : html`<form method="post" action="/publish" style="display:flex;">
                <!-- The service, not its environments. Posting every declared environment made
                     publish() abort on the first one with nothing staged, which is the ordinary
                     case; the route resolves a bare service to the environments that actually
                     hold drafts, at request time, so the scope cannot be stale. -->
                <input type="hidden" name="namespace" value="${options.service}">
                ${writeAction({
                  className: 'linkbtn go',
                  post: '/publish',
                  resting: html`Publish all ${productDrafts} draft${
                    productDrafts === 1 ? '' : 's'
                  } in ${options.service}?`,
                  running: 'Publishing…',
                })}
              </form>`,
      })}

      <div class="tabs">${tabs}</div>
      ${
        query && shownRows.length === 0
          ? html`<div class="card">No key in ${options.service} matches “${options.query}”.</div>`
          : html``
      }
      ${promoteOffer(options)}
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
                  : html`<div class="card banner">
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
                        <a class="linkbtn no"
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
                  post: `/p/${options.service}/${options.active}`,
                  vals: '{"intent":"save"}',
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
                          post: `/p/${options.service}/${options.active}`,
                          vals: '{"intent":"publish"}',
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
    (change) => html`<div class="moveline">
      <strong>${change.key}</strong>
      <span class="hint">${offer.nextEnvironment} has</span>
      <span class="was">${format(change.target)}</span>
      <span class="arrow">→</span>
      <span>${format(change.value)}</span>
    </div>`,
  );

  const blocked = offer.blocked.map(
    (entry) => html`<div class="moveline blocked">
      <strong>${entry.key}</strong> — ${entry.reason}
    </div>`,
  );

  const hidden = offer.movable.map(
    (change) => html`<input type="hidden" name="key" value="${change.key}">`,
  );

  return html`<div class="card offer">
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
      <a class="linkbtn no" href="/p/${options.service}?env=${options.active}">Not now</a>
    </form>
  </div>`;
}
