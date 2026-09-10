# Runbook

## Setup

```sh
make dev     # clone the registry, mint a break-glass credential, start; UI at :8200
make code    # print the current six-digit break-glass code
make test    # the suite, on Linux, where SO_PEERCRED and sops exist
make check   # lint and typecheck on the host, then the suite in the container
make reset   # throw away the volumes; .env is left alone
```

`make dev` **clones** the configured remote. It never seeds a sample: a generated history shares
no ancestor with the remote, so nothing published from it could ever be pushed. With no remote,
or no age key, it stops and says which.

## Configuration

Everything is read from the environment. `.env` is gitignored and `make reset` does not touch it.
Compose passes only what it declares — a variable added to `.env` alone is invisible inside the
container.

| Variable | Meaning | Absent |
|---|---|---|
| `CONFIG_GIT_REMOTE` | Where publishes are pushed | Local-only; the console says "not yet pushed" |
| `CONFIG_GIT_SSH_KEY` | Deploy key path, write-scoped to one repository | ssh uses whatever the host offers |
| `CONFIG_AGE_KEY` | The **secret** half (`AGE-SECRET-KEY-1…`) of the recipient in `.sops.yaml` | Refuses to start |
| `CONFIG_SESSION_SECRET` | Signs the session cookie; at least 32 characters | Refuses to start |
| `CONFIG_IAM_HEALTH_URL` | IAM health endpoint checked for login availability | `http://127.0.0.1:8000/healthz` |
| `CONFIG_IAM_CHECK_INTERVAL_MS` | How often IAM availability is refreshed after startup | 10s |
| `CONFIG_ENABLE_SETTINGS` | Whether `/settings` exists at all | It does not exist (404) |
| `CONFIG_SETTINGS_ALLOW` | Addresses admitted beside a break-glass session | Nobody, never everybody |
| `CONFIG_BREAK_GLASS_PATH` | Absolute reads from the volume; relative from the tree | `/var/lib/config/break-glass.yaml` |
| `CONFIG_POLL_INTERVAL_MS` | Fallback reload when a webhook is missed | 60s |
| `CONFIG_PUSH_RETRY_INTERVAL_MS` | Retry for a push that failed | 60s |

An age key is a **secret** key. `age1…` is the public recipient and will not decrypt anything;
the symptom is a console that starts and cannot read a value.

## Health checks

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8200/login   # 200
docker compose exec app sh -c 'cd /var/lib/config/repo && git status -sb | head -1'
docker compose logs --since 5m app | grep -iE 'error|could not reload'
```

The settings page (when enabled) answers "which variables is this process actually running with",
which is the question two of this project's longest outages turned on.

## Troubleshooting

| Symptom | Cause seen in practice |
|---|---|
| `Permission denied (publickey)` on push | `CONFIG_DEPLOY_KEY` empty, so compose created a **directory** at the mount point and ssh was handed a folder |
| Publishing says "not yet pushed" forever | No remote configured, or a local history that shares no ancestor with it (`git merge-base` empty) |
| A published change does not appear in the console | Before `onCommitted`, the registry and schemas refreshed only on a webhook or the poll |
| Secrets will not decrypt | `CONFIG_AGE_KEY` holds the public recipient rather than the secret key |
| A staged draft vanished | A draft with no `kind` is dropped on read; it is not durable state |
| Save says "nothing to save" | The form posted no edit and no tick — an empty box on an unset key is not a change |

## Migration

Two file fields landed by the same three-step route, and it is the one to copy: **accept** the
field as optional, **write** it into the registry, **then** require it. Requiring before writing
leaves a deploy that cannot read its own registry.

- `version` on `services.yaml` and `schema/*.yaml` — done (`213a3e2`, registry `97887a9`, `a31b4ec`).
- `kind` on a draft — not migrated by design: drafts without one are dropped.

## Recovery and rollback

```sh
git revert <sha>            # any published change, including an archive
docker compose exec app sh -c 'cd /var/lib/config/repo && git pull --rebase origin main'
```

An archived product is restored by reverting its archive commit: the entry, the schema and every
environment come back with their ciphertext intact, because archiving never decrypted them.

The age key is the one thing git cannot give back. It exists only where you keep it, and losing
it makes every encrypted value unreadable — that happened once in this project's history and cost
a re-key of the whole registry.

## File-based data engine

### Transaction recovery

The product-write transaction foundation adds private recovery state at
`<CONFIG_DB_PATH>/.journal/transactions/<uuid>/`. `intent.json` names the target hashes, ordered
paths and revision; numbered `.stage` files contain the already-encrypted target documents.
Boot recovery runs before the sync scheduler or listeners start. Stages without a committed
intent are discarded; committed intents are replayed to completion.

If a write reports `database recovery required`, restart the process with the same database
volume. Do not manually delete the intent or retry writes against a partial database. Missing
or corrupt staged payloads stop recovery; preserve the volume and inspect the named transaction
before restoring from a known-good backup. Recovery rolls forward and offers no value undo.

Before rolling back the application version, stop writes and let the current version finish
recovery; confirm the transactions directory is empty and take a backup. Older versions cannot
recover these intents. The live file formats do not change. No deploy or deletion of pending
drafts is performed by this foundation slice.

The Features page renders environment tabs in the order declared by `environments.yaml`
(`order: [dev, staging, prod]`, for example). The first declared environment is selected by
default; `/features?env=staging` opens a specific one. Inline additions and switches apply to
the selected environment. Unknown environments are refused, and no Add action is offered when
the file declares no environments. Flag validation and cache resolution use this same file.

`CONFIG_DB_PATH` defaults to `/var/lib/config/db`. On first boot it is populated from the local
repository, excluding `.git`. `CONFIG_SYNC_INTERVAL_MS` controls automatic synchronization and
defaults to 600000 milliseconds. Manual synchronization is available through the authenticated
console's sync operation.

If synchronization fails, the database remains authoritative and served locally. Inspect the
journal under `<CONFIG_DB_PATH>/.journal`; restart recovery merges an orphaned sending journal
back into pending work. Do not delete journal files during an incident.
# Direct-write safety checkpoint — 2026-09-10

Implementation checkpoint (not a deployment-ready cutover): value saves and product creation now refuse stale bases, including changes made while encryption runs. On conflict, reload and explicitly review/reapply the edit; do not retry an unconditional overwrite. No existing data or pending work was deleted at this checkpoint. Preserve db/ and take a current backup before rolling back code.
