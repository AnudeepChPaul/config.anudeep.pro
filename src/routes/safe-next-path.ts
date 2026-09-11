export function safeNextPath(value: string | undefined): string {
  if (!value || value.startsWith('//') || !/^\/[A-Za-z0-9/_?=&.%-]*$/.test(value)) return '/';
  return value;
}
