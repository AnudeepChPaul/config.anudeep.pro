import type { DBEngine } from '@config/src/store/data-layer.js';
import type { ConfigSources, Sha } from '@config/src/store/types.js';

/** Read-only repository-shaped view over the authoritative database tree. */
export class DBRepositoryView {
  constructor(private readonly db: DBEngine) {}

  async readSources(): Promise<ConfigSources> {
    const snapshot = await this.db.snapshot('config');
    const sources = new Map<string, string>();
    for (const [path, source] of snapshot.files) {
      if (!path.endsWith('.yaml')) continue;
      const namespace = path.slice('config/'.length, -'.yaml'.length);
      if (namespace.split('/').length === 2) sources.set(namespace, source);
    }
    return { commit: snapshot.revision as Sha, sources };
  }

  async readFile(path: string): Promise<string> {
    const source = await this.db.read(path);
    if (source === null) throw new Error(`${path} is absent`);
    return source;
  }
}
