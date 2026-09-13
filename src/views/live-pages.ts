import { keyDraftModels } from '@config/src/routes/product-form.js';
import type { KeyDefinition } from '@config/src/schema/validator.js';
import { isMetadataKey } from '@config/src/store/metadata.js';
import type { JournalEntry } from '@config/src/store/write-journal.js';
import { layoutChrome, type PageNotice, titled } from '@config/src/views/page-frame.js';
import { render } from '@config/src/views/render.js';
import { formatGistWhen, syncRowsFromJournal } from '@config/src/views/sync-gist.js';

/** A live value that has not reached Git yet, compared with the last committed copy. */
export interface UnsyncedChange {
  key: string;
  from: unknown;
  to: unknown;
  secret?: boolean;
  /** Schema keys have no live value to diff; the write is the declaration itself. */
  kind?: 'added' | 'removed';
}

export interface LiveKeyRow {
  key: string;
  definition: KeyDefinition;
  value: unknown;
  error?: string;
  /** What the same key holds in the other declared environments, for the hover panel. */
  elsewhere?: Readonly<Record<string, unknown>>;
  /** Last Git value vs live, when this key is saved and not yet synced. */
  change?: UnsyncedChange;
  /** Marks the row a search link arrived for, so the eye lands on it without a scroll. */
  found?: boolean;
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
  /** Declared in the registry but with no schema: the list must say so, and must not link. */
  missingSchema?: boolean;
  /** Unique keys saved in the database that have not reached Git. */
  unsynced?: number;
}

const shownValue = (value: unknown, secret?: boolean): string => {
  if (secret) return '••••';
  if (value === undefined) return '(None)';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const changelogCount = (
  changelog:
    | {
        environments: readonly {
          changelog: readonly { key: string }[];
          keys: readonly string[];
        }[];
      }
    | undefined,
): number => {
  if (!changelog) return 0;
  const keys = new Set<string>();
  for (const environment of changelog.environments) {
    if (environment.changelog.length)
      for (const change of environment.changelog) keys.add(change.key);
    else for (const key of environment.keys) keys.add(key);
  }
  return keys.size;
};

const changelogPeek = (
  name: string,
  entries: readonly JournalEntry[],
  changesByPath: Readonly<Record<string, readonly UnsyncedChange[]>>,
) => {
  const related = entries.filter((entry) => entry.path.startsWith(`config/${name}/`));
  if (related.length === 0) return undefined;
  let lastAt = '';
  for (const entry of related) if (entry.timestamp > lastAt) lastAt = entry.timestamp;
  const environments: {
    name: string;
    changelog: { key: string; from: string; to: string; kind?: 'added' | 'removed' }[];
    keys: string[];
  }[] = [];
  for (const path of new Set(related.map((entry) => entry.path))) {
    const environment = path.match(/^config\/[^/]+\/([^/]+)\.yaml$/)?.[1];
    const envEntries = related.filter((entry) => entry.path === path);
    environments.push({
      name: environment ? titled(environment) : '',
      changelog: (changesByPath[path] ?? []).map((change) => ({
        key: change.key,
        from: shownValue(change.from, change.secret),
        to: shownValue(change.to, change.secret),
        kind: change.kind,
      })),
      keys: [
        ...new Set(envEntries.flatMap((entry) => entry.keys.filter((key) => !isMetadataKey(key)))),
      ].sort((left, right) => left.localeCompare(right)),
    });
  }
  return { when: lastAt ? formatGistWhen(lastAt) : '', environments };
};

export interface LivePageOptions {
  fragment?: boolean;
  settingsLink?: boolean;
  build?: string;
  notice?: PageNotice;
  autoSync?: boolean;
  updateFooter?: boolean;
  updateHeader?: boolean;
  dismissTo?: string;
}

const chrome = (title: string, options: LivePageOptions) => ({
  title,
  showHeader: true,
  fragment: Boolean(options.fragment),
  settingsLink: Boolean(options.settingsLink),
  build: options.build ?? '',
  notice: options.notice,
  dismissTo: options.dismissTo ?? '/',
  ...layoutChrome(options),
});

function keyFieldModel(row: LiveKeyRow) {
  const name = `key.${row.key}`;
  const value = row.definition.secret ? '' : row.value;
  const formatted = Array.isArray(value) ? value.join(', ') : (value ?? '');
  const original = String(formatted);
  let control: 'secret' | 'bool' | 'enum' | 'input' = 'input';
  if (row.definition.secret) control = 'secret';
  else if (row.definition.type === 'bool') control = 'bool';
  else if (row.definition.type === 'enum') control = 'enum';
  const declared = row.definition.values ?? [];
  const quoted = declared.map((value) => `"${value}"`).join(' || ');
  return {
    key: row.key,
    name,
    found: Boolean(row.found),
    error: row.error,
    signature: declared.length > 0 ? `${row.definition.type}, ${quoted}` : row.definition.type,
    description: row.definition.description ?? '',
    peek: Boolean(row.change) || Object.keys(row.elsewhere ?? {}).length > 0,
    control,
    inputType:
      row.definition.type === 'int' ? 'number' : row.definition.type === 'url' ? 'url' : 'text',
    formatted: String(formatted),
    original,
    checked: value === true,
    valueDefined: value !== undefined,
    min: row.definition.min,
    max: row.definition.max,
    enumValues: row.definition.values ?? [],
    selectedValue: value,
    chips:
      row.definition.type === 'string[]' && Array.isArray(row.value)
        ? row.value.map((member) => String(member))
        : [],
    elsewhere: Object.entries(row.elsewhere ?? {}).map(([environment, held]) => ({
      environment: titled(environment),
      shown: shownValue(held, row.definition.secret),
    })),
    change: row.change
      ? {
          from: shownValue(row.change.from, row.change.secret),
          to: shownValue(row.change.to, row.change.secret),
        }
      : undefined,
  };
}

export function renderLiveProducts(
  options: LivePageOptions & {
    products: readonly LiveProduct[];
    /** How many products are retiring overall, which the link reports. Counted across the whole
        registry, not the filtered page, so searching does not change what the link says. */
    retiring?: number;
    retiringOnly?: boolean;
    query?: string;
    archiveAsk?: { service: string; kind: 'confirm' | 'force'; base?: string };
    /** Unique unsynced keys across every product, for the facts line. */
    unsynced?: number;
    /** Manual git backup is offered only when auto-sync is off and local differs from the remote. */
    showSyncNow?: boolean;
    entries?: readonly JournalEntry[];
    changesByPath?: Readonly<Record<string, readonly UnsyncedChange[]>>;
  },
): string {
  const query = options.query ?? '';
  const needle = query.toLowerCase();
  const products = options.products
    .filter(
      (product) =>
        !options.retiringOnly || product.retiring || options.archiveAsk?.service === product.name,
    )
    .map((product) => ({
      product,
      matched: needle
        ? (product.keys ?? []).filter((key) => key.toLowerCase().includes(needle))
        : (product.keys ?? []),
    }))
    .filter(
      ({ product, matched }) =>
        !needle || product.name.toLowerCase().includes(needle) || matched.length > 0,
    );
  const rows = products.map(({ product, matched }) => {
    const shownKeys = matched.slice(0, 2);
    return {
      name: product.name,
      label: `${titled(product.name)}${product.uid === undefined ? '' : ` (${product.uid})`}`,
      missingSchema: Boolean(product.missingSchema),
      unsynced: product.unsynced,
      changelog: changelogPeek(product.name, options.entries ?? [], options.changesByPath ?? {}),
      environmentsLabel: product.environments.map(titled).join(', '),
      retiring: product.retiring,
      archiveAsk:
        options.archiveAsk?.service === product.name ? options.archiveAsk.kind : undefined,
      archiveBase:
        options.archiveAsk?.service === product.name ? (options.archiveAsk.base ?? '') : undefined,
      shownKeys: shownKeys.map((key) => ({
        name: key,
        dest: `/p/${product.name}?env=${product.environments[0] ?? ''}&hl=${key}`,
      })),
      moreKeys: matched.length - shownKeys.length,
    };
  });
  return render('pages/products', {
    ...chrome(options.retiringOnly ? 'Retiring' : 'Products', options),
    activeTab: 'products',
    retiringOnly: Boolean(options.retiringOnly),
    heading: options.retiringOnly ? undefined : 'Products',
    trail: options.retiringOnly ? 'Retiring' : undefined,
    retiringCount:
      options.retiring ?? options.products.filter((product) => product.retiring).length,
    showSyncNow: Boolean(options.showSyncNow),
    emptySearch: needle.length > 0 && products.length === 0,
    facts: `${products.length} products${options.unsynced ? ` · ${options.unsynced} unsynced` : ''}`,
    search: { action: '/', query, placeholder: 'Search products', clearHref: '/' },
    rows,
  });
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
    unsynced?: readonly UnsyncedChange[];
    entries?: readonly JournalEntry[];
    changesByPath?: Readonly<Record<string, readonly UnsyncedChange[]>>;
    retireAsk?: 'confirm' | 'force';
    keyDrafts?: ReadonlyArray<Record<string, string>>;
    keyProblems?: ReadonlyArray<{ key: string; message: string }>;
  },
): string {
  const action = `/p/${options.service}/${options.environment}`;
  const back = `/p/${options.service}?env=${encodeURIComponent(options.environment)}`;
  const query = options.query ?? '';
  const changelog =
    changelogPeek(options.service, options.entries ?? [], options.changesByPath ?? {}) ??
    (options.unsynced?.length
      ? {
          when: '',
          environments: [
            {
              name: titled(options.environment),
              changelog: options.unsynced.map((change) => ({
                key: change.key,
                from: shownValue(change.from, change.secret),
                to: shownValue(change.to, change.secret),
              })),
              keys: options.unsynced.map((change) => change.key),
            },
          ],
        }
      : undefined);
  const canAddKeys = !options.missing && options.environment === options.environments[0];
  const keyRows = keyDraftModels(options.keyDrafts, options.keyProblems);
  return render('pages/product', {
    ...chrome(options.service, { ...options, dismissTo: options.dismissTo ?? back }),
    activeTab: 'products',
    service: options.service,
    serviceTitle: titled(options.service),
    trail: titled(options.service),
    environment: options.environment,
    action,
    next: options.next,
    retiring: options.retiring,
    missing: options.missing,
    etag: options.etag,
    version: options.version,
    facts: `${options.environment} · version ${options.version}${options.retiring ? ' · retiring' : ''}`,
    search: {
      action: `/p/${options.service}`,
      query,
      placeholder: 'Search keys',
      clearHref: back,
      hidden: [{ name: 'env', value: options.environment }],
    },
    envTabsLabel: 'Product environments',
    envTabs: options.environments.map((environment) => ({
      href: `/p/${options.service}?env=${environment}`,
      label: titled(environment),
      on: environment === options.environment,
    })),
    rows: options.rows.map(keyFieldModel),
    changelog,
    unsyncedCount: changelogCount(changelog),
    retireAsk: options.retireAsk,
    canAddKeys,
    keyRows,
    keyFormProblems: (options.keyProblems ?? []).filter((problem) => problem.key === ''),
    named: keyRows.some((row) => row.name.trim().length > 0),
    addKeysOpen:
      options.keyDrafts !== undefined || Boolean(options.keyProblems && options.keyProblems.length),
  });
}

export function renderConfirmation(
  options: LivePageOptions & {
    title: string;
    message: string;
    action: string;
    fields: Readonly<Record<string, string | readonly string[]>>;
    back: string;
    confirmLabel?: string;
    confirmClass?: string;
    cancelPost?: {
      action: string;
      fields: Readonly<Record<string, string | readonly string[]>>;
      label: string;
    };
  },
): string {
  const hidden = (fields: Readonly<Record<string, string | readonly string[]>>) =>
    Object.entries(fields).flatMap(([name, values]) =>
      (typeof values === 'string' ? [values] : values).map((value) => ({ name, value })),
    );
  return render('pages/confirmation', {
    ...chrome(options.title, options),
    activeTab: 'products',
    heading: options.title,
    message: options.message,
    action: options.action,
    back: options.back,
    confirmLabel: options.confirmLabel ?? 'Yes, continue',
    confirmClass: options.confirmClass ?? 'linkbtn',
    hiddenFields: hidden(options.fields),
    cancelPost: options.cancelPost
      ? {
          action: options.cancelPost.action,
          label: options.cancelPost.label,
          hiddenFields: hidden(options.cancelPost.fields),
        }
      : undefined,
  });
}

export function renderSyncPreview(
  options: LivePageOptions & {
    entries: readonly JournalEntry[];
    unpushed: readonly { subject: string }[];
    changesByPath?: Readonly<Record<string, readonly UnsyncedChange[]>>;
    retiring?: readonly string[];
  },
): string {
  const rows = syncRowsFromJournal(options.entries, new Set(options.retiring ?? []));
  const decorate = (gist: (typeof rows.gists)[number]) => {
    const config = gist.path.match(/^config\/([^/]+)\/([^/]+)\.yaml$/);
    return {
      path: gist.path,
      product: config?.[1] ? titled(config[1]) : gist.label,
      environment: config?.[2] ? titled(config[2]) : '',
      lastAt: gist.lastAt,
      when: gist.lastAt ? formatGistWhen(gist.lastAt) : '',
      keys: gist.keys,
      changelog: (options.changesByPath?.[gist.path] ?? []).map((change) => ({
        key: change.key,
        from: shownValue(change.from, change.secret),
        to: shownValue(change.to, change.secret),
        kind: change.kind,
      })),
    };
  };
  const grouped = new Map<string, ReturnType<typeof decorate>[]>();
  for (const gist of rows.gists.map(decorate)) {
    const bucket = gist.environment ? gist.product : gist.path;
    const held = grouped.get(bucket) ?? [];
    held.push(gist);
    grouped.set(bucket, held);
  }
  const gists = [...grouped.values()].map((environments) => {
    let lastAt = '';
    for (const env of environments) if (env.lastAt > lastAt) lastAt = env.lastAt;
    return {
      product: environments[0]?.product ?? '',
      when: lastAt ? formatGistWhen(lastAt) : '',
      environments,
    };
  });
  const added = rows.added.map((name) => {
    const environments = (rows.configsOf[name] ?? []).map(decorate);
    let lastAt = '';
    for (const env of environments) if (env.lastAt > lastAt) lastAt = env.lastAt;
    return {
      name: titled(name),
      when: lastAt ? formatGistWhen(lastAt) : '',
      environments,
    };
  });
  const archived = rows.archived.map((name) => titled(name));
  const envCount = gists.reduce((sum, gist) => sum + gist.environments.length, 0);
  const count = added.length + archived.length + envCount + options.unpushed.length;
  return render('pages/sync-preview', {
    ...chrome('Sync changes now', options),
    compact: true,
    activeTab: 'products',
    facts: `${count} ${count === 1 ? 'action' : 'actions'} to sync`,
    registry: { added, archived },
    gists,
    unpushed: options.unpushed,
  });
}
