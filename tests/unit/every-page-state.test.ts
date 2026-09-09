import {
  type KeyRow,
  renderDrafts,
  renderLogin,
  renderProduct,
  renderProducts,
} from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

/**
 * Every page, in every state it can be in.
 *
 * The styling tests before this one checked two states — a product list with drafts and a
 * product page with a pending change — so the states nobody rendered kept their pre-revamp
 * colours: the offer to create a missing environment and the promote card were still drawn in
 * the old amber and blue, and "Not now" was styled as a hint rather than as the action it is.
 *
 * A rule is only enforced where it is looked at, so this looks everywhere.
 */
const definition = (over: Record<string, unknown> = {}) =>
  ({ type: 'string', secret: false, ...over }) as unknown as KeyRow['definition'];

const env = (name: string, drafts: number, pending: KeyRow[] = []) => ({
  name,
  namespace: `iam/${name}`,
  drafts,
  pending: pending as never,
});
const pending = [{ key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all', secret: false }] as never;

const rows: KeyRow[] = [
  { key: 'FP_COMPONENTS', definition: definition({ type: 'string[]' }), value: ['ua', 'lang'] },
  { key: 'KILL_PASSWORD_LOGIN', definition: definition({ type: 'bool' }), value: false },
  {
    key: 'MFA_ENFORCEMENT',
    definition: definition({ type: 'enum', values: ['optional', 'admins', 'all'] }),
    value: 'all',
    publishedValue: 'optional',
    pending: true,
  },
  { key: 'SESSION_TTL', definition: definition({ type: 'int', min: 60, max: 86400 }), value: 900 },
  { key: 'SMTP_PASSWORD', definition: definition({ secret: true }), value: 'x' },
];

const commit = 'a02ecef1234567890abcdef1234567890abcdef12';

/** Every state the console can render, named so a failure says which one. */
const everyState = (): Array<[string, string]> => [
  ['products, empty', String(renderProducts({ products: [], commit, draftCount: 0 }))],
  [
    'products, drafts and a missing schema',
    String(
      renderProducts({
        products: [
          {
            name: 'iam (1002)',
            service: 'iam',
            keys: 'A, B +3',
            environments: [env('dev', 2, pending), env('prod', 0)],
          },
          {
            name: 'audit (1004)',
            service: 'audit',
            schemaMissing: true,
            keys: '',
            environments: [env('prod', 0)],
          },
        ],
        commit,
        draftCount: 2,
      }),
    ),
  ],
  [
    'products, searching',
    String(
      renderProducts({
        products: [
          {
            name: 'iam (1002)',
            service: 'iam',
            matched: ['SESSION_TTL'],
            keys: '',
            environments: [env('dev', 0)],
          },
        ],
        commit,
        query: 'TTL',
      }),
    ),
  ],
  [
    'product, clean',
    String(
      renderProduct({
        service: 'iam',
        environments: [env('dev', 0), env('prod', 0)],
        active: 'dev',
        rows,
        commit,
        revision: 3,
      }),
    ),
  ],
  [
    'product, drafted',
    String(
      renderProduct({
        service: 'iam',
        environments: [env('dev', 2, pending), env('prod', 0)],
        active: 'dev',
        rows,
        commit,
        drafted: ['MFA_ENFORCEMENT'],
        revision: 3,
      }),
    ),
  ],
  [
    'product, refused save',
    String(
      renderProduct({
        service: 'iam',
        environments: [env('dev', 0)],
        active: 'dev',
        rows,
        commit,
        error: 'the change does not match the schema',
      }),
    ),
  ],
  [
    'product, environment with no file',
    String(
      renderProduct({
        service: 'api',
        environments: [{ name: 'dev', namespace: 'api/dev', drafts: 0, pending: [] }],
        active: 'dev',
        rows: [{ key: 'RATE_LIMIT', definition: definition({ type: 'int' }), value: 100 }],
        commit,
        missingFile: true,
      }),
    ),
  ],
  [
    'product, promote offer',
    String(
      renderProduct({
        service: 'iam',
        environments: [env('dev', 0), env('prod', 0)],
        active: 'dev',
        rows,
        commit,
        offer: {
          nextEnvironment: 'prod',
          movable: [{ key: 'MFA_ENFORCEMENT', value: 'all', target: 'optional' }],
          blocked: [{ key: 'SMTP_PASSWORD', reason: 'secret — set it directly in prod' }],
        },
      }),
    ),
  ],
  // A page reporting an outcome is a state like any other, and it was missing here: the rule
  // that every negative action is danger-coloured could not see Dismiss, because nothing in
  // this list rendered one.
  [
    'products, reporting a success',
    String(
      renderProducts({
        products: [],
        commit,
        notice: { tone: 'done', text: 'Published 3 changes.' },
      }),
    ),
  ],
  [
    'product, reporting a failure',
    String(
      renderProduct({
        service: 'iam',
        environments: [env('dev', 0), env('prod', 0)],
        active: 'dev',
        rows,
        commit,
        revision: 3,
        notice: { tone: 'problem', text: 'Publishing failed. Nothing was published.' },
      }),
    ),
  ],
  ['drafts, empty', String(renderDrafts({ drafts: [] }))],
  [
    'drafts, some',
    String(
      renderDrafts({
        drafts: [
          {
            namespace: 'iam/dev',
            saves: [{ keys: ['A'], actor: 'me@anudeep.pro', at: Date.now() - 3_600_000 }],
          },
        ],
      }),
    ),
  ],
  [
    'login, identity provider up',
    String(renderLogin({ iamReachable: true, iamConfigured: true, iamLoginUrl: '/login/iam' })),
  ],
  [
    'login, break-glass open',
    String(renderLogin({ iamReachable: false, iamConfigured: true, iamLoginUrl: '/login/iam' })),
  ],
];

const bodyOf = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '');

describe('the rules hold in every state, not just the ones anyone looked at', () => {
  it('names no colour inline', () => {
    for (const [name, html] of everyState()) {
      expect(bodyOf(html).match(/style="[^"]*#[0-9a-fA-F]{3,8}/g) ?? [], name).toEqual([]);
    }
  });

  it('names no type size inline', () => {
    for (const [name, html] of everyState()) {
      expect(bodyOf(html).match(/style="[^"]*font-size/g) ?? [], name).toEqual([]);
    }
  });

  it('styles no action as a hint', () => {
    // A hint is a size smaller and muted. An action that looks like one sits on a different
    // baseline from the action beside it, which is what made Search and Clear look misaligned.
    for (const [name, html] of everyState()) {
      expect(
        bodyOf(html).match(/class="hint"[^>]*>\s*(Clear|Not now|Cancel)/g) ?? [],
        name,
      ).toEqual([]);
    }
  });

  // Colouring the rule is not colouring the control: the modifier only reaches a negative action
  // if every one of them wears it, in every state that renders one.
  it('marks every negative action as negative', () => {
    for (const [name, html] of everyState()) {
      const negatives =
        bodyOf(html).match(/<(?:a|button)[^>]*>[\s\S]{0,120}?(?:Not now|Clear|Drop|Dismiss)\b/g) ??
        [];
      for (const control of negatives) {
        expect(control, `${name}: ${control}`).toMatch(/class="linkbtn no"/);
      }
    }
  });

  it('gives every page exactly one heading', () => {
    for (const [name, html] of everyState()) {
      expect((bodyOf(html).match(/<h1/g) ?? []).length, name).toBe(1);
    }
  });
});
