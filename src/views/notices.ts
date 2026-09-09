/**
 * The wording of every notice, owned by the server.
 *
 * A notice used to travel as free text in the URL — `/?notice=Published%202%20change(s)` — so a
 * link could render any words at all inside the console, in its own voice. The text was escaped,
 * so this was never a script injection; it was worse in a quieter way, because a message that
 * looks like the product's own is believed. The same text also replayed on reload, showing a
 * confirmation for something that had happened once, minutes ago.
 *
 * So the URL carries a CODE and nothing else. This module is the only place a notice is worded,
 * an unknown code renders nothing, and a count that is not a plain positive integer is dropped
 * rather than shown.
 */
export type NoticeTone = 'done' | 'problem';

export interface Notice {
  readonly tone: NoticeTone;
  readonly text: string;
}

/** Everything the console knows how to say, and how long it should stay. */
const WORDING: Record<string, (count: number | null) => Notice> = {
  published: (count) => ({
    tone: 'done',
    text: count === null ? 'Published.' : `Published ${count} change${count === 1 ? '' : 's'}.`,
  }),
  'published-unpushed': (count) => ({
    tone: 'problem',
    text:
      count === null
        ? 'Published, but not yet pushed to GitHub.'
        : `Published ${count} change${count === 1 ? '' : 's'}, but not yet pushed to GitHub.`,
  }),
  'publish-failed': () => ({
    tone: 'problem',
    text: 'Publishing failed. Nothing was published.',
  }),
  // Distinct from a generic failure, and the distinction is the whole point: the draft is fine,
  // the repository moved under it, and what to do about it is different.
  'publish-stale': () => ({
    tone: 'problem',
    text: 'The repository changed since this draft was made, so nothing was published. Reload and check the values before publishing again.',
  }),
  'nothing-selected': () => ({
    tone: 'problem',
    text: 'Nothing selected had unpublished changes.',
  }),
  drafted: (count) => ({
    tone: 'done',
    text:
      count === null
        ? 'Saved as a draft.'
        : `Saved ${count} change${count === 1 ? '' : 's'} as a draft.`,
  }),
  dropped: () => ({ tone: 'done', text: 'Draft dropped.' }),
  created: () => ({
    tone: 'done',
    text: 'Drafted this environment from the schema defaults. Nothing is published yet.',
  }),
  'create-failed': () => ({ tone: 'problem', text: 'That environment could not be created.' }),
  'nothing-staged': () => ({
    tone: 'problem',
    text: 'Nothing to save — no value was edited and nothing was ticked.',
  }),
  // The environment it landed in is the one now on screen, so the wording does not name it:
  // a name taken from the URL is exactly the free text this module exists to keep out.
  promoted: (count) => ({
    tone: 'done',
    text:
      count === null
        ? 'Staged for promotion. Nothing is published here yet.'
        : `Staged ${count} change${count === 1 ? '' : 's'}. Nothing is published here yet.`,
  }),
  'promote-failed': () => ({ tone: 'problem', text: 'Nothing could be promoted.' }),
  'drop-failed': () => ({ tone: 'problem', text: 'That draft could not be dropped.' }),
};

/**
 * A count arriving from a query string is whatever someone typed. Only a plain non-negative
 * integer is a count; everything else is dropped, and the wording falls back to the form that
 * needs no number rather than printing "NaN change(s)".
 */
function countOf(value: number | undefined): number | null {
  if (value === undefined) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function noticeFor(code: string | undefined, options?: { n?: number }): Notice | null {
  if (!code) return null;
  const wording = Object.hasOwn(WORDING, code) ? WORDING[code] : undefined;
  return wording ? wording(countOf(options?.n)) : null;
}
