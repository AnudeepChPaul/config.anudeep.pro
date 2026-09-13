export type ConsoleTab = 'products' | 'features';

const pathnameOf = (pathOrUrl: string): string => {
  const raw = pathOrUrl.trim();
  if (!raw) return '';
  try {
    if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(raw)) return new URL(raw).pathname;
  } catch {
    return '';
  }
  return raw.split('?')[0] ?? '';
};

/** Which console tab a path belongs to. Settings, sync, and login are neither. */
export function consoleTabOf(pathOrUrl: string): ConsoleTab | undefined {
  const pathname = pathnameOf(pathOrUrl);
  if (pathname === '/features' || pathname.startsWith('/features/')) return 'features';
  if (pathname === '/' || pathname.startsWith('/p/')) return 'products';
  return undefined;
}

/** Re-render `#pagechrome` only when the operator crosses Products ↔ Features. */
export function shouldSwapHeader(fromUrl: string | undefined, toPath: string): boolean {
  const from = fromUrl ? consoleTabOf(fromUrl) : undefined;
  const to = consoleTabOf(toPath);
  return (from === 'products' && to === 'features') || (from === 'features' && to === 'products');
}
