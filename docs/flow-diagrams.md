# Flows

## Recoverable database transaction (product-write slice 1)

```mermaid
flowchart TD
    Request[Ordered file mutations] --> Locks[Acquire participating path locks]
    Locks --> Validate{All validators and ETags pass?}
    Validate -->|No| Refuse[Return errors or conflict; no file changes]
    Validate -->|Yes| Stages[Durably stage all changed payloads]
    Stages --> Publish[Acquire publication lock]
    Publish --> Intent[Persist intent and target revision]
    Intent --> Replace[Install or remove in caller order]
    Replace --> Revision[Persist one revision]
    Revision --> Audit[Emit attribution and complete intent]
    Audit --> Return[Release locks and return success]
    Stages -->|Interrupted before intent| Orphans[Boot removes private orphan stages]
    Replace -->|Interrupted after intent| Recover[Boot verifies payload hashes and replays intent]
    Recover --> Revision
    Recover -->|Missing or corrupt payload| Halt[Refuse startup; preserve recovery evidence]
```

Database snapshot reads wait for publication and return one complete revision. Sync copies that
snapshot before committing or pushing, so network time does not hold the database lock.

Success, failure, retry, fallback and rollback for every path that writes or serves.

## Serving a value

```mermaid
flowchart TD
    Req["read /config/:service/:environment"] --> Peer["SO_PEERCRED: the kernel's uid"]
    Peer -->|"unreadable"| D403["403"]
    Peer --> Known{"uid in services.yaml?"}
    Known -->|"no"| D403
    Known --> Granted{"granted this namespace?"}
    Granted -->|"no"| D403
    Granted --> Value{"cache holds it?"}
    Value -->|"no"| D404["404 not_found"]
    Value --> OK["200: values, commit, retiring"]
```

A denial says nothing about why: an ungranted caller cannot tell a namespace that exists from one
that does not.

## Saving values (live)

```mermaid
flowchart TD
    Save["POST save"] --> Validate{"matches the schema?"}
    Validate -->|no| R422["422 with field errors"]
    Validate --> Cas{"ETag matches?"}
    Cas -->|no| R409["409 reload and re-apply"]
    Cas --> Write["DBEngine write; bump version if changed"]
    Write --> Live["Live now; cache wakes"]
    Live --> Backup{"Auto sync on?"}
    Backup -->|yes| Idle["idle/timer SyncEngine"]
    Backup -->|no| Manual["Sync changes now when pending"]
```

## Create product

```mermaid
flowchart TD
    Create["POST /p/new"] --> Val["Validate schema and uid"]
    Val --> Atomic["writeMany: schema → env files → services.yaml last"]
    Atomic --> Visible["Product becomes visible"]
```

## Promote and Delete

```mermaid
flowchart TD
    Tick["Operator ticks keys"] --> Action{"Promote or Delete?"}
    Action -->|Promote| Secret{"any secret?"}
    Secret -->|yes| Refuse["422 cannot promote a secret"]
    Secret -->|no| Target["Direct write into next environment"]
    Target -->|invalid merged document| FieldErr["422 field errors on the product page"]
    Action -->|Delete| Confirm["Confirm naming keys and every environment"]
    Confirm --> Strip["Strip keys from every env file then schema"]
```

## Retire and archive

```mermaid
flowchart TD
    Retire["setRetiring schema write"] --> Mark["Consumers see retiring: true"]
    Mark --> Archive["archiveProduct: services.yaml first"]
    Archive --> Gone["No longer served"]
```

## Git backup (auto-sync off by default)

```mermaid
flowchart TD
  Write[Live DB write] --> Gate{Auto sync on?}
  Gate -->|yes| Engine[SyncEngine commit and push]
  Gate -->|no| Pending[Journal and unpushed accumulate]
  Pending --> Btn[Sync changes now]
  Btn --> List[Preview list]
  List --> Cancel[Cancel]
  List --> Confirm[Confirm POST /sync]
  Confirm --> Engine
  ToggleOn[Auto sync turned on] --> Engine
  Engine --> Ok{outcome}
  Ok -->|synced| Clear[Clear problem banner]
  Ok -->|deferred| Banner[backup-deferred notice]
  Ok -->|throw| Fail[backup-failed notice]
```

## Request logging

```mermaid
flowchart TD
  Req[HTTP or webhook request] --> Mint["mint request_sid sid_…"]
  Mint --> Header["X-Request-Sid"]
  Mint --> ALS[AsyncLocalStorage]
  ALS --> Pino[pino mixin]
  Pino --> Std[stdout JSON]
  Pino --> Sink["LogDbSink fail-open"]
  Sink --> Pg[(Postgres log.app_log)]
  Header --> Access["onResponse access_log"]
  Access --> Pg
  Sink -->|Postgres down| Drop[drop buffered rows; console still serves]
```

# Direct-write safety checkpoint — 2026-09-10

Direct-save flow refinement: read ciphertext and ETag → decrypt → validate → compare semantic values → encrypt changed values with incremented version → verify each secret field → compare-and-swap. A concurrent write returns conflict without installing the candidate. A no-op verifies its base without re-encryption.
