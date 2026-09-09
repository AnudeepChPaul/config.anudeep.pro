/**
 * Picks where a file is read from: the repository, or the filesystem beside it.
 *
 * The break-glass record used to be committed. Nothing excluded it from a push, so on a
 * repository with a remote the first publish sent the credential to GitHub. A record held in
 * the volume instead cannot be pushed, because there is nothing to commit — the property comes
 * from where the bytes live, not from a rule someone has to remember.
 *
 * An absolute path means the filesystem; anything relative is a path inside the tree and is
 * read from the served commit exactly as before, so a volume whose record predates this still
 * boots, and deleting that record still revokes it.
 */
export interface BreakGlassSources {
  readonly fromRepository: (path: string) => Promise<string>;
  readonly fromFilesystem: (path: string) => Promise<string>;
}

export function breakGlassReader(sources: BreakGlassSources): (path: string) => Promise<string> {
  return (path) =>
    path.startsWith('/') ? sources.fromFilesystem(path) : sources.fromRepository(path);
}
