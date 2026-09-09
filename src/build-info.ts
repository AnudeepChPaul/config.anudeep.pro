import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What is actually running here.
 *
 * The footer answers one question, and it is only ever asked during an incident: is the thing in
 * front of me the thing I think I deployed? `package.json` alone cannot answer it — 0.1.0 is
 * every build of 0.1.0 — so the commit the image was built from is baked in at build time and
 * shown beside the version.
 *
 * The container id is the honest half of "which image". A container cannot know the name of the
 * image it came from; that name exists only where docker was invoked. It does know its own id,
 * so that is what is shown, rather than a name guessed from a project directory that would be
 * right on one machine and a lie everywhere else.
 */
export interface Build {
  readonly version: string;
  /** The commit the image was built from, or null where nothing was baked in. */
  readonly sha: string | null;
  readonly containerId: string;
}

/** How much of a commit anyone actually types. */
const SHORT = 7;

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    return String(JSON.parse(raw).version ?? '0.0.0');
  } catch {
    // A version is a label, never a reason to fail to start.
    return '0.0.0';
  }
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): Build {
  const sha = (env.CONFIG_BUILD_SHA ?? '').trim();
  return {
    version: packageVersion(),
    // An unset build argument interpolates to an empty string, which is not a commit. Null says
    // "nothing was baked in" and the label then omits it rather than showing a version with a
    // dangling plus, which reads like a truncated sha.
    sha: sha.length > 0 ? sha : null,
    containerId: hostname(),
  };
}

export function buildLabel(build: Build): string {
  const version = build.sha ? `${build.version}+${build.sha.slice(0, SHORT)}` : build.version;
  return `${version} · ${build.containerId}`;
}
