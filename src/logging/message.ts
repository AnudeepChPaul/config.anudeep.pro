/**
 * Human-readable log text from a machine event name and its fields.
 *
 * Postgres and operators read `message`; `event` stays the stable identifier.
 */
export function processedMessage(event: string, fields: Record<string, unknown> = {}): string {
  const phrase = phraseEvent(event);
  const extras: string[] = [];
  push(extras, fields.service);
  push(extras, fields.name);
  if (typeof fields.environment === 'string' && fields.environment) extras.push(fields.environment);
  if (typeof fields.method === 'string' && typeof fields.path === 'string') {
    extras.push(`${fields.method} ${fields.path}`);
  }
  if (typeof fields.status === 'number') extras.push(String(fields.status));
  if (typeof fields.cmd === 'string' && fields.cmd) extras.push(`git ${fields.cmd}`);
  push(extras, fields.code);
  push(extras, fields.detail);
  push(extras, fields.error_messages);
  push(extras, fields.reason);
  let text = extras.length > 0 ? `${phrase}: ${extras.join(' · ')}` : phrase;
  if (typeof fields.duration_ms === 'number' && Number.isFinite(fields.duration_ms)) {
    text += ` (${fields.duration_ms.toFixed(1)}ms)`;
  }
  return text;
}

function push(extras: string[], value: unknown): void {
  if (typeof value === 'string' && value) extras.push(value);
}

function phraseEvent(event: string): string {
  const tokens = event
    .replace(/^config\./, '')
    .split('.')
    .flatMap((token) => token.split('-'))
    .filter(Boolean);
  if (tokens.length === 0) return event;
  const last = tokens.at(-1) ?? '';
  const head = tokens
    .slice(0, -1)
    .map((token) => (token === 'db' ? 'database' : token === 'ui' ? 'console' : token))
    .join(' ');
  const verb =
    last === 'start'
      ? 'started'
      : last === 'ok'
        ? 'completed'
        : last === 'failed'
          ? 'failed'
          : last;
  const core = head ? `${head} ${verb}` : verb;
  return core.charAt(0).toUpperCase() + core.slice(1);
}
