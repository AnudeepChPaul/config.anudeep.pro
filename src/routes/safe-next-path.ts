export function safeNextPath(value: string | undefined): string {
  if (!value || value.startsWith('//') || !/^\/[A-Za-z0-9/_?=&.%-]*$/.test(value)) return '/';
  return value;
}

/** Prefer a posted path, then htmx's current URL, then a same-request fallback. */
export function nextPathFromRequest(options: {
  readonly bodyNext?: string;
  readonly hxCurrentUrl?: string;
  readonly fallback?: string;
}): string {
  if (options.bodyNext) return safeNextPath(options.bodyNext);
  if (options.hxCurrentUrl) {
    try {
      const url = new URL(options.hxCurrentUrl);
      return safeNextPath(`${url.pathname}${url.search}`);
    } catch {
      return '/';
    }
  }
  return safeNextPath(options.fallback);
}
