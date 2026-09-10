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

## Saving and publishing

```mermaid
flowchart TD
    Save["Save: edited values and ticks"] --> Validate{"matches the schema?"}
    Validate -->|"no"| Errors["422, per-key errors, swapped in"]
    Validate --> Moved{"anything moved or ticked?"}
    Moved -->|"no"| Nothing["nothing-staged"]
    Moved --> Draft["Draft: ENV_UPDATES, one save appended"]
    Draft --> Publish["Publish"]
    Publish --> Stale{"file changed underneath?"}
    Stale -->|"yes"| Conflict["publish-stale: nothing published"]
    Stale --> Commit["One commit, generated message, trailers"]
    Commit --> Push{"pushed?"}
    Push -->|"yes"| Done["published"]
    Push -->|"no"| Local["published-unpushed: durable here, backed up nowhere"]
    Commit --> Reload["state.reload(): registry, schemas, values"]
```

A tick with no edit is a change: it records intent and bumps the revision without writing a value.

## Creating a product

```mermaid
flowchart TD
    Form["/p/new"] --> Check{"name, uid, environments, schema"}
    Check -->|"invalid"| Back["422: the form, refilled, errors by row"]
    Check --> Uid{"uid already claimed?"}
    Uid -->|"yes"| Back
    Uid --> Staged["One draft: PRODUCT_CREATION"]
    Staged --> Commit["Publish: services.yaml + schema + every env file, one commit"]
```

One draft, because a registry entry without its schema is a product nobody can open and a schema
without its entry is a file nothing reads.

## Retiring, then archiving

```mermaid
flowchart TD
    Mark["Mark as retiring"] --> RDraft["Draft: PRODUCT_RETIREMENT at service/retiring"]
    RDraft --> Act{"Act on it"}
    Act -->|"Revert, staged"| Drop["Draft dropped: nothing left this console"]
    Act -->|"Retire"| RCommit["Commit: schema gains retiring: true"]
    RCommit --> Seen["Read API reports retiring: true — consumers see it without restarting"]
    Seen --> Wait["An interval the operator chooses"]
    Wait --> Archive{"Archive the Product"}
    Archive -->|"Cancel archive"| Seen
    Archive -->|"Yes, Archive it"| ACommit["One commit, immediately"]
    ACommit --> Written["archived/&lt;name&gt;.yaml written"]
    ACommit --> Gone["services.yaml entry, schema, env files removed"]
    Gone --> Cold["A consumer restarting now gets 403 unknown_uid"]
```

The interval between the two steps is the design: a running consumer keeps its last-known-good
values and is told, through the read API, that the product is going.

## Failure, retry and fallback

```mermaid
flowchart TD
    Publish["publish()"] --> Commit["commit"]
    Commit --> Try{"push"}
    Try -->|"fails"| Keep["Committed and served locally; the console says 'not yet pushed'"]
    Keep --> Retry["Background retry every CONFIG_PUSH_RETRY_INTERVAL_MS"]
    Retry --> Try
    Webhook["GitHub push webhook"] --> Reload["pull, then reload"]
    Missed["Webhook never arrived"] --> Poll["Poll every CONFIG_POLL_INTERVAL_MS"] --> Reload
    ReloadFail["A part cannot be read"] --> LastGood["That part keeps its last known good value; the service stays up"]
```

## Rollback

| What | How |
|---|---|
| A published value | `git revert` the commit; the next reload serves the previous values |
| A published retirement | Revert on the retiring page, or revert the commit |
| An archive | `git revert` the archive commit: the entry, the schema and every environment come back, ciphertext intact |
| A draft | Drop it; nothing reached git |
| The service itself | Deploy the previous image; the repository is the state, and it is unchanged by a rollback |

## Database write and synchronization

```mermaid
flowchart TD
    Post[Console write] --> Validate[Validate and encrypt]
    Validate --> DB[Write db atomically]
    DB --> Rev[Increment revision]
    Rev --> Wake[Wake cache watchers]
    DB --> Journal[Append journal entry]
    Journal --> Timer[Manual, idle, or interval sync]
    Timer --> Mirror[Mirror db to config.bare]
    Mirror --> Commit[Commit changed files]
    Commit --> Push[Push remote]
    Push --> Retry[Retry when unavailable]
```
# Direct-write safety checkpoint — 2026-09-10

Direct-save flow refinement: read ciphertext and ETag → decrypt → validate → compare semantic values → encrypt changed values with incremented version → verify each secret field → compare-and-swap. A concurrent write returns conflict without installing the candidate. A no-op verifies its base without re-encryption.
