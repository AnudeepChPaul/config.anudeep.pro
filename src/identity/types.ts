/** A `<service>/<environment>` pair — the unit a grant is written against. */
export type Namespace = string;

/** A service as `services.yaml` declares it. */
export interface ServiceIdentity {
  readonly name: string;
  readonly uid: number;
  readonly namespaces: readonly Namespace[];
}

/** What the kernel reports about the process on the other end of a Unix socket. */
export interface PeerCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly pid: number;
}

/** Explicit success/failure, so a denial cannot be mistaken for a value. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
