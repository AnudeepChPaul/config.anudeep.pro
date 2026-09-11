import {
  type KeyRow,
  renderConfirmation,
  renderFeatures,
  renderLogin,
  renderNewProduct,
  renderProduct,
  renderProducts,
  renderSettings,
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
 *
 * The draft states are gone with the direct-write cutover; the states that replaced them --
 * a confirmation, the features screen, a product whose environment file does not exist yet --
 * are listed here in their place, so the list still covers every screen the console can draw.
 */
const definition = (over: Record<string, unknown> = {}) =>
  ({ type: 'string', secret: false, ...over }) as unknown as KeyRow['definition'];

const rows: KeyRow[] = [
  { key: 'FP_COMPONENTS', definition: definition({ type: 'string[]' }), value: ['ua', 'lang'] },
  { key: 'KILL_PASSWORD_LOGIN', definition: definition({ type: 'bool' }), value: false },
  {
    key: 'MFA_ENFORCEMENT',
    definition: definition({ type: 'enum', values: ['optional', 'admins', 'all'] }),
    value: 'all',
  },
  { key: 'SESSION_TTL', definition: definition({ type: 'int', min: 60, max: 86400 }), value: 900 },
  { key: 'SMTP_PASSWORD', definition: definition({ secret: true }), value: 'x' },
];

const product = (over: Partial<Parameters<typeof renderProduct>[0]> = {}) =>
  String(
    renderProduct({
      service: 'iam',
      environment: 'dev',
      environments: ['dev', 'prod'],
      etag: 'e',
      rows,
      version: 3,
      next: 'prod',
      retiring: false,
      missing: false,
      ...over,
    }),
  );

/** Every state the console can render, named so a failure says which one. */
const everyState = (): Array<[string, string]> => [
  ['products, empty', String(renderProducts({ products: [] }))],
  [
    'products, a retiring one and pending sync',
    String(
      renderProducts({
        products: [
          { name: 'iam', environments: ['dev', 'prod'], retiring: false, keys: ['A', 'B'] },
          { name: 'audit', environments: ['prod'], retiring: true, keys: [] },
        ],
        showSyncNow: true,
      }),
    ),
  ],
  [
    'products, searching',
    String(
      renderProducts({
        products: [{ name: 'iam', environments: ['dev'], retiring: false, keys: ['SESSION_TTL'] }],
        query: 'TTL',
      }),
    ),
  ],
  [
    'products, retiring only',
    String(renderProducts({ products: [], retiringOnly: true })),
  ],
  ['product, clean', product()],
  ['product, retiring', product({ retiring: true })],
  [
    'product, last environment so nothing to promote to',
    product({ environment: 'prod', next: null }),
  ],
  ['product, environment with no file', product({ service: 'api', missing: true, rows: [] })],
  [
    'products, reporting a success',
    String(
      renderProducts({
        products: [],
        notice: { tone: 'done', text: 'Backed up 3 changes.' },
      }),
    ),
  ],
  [
    'product, reporting a failure',
    product({ notice: { tone: 'problem', text: 'Back-up failed. Nothing was pushed.' } }),
  ],
  [
    'a confirmation, naming the blast radius',
    String(
      renderConfirmation({
        title: 'Delete keys',
        message: 'SESSION_TTL will be removed from dev and prod.',
        action: '/p/iam/delete-keys',
        fields: { select: ['SESSION_TTL'] },
        back: '/p/iam?env=dev',
      }),
    ),
  ],
  [
    'features, one flag',
    String(
      renderFeatures({
        flags: { NEW_CHECKOUT: { dev: true, prod: false } },
        environment: 'dev',
        environments: ['dev', 'prod'],
      }),
    ),
  ],
  [
    'features, none declared',
    String(renderFeatures({ flags: {}, environment: 'dev', environments: ['dev'] })),
  ],
  ['a new product, nothing typed yet', String(renderNewProduct({ environments: ['dev', 'prod'] }))],
  [
    'settings',
    String(
      renderSettings({ env: { CONFIG_GIT_REMOTE: 'git@github.com:a/b.git' }, fragment: true }),
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

  it('names no layout inline either — alignment belongs in the stylesheet', () => {
    for (const [name, html] of everyState()) {
      expect(bodyOf(html).match(/style="/g) ?? [], name).toEqual([]);
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
      const body = bodyOf(html);
      const negatives =
        body.match(/<(?:a|button)[^>]*>[\s\S]{0,120}?(?:Not now|Clear|Drop|Dismiss|Archive|Retire)\b/g) ??
        [];
      for (const control of negatives) {
        expect(control, `${name}: ${control}`).toMatch(/class="linkbtn no"/);
      }
      const deleteButtons = body.match(/<button[^>]*>[\s\S]{0,200}?Delete keys/g) ?? [];
      for (const control of deleteButtons) {
        expect(control, `${name}: ${control}`).toMatch(/class="linkbtn no"/);
      }
    }
  });

  // .card and .rows each draw their own 1px border and their own radius, so one directly inside
  // the other renders two concentric outlines a few pixels apart. It reads as a rendering fault
  // rather than a design, and it is invisible in markup assertions -- both elements are correct
  // on their own.
  it('never nests one bordered container directly inside another', () => {
    for (const [name, html] of everyState()) {
      const nested = bodyOf(html).match(
        /<div class="(?:card|rows)"[^>]*>\s*<div class="(?:card|rows)"[^>]*>/g,
      );
      expect(nested ?? [], name).toEqual([]);
    }
  });

  it('gives every page exactly one heading', () => {
    for (const [name, html] of everyState()) {
      expect((bodyOf(html).match(/<h1/g) ?? []).length, name).toBe(1);
    }
  });
});
