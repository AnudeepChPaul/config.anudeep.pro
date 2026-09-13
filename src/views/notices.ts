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
 *
 * Save is live; git sync is a back-up. Nothing here says "Publish" or implies a saved change is
 * not yet in effect.
 */
export type NoticeTone = 'done' | 'problem';

export interface Notice {
  readonly tone: NoticeTone;
  readonly text: string;
}

/** Everything the console knows how to say, and how long it should stay. */
const WORDING: Record<string, (count: number | null) => Notice> = {
  saved: () => ({
    tone: 'done',
    text: 'Live now.',
  }),
  created: () => ({
    tone: 'done',
    text: 'Created from schema defaults. Live now.',
  }),
  'create-failed': () => ({ tone: 'problem', text: 'That environment could not be created.' }),
  retiring: () => ({
    tone: 'done',
    text: 'Marked as retiring. Consumers can see it immediately.',
  }),
  'retirement-cancelled': () => ({
    tone: 'done',
    text: 'Retirement cancelled. The product is active again.',
  }),
  'retire-failed': () => ({ tone: 'problem', text: 'That product could not be marked.' }),
  archived: () => ({
    tone: 'done',
    text: 'Archived. It is no longer served, and everything it held is in archived/.',
  }),
  // The environment it landed in is the one now on screen, so the wording does not name it:
  // a name taken from the URL is exactly the free text this module exists to keep out.
  promoted: (count) => ({
    tone: 'done',
    text:
      count === null
        ? 'Promoted. Live now.'
        : `Promoted ${count} key${count === 1 ? '' : 's'}. Live now.`,
  }),
  'promote-failed': () => ({ tone: 'problem', text: 'Nothing could be promoted.' }),
  deleted: (count) => ({
    tone: 'done',
    text:
      count === null
        ? 'Keys removed from the schema and every environment.'
        : `Removed ${count} key${count === 1 ? '' : 's'} from the schema and every environment.`,
  }),
  'delete-failed': () => ({ tone: 'problem', text: 'Those keys could not be removed.' }),
  'backed-up': (count) => ({
    tone: 'done',
    text:
      count === null
        ? 'Backed up to git.'
        : `Backed up ${count} change${count === 1 ? '' : 's'} to git.`,
  }),
  'backup-failed': () => ({
    tone: 'problem',
    text: 'Back-up failed. The live values are unchanged; try again.',
  }),
  'backup-deferred': () => ({
    tone: 'problem',
    text: 'Saved locally but not yet on the remote. Retry will keep trying.',
  }),
  'backup-no-remote': () => ({
    tone: 'problem',
    text: 'No git remote is configured, so nothing was pushed.',
  }),
  'keys-added': (count) => ({
    tone: 'done',
    text:
      count === null
        ? 'Variables added. Live now.'
        : `Added ${count} variable${count === 1 ? '' : 's'}. Live now.`,
  }),
  'nothing-selected': () => ({
    tone: 'problem',
    text: 'Select keys for Promote or Delete.',
  }),
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
