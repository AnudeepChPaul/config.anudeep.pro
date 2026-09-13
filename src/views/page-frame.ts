export const layoutChrome = (options: {
  autoSync?: boolean;
  updateFooter?: boolean;
  updateHeader?: boolean;
}): { autoSync?: boolean; updateFooter?: boolean; updateHeader?: boolean } => ({
  ...(options.autoSync !== undefined ? { autoSync: options.autoSync } : {}),
  ...(options.updateFooter ? { updateFooter: true } : {}),
  ...(options.updateHeader ? { updateHeader: true } : {}),
});

export interface PageNotice {
  readonly tone: 'done' | 'problem';
  readonly text: string;
}

/** Visible form of a product or environment id. Hrefs keep the raw name. */
export function titled(value: string): string {
  return value.replace(
    /(^|[^A-Za-z0-9])([A-Za-z])/g,
    (_match, sep: string, letter: string) => sep + letter.toUpperCase(),
  );
}
