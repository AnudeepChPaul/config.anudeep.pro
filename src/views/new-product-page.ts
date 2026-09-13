import { keyDraftModels } from '@config/src/routes/product-form.js';
import { layoutChrome } from '@config/src/views/page-frame.js';
import { render } from '@config/src/views/render.js';

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
  updateFooter?: boolean;
  updateHeader?: boolean;
}): string {
  const typed = options.typed ?? {};
  const problems = options.problems ?? [];
  const about = (key: string) => problems.filter((problem) => problem.key === key);
  const keyRows = keyDraftModels(typed.keys, problems);
  const selectedEnvs = typed.environments ?? options.environments;

  return render('pages/new-product', {
    title: 'Add a product',
    showHeader: true,
    activeTab: 'products',
    trail: 'Add a product',
    fragment: Boolean(options.fragment),
    settingsLink: Boolean(options.settingsLink),
    build: options.build ?? '',
    ...layoutChrome(options),
    formProblems: about(''),
    typedName: typed.name ?? '',
    typedUid: typed.uid ?? '',
    environmentChoices: options.environments.map((name) => ({
      name,
      checked: selectedEnvs.includes(name),
    })),
    keyRows,
  });
}
