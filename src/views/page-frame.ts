import { html, raw, type SafeHtml } from '@config/src/views/html.js';
export const layout = (
  title: string,
  body: SafeHtml,
  settingsLink = false,
  build = '',
): SafeHtml => html`<!doctype html>
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
    --type-xs: .75rem;         /* a reference table: settings, read by scanning */
    --type-sm: .8125rem;      /* toolbar, facts, chips, buttons */
    --type-base: .9375rem;    /* field values, body copy */
    --type-title: 1.15rem;    /* the page title */
  }

  /* The gutter stays whether or not the page needs a scrollbar. Filtering the list shortens it,
     the scrollbar goes, and without this everything slides sideways by its width. */
  html { scrollbar-gutter: stable; }
  body { font: var(--type-base)/1.5 system-ui, -apple-system, sans-serif; margin: 0;
         background: var(--ground); color: var(--ink); }
  main { max-width: 54rem; margin: 0 auto; padding: 1.5rem 1rem 0.5rem 4rem; }
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
  /* The add-product form: fields side by side where they belong together, and each key in its
     own card so a schema of several keys reads as a list rather than one long column. */
  .fieldrow { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-bottom: 1rem; }
  .fieldrow:last-child { margin-bottom: 0; }
  .fieldrow .field { flex: 1 1 12rem; margin-bottom: 0; }
  .fieldrow .field.wide { flex-basis: 100%; }
  .fieldlabel { display: block; font-size: var(--type-sm); font-weight: 500; margin-bottom: 0; }
  .fieldlabel .hint { font-weight: 400; }
  .checkfield { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .checkfield input { width: 16px; height: 16px; accent-color: var(--ink); }
  .checkfield .fieldlabel { margin: 0; }
  .keydraft { margin-bottom: 12px; }
  .actionline { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .discard-ask, .archive-ask { display: inline-flex; align-items: center; gap: 10px;
                 font-size: var(--type-sm); color: var(--danger); }
  /* Not danger: bringing a product back takes nothing away. */
  .act-ask { display: inline-flex; align-items: center; gap: 10px;
             font-size: var(--type-sm); color: var(--muted); }
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
  /* Dismissing is a negative action, so it is --danger like Drop, Not now and Clear -- the
     operator's rule, and the one place it was not being applied: inheriting the line's colour
     painted it as an ordinary action whenever the news was good. .linkbtn carries the colour
     and the underline; only the weight is local, so the message stays the heavier of the two. */
  .notice .linkbtn.no { font-weight: 400; }
  /* The footer carries the one link that is not part of the working surface. Outside #page, so
     an htmx swap leaves it alone, and quiet enough not to compete with the page above it. */
  /* Centred, because it belongs to the page rather than to a column of it, and small: the
     build is read once during an incident and never again. */
  .pagefoot { max-width: 62rem; margin: 0 auto; padding: 18px 24px 28px;
              font-size: var(--type-xs); display: flex; justify-content: center;
              align-items: center; gap: 10px; color: var(--muted); }
  .pagefoot .build { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pagefoot a { color: var(--muted); text-decoration: underline; text-underline-offset: 3px; }
  .pagefoot a:hover { color: var(--accent); }
  /* A value read out of the environment: monospace, because a path or a remote is read
     character by character, and that is the whole reason for the page. */
  .settings-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    font-size: var(--type-xs); overflow-wrap: anywhere; }
  /* A reference table, read by scanning: one step down from body copy, and the name and the
     value at the SAME size so the eye can move between the two columns without resizing. */
  .keyname { font-weight: 500; min-width: 18rem; font-size: var(--type-xs); line-height: 2rem; }
  .settings-unset { font-size: var(--type-xs); color: var(--muted); }
  /* The inset the .card used to supply. Dropping the card removed the duplicated border and
     took the padding with it, leaving every row flush against the edge. */
  .settings-row { padding: 7px 16px; }
  .settings-row + .settings-row { border-top: 1px solid var(--hair); }
  .tabadd { display: inline-flex; align-items: center; gap: 10px; margin-left: 12px; }
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

  /* A flag and its switch on one line: the name takes the room, the switch keeps its size. */
  .feature-row { align-items: center; padding: 1rem; margin: 0; display: flex; justify-content: space-between; }
  .feature-name { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
  .feature-switch { flex-shrink: 0; margin-bottom: 0; }
  .feature-switch label { margin-bottom: 0; }

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
  .actionline { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; flex-direction: row-reverse; justify-content: end }
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
  .keyrow { display: flex; align-items: center; gap: 14px; min-height: var(--control-h); }
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

${
  build || settingsLink
    ? html`<footer class="pagefoot">${build ? html`<span class="build">${build}</span>` : html``}${
        settingsLink
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
    ? html`hx-post="${options.post}" hx-target="#page" hx-swap="innerHTML" hx-include="${
        options.include ?? 'closest form'
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
  return html`<span class="notice ${done ? 'done' : 'problem'}" data-notice ${
    done ? raw('data-transient') : html``
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
}): SafeHtml {
  return html`<div class="pagehead">
    <div class="searchrow">${options.search ?? html``}</div>
    
    <div class="noticerow">${noticeLine(options.notice, options.dismissTo ?? '/')}</div>
    <div class="titlerow">
      <h1>${options.title}</h1>
      <div class="actions-right">${options.actions ?? html``}</div>
    </div>
    <div class="facts">${options.facts ?? html``}</div>
  </div>`;
}

export function trail(here: string): SafeHtml {
  return html`<a href="/" hx-get="/" hx-target="#page" hx-swap="innerHTML"
      hx-push-url="true">Products</a><span class="crumb-sep">›</span><span>${here}</span>`;
}

export function consoleTabs(active: 'products' | 'features'): SafeHtml {
  return html`<nav class="tabs" aria-label="Console sections">
    <a class="tab ${active === 'products' ? 'on' : ''}" href="/" hx-get="/" hx-target="#page"
       hx-swap="innerHTML" hx-push-url="true">products</a>
    <a class="tab ${active === 'features' ? 'on' : ''}" href="/features" hx-get="/features"
       hx-target="#page" hx-swap="innerHTML" hx-push-url="true">features</a>
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
