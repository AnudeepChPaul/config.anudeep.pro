# System design

## Data at rest

Authoritative state lives under `CONFIG_DB_PATH` (`db/`). Git is a synchronized backup and audit
medium, not the hot read path.

| Path | Holds | Read by |
|---|---|---|
| `services.yaml` | The grant table: name, uid, namespaces, plus `version` | `ServiceRegistry` |
| `environments.yaml` | Which environments exist, in promotion order | `EnvironmentOrder` |
| `schema/<product>.yaml` | That product's key types, bounds, secrecy, `retiring` | `SchemaSet` |
| `config/<service>/<env>.yaml` | The values, SOPS-encrypted per file, plus a `version` counter | `ConfigLoader` |
| `archived/<service>.yaml` | A removed product, whole | Nothing at runtime; it is a record |
| `.sops.yaml` | Which keys are encrypted, and to which age recipient | SOPS |

Outside the database, on the host: `snapshot.json` (last known good), `break-glass.yaml` (emergency
credential, deliberately not mirrored). At cutover, any leftover `drafts.json` is discarded.

### Document metadata

`version` and `sops` sit beside the values in a namespace file and are not configuration.
`isMetadataKey` is the single place that knows this; anything listing keys filters through it.

### The revision counter

`version` rises once per successful value write that changes the document, and is clamped so it can
never go backwards. Retirement and semantic no-op saves do not bump it.

## APIs

### Read API — Unix socket, `GET /config/:service/:environment`

```json
{ "service": "iam", "environment": "prod", "commit": "9b81327",
  "retiring": false, "config": { "MFA_ENFORCEMENT": "all" } }
```

`retiring` is always present. Authorization is `SO_PEERCRED`.

Every console, webhook, and read-API response includes `X-Request-Sid: sid_…`. The inbound header is ignored. Application log lines for that request carry the same `request_sid`.

## Logging persistence

Optional Postgres, separate from `CONFIG_DB_PATH`. Local Compose provides `log-db` at `postgresql://config:config@log-db:5432/log` (published on `127.0.0.1:5435`). Schema: `sql/log/0001_log_schema.sql` (`log.app_log`, `log.access_log`). Both `request_sid` and `request_id` hold the minted token. `CONFIG_LOG_DATABASE_URL` unset keeps stdout only. The sink never fails an operator request.

Not applicable: OpenTelemetry pipeline, Grafana dashboards in this change.

### Console — HTTP, session cookie

`/`, `/p/:service`, `/p/new`, `/p/retiring`, `/features`, `/settings`, and the writes:
`POST /p/:service/:environment` (save or create), `/p/:service/retire`, `/p/:service/archive`,
`/p/:service/delete-keys`, `/promote`, `/sync`, `/p/new`.

`new` and `retiring` are reserved product names.

### Webhook — HTTP, `POST /webhooks/github`

HMAC-verified. Absent secret closes the route rather than opening it.

## Classes

```mermaid
classDiagram
    class ProductWriteOperations {
        +createProduct(request, actor) Result
        +writeValues(request, actor) Result
        +setRetiring(service, flag, actor) Result
        +promote(request, actor) Result
        +deleteKeys(service, keys, actor) Result
        +archiveProduct(service, actor) Result
    }
    class DBEngine {
        +writeMany(files, checks) Result
        +read(path) string
        +etag(path) string
        +snapshot() Snapshot
        +revision() number
    }
    class SchemaSet {
        +definitionsFor(service)
        +defaultsFor(service)
        +isSecret(service, key)
        +isRetiring(service)
        +validate(service, config)
    }
    ProductWriteOperations --> DBEngine
    ProductWriteOperations --> SchemaSet
```

### Atomic multi-file ordering

| Operation | Order | Why partial state is safe |
|---|---|---|
| Create product | schema entry → environment files → `services.yaml` last | Registry visibility last |
| Archive product | `services.yaml` first → environment files → schema | Hides the product immediately |
| Delete keys | environment files first → schema last | Declared-but-unset keys are harmless |

## Security

- Secrets are encrypted by SOPS before they are stored. The encryptor applies the clone's
  `.sops.yaml`; a missing or mismatched `encrypted_regex` refuses the save rather than writing
  plaintext.
- The break-glass credential lives outside the repository.
- Denials disclose nothing.
- Settings refusals are 404.
- Notices travel as codes. Save reports "Live now"; git sync is "Backed up to git" or a problem
  code (`backup-failed`, `backup-deferred`, `backup-no-remote`). Git stderr never enters the URL.
- `GIT_SSH_COMMAND` pins the deploy key with `IdentitiesOnly`.

## Reliability

- The read path never touches git: it serves from cache rebuilt on reload.
- A push that fails leaves live values served from `db/`; the console reports back-up status.
- Multi-file writes check every participating ETag before publication; conflicts return 409.

## Scalability

One host, one writer process. Not a multi-region store.

### Ordered, recoverable file transactions

`writeMany(requests)` accepts ordered `{path, content, expectedEtag?, validate?, actor?, keys?}`
mutations. `content: null` deletes a file; `expectedEtag: null` requires that it does not exist.
Omitting the ETag retains unconditional-write compatibility. All validators run before staging;
all participating ETags are compared while their path locks are held. Duplicate paths, traversal,
engine-private paths, and symlinked database paths are refused.

The caller supplies the safe visibility order: schema and environments before registry on create;
registry before environments and schema on archive; environment values before schema on key
deletion. The current product creator now publishes its registry entry last.

Each changed payload is staged at mode `0600`. Only after every stage is durable does the engine
persist an intent with ordered paths, SHA-256 target hashes, attribution, and one target revision.
It publishes in order, writes that revision once, emits attribution, and removes the intent.
Unchanged files generate neither a new revision nor attribution events.

Recovery verifies all remaining payloads before replay, skips replacements whose targets already
match, and restores the recorded revision without incrementing it again. Attribution callbacks
are at-least-once on recovery; their stable `transactionId` and path identify a replay. They must
not recursively read the engine while its publication lock is held. A publication failure
requires restart recovery: subsequent database reads and writes fail instead of exposing a
partial transaction. Existing cache contents can remain available to consumers.

`snapshot(prefix)` returns `{revision, files}` under the publication lock. Independent `read()`
calls are individually consistent but do not form a multi-read transaction. Snapshot results
exclude `.journal`, `.revision`, and `.git`. The schema and flag flows retain their existing
contracts during this foundation slice.

```mermaid
flowchart TD
    UI[Authenticated console] --> DB[DBEngine]
    DB --> Files[(db files)]
    DB --> Cache[ConfigCache]
    Files --> Flags[FlagValidator and FlagSet]
    Files --> Sync[SyncEngine]
    Sync --> Git[(config.bare)]
    Git --> Remote[Git remote]
    Cache --> Socket[Unix socket read API]
```

The database revision is the opaque `commit` response token. `syncedCommit` is reserved for Git
provenance. Flag values absent for an environment resolve to `false`; unknown flag lookups in the
client also resolve to `false` unless a caller supplies a fallback.
# Direct-write safety checkpoint — 2026-09-10

A changed direct value save increments its document version once. A semantic no-op keeps the existing ciphertext and revision, with a compare-and-swap check. Each schema-secret field must independently contain an encrypted SOPS value; a different encrypted field is not proof. Encryption/decryption errors returned to callers omit dependency messages.
