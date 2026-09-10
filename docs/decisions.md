# Decisions

## Product-write migration: recoverable transactions precede direct flows

The approved product-write strategy selects one final cutover, with tests at internal slice
boundaries. Slice 1 adds a redo journal and ordered file replacement because separate atomic
renames cannot themselves make a multi-file operation atomic. Supported readers use the
publication lock or consistent snapshots; restart completes a durable intent before serving.

Payload staging can proceed independently for different products. Publication shares a short
lock because all writes advance one database revision; this also fixes lost revision increments
from simultaneous writes. Intents live under the private journal, separate from attribution,
and are excluded from sync. Product creation makes the registry visible last.

Draft removal and the reversal of tick/publish semantics are approved but have not landed in
this foundation slice. Their historical decisions below still describe the remaining legacy UI.

What was chosen, what else was considered, and what it cost. Recorded because the reasoning is
the part that does not survive in the code.

## The registry is git

**Alternative:** a database with an audit table.
**Why:** every value that reaches a service is already a reviewable, attributable, revertible
commit. Rolling back is `git revert`, not a migration.
**Consequence:** everything is bounded by one repository on one host, and a draft — which is not
in git — is explicitly not durable.

## Drafts publish whole, and a draft is one press of Save

**Alternative:** publish selected keys.
**Why:** a partial publish ships a document nobody reviewed as a whole.
**Consequence:** to hold a key back you undo the edit. Counts everywhere are in *saves*, not keys.

## A tick is a change

**Why:** "send this one along" is an intent worth recording, and five edits to a namespace should
be five version bumps.
**Consequence:** a tick with no edit still writes a draft and bumps the revision, and it writes no
value. It took two fixes to hold: once for keys with a committed value, once for keys without —
the second was silently dropped for months of session time.

## Nobody types a commit message

**Why:** an operator mid-incident has better things to do, and a generated subject cannot be left
as "wip".
**Consequence:** messages are generated as `[{service}-{env}] {date} {KEYS}`, one line per save.
Key *names* appear; values never do.

## A draft says what it is

**Alternative:** infer it — an empty change list, a namespace suffix, a schema path in the files.
**Why:** inference caught the wrong thing twice. A product whose keys declare no defaults moves no
key, exactly as a retirement does, so publish skipped its first environment file.
**Consequence:** `kind` is required; a draft without one is dropped. Making it required was the
useful part — the compiler then named every place a draft is created.

## Retiring is separate from archiving

**Alternative:** delete a product in one act.
**Why:** deletion looks harmless for exactly as long as nothing restarts. A running consumer keeps
its last-known-good cache and never learns the registry forgot it; a cold start gets 403.
**Consequence:** two steps with an operator-chosen interval, and the read API reports
`retiring: true` so a consumer can see it **without restarting** — the part none of the five
original options had.

## Archiving commits immediately

**Alternative:** stage it like everything else.
**Why:** the operator's call, on a rare and deliberate act reachable only from the retiring list.
**Consequence:** the one write here that skips review. Mitigated by the product already being
visibly retiring, by an inline confirmation, and by reverting cleanly. It remains the sharpest
edge in the console.

## An archive keeps each environment verbatim

**Alternative:** merge the environments into one document, or re-encrypt them together.
**Why:** every namespace file carries its own SOPS envelope and its own MAC. Merging destroys
both.
**Consequence:** `archived/<name>.yaml` is a file of files, and nothing is decrypted in order to
archive it.

## Notices travel as codes

**Why:** `?notice=<text>` let any link render words inside the console in its own voice — escaped,
so not script injection, but believed for exactly that reason.
**Consequence:** the server owns every sentence; an unknown code renders nothing.

## Both settings refusals are 404

**Alternative:** 403 for a signed-in operator who is not allowed.
**Why:** a 403 confirms the page exists, and what is on it is a map of the deployment.
**Consequence:** the link is rendered from the same predicate that gates the route, so a link can
never lead to a 404.

## The break-glass credential lives outside the repository

**Why:** it was committed once, and a commit is pushable — it reached GitHub and forced a history
rewrite.
**Consequence:** an absolute `CONFIG_BREAK_GLASS_PATH` reads from the volume. A relative one still
reads from the tree, so an older volume still boots.

## `make reset` does not touch `.env`

**Why:** it deleted the git remote and the deploy key path, which nothing can derive. Compose then
mounted a *directory* where the key belonged and every push failed with "Permission denied
(publickey)" long after the reset that caused it.
**Consequence:** reset removes volumes only.

## A file format field lands in three steps

**Why:** requiring a field before writing it leaves one deploy that cannot read its own registry.
**Consequence:** accept, migrate, require — used for `version` on `services.yaml` and the schemas.
Requiring it broke 267 tests at once, which is the honest blast radius of a required field.

## Git is a backup medium, not the database

The authoritative registry state is stored under `db/`. Git remains a synchronized backup and
audit medium. Database revisions wake consumers immediately; synchronization is manual, idle
triggered, and periodic. This reverses the earlier decision that Git itself was the registry.

## Feature flags are global booleans

`flags.yaml` contains globally unique flag names with boolean values per declared environment.
There is no targeting, rollout, context, or draft path. An absent environment value resolves to
false, which is the safe failure direction.
# Direct-write safety checkpoint — 2026-09-10

Direct writers capture their base before expensive encryption and use explicit expected ETags, including null for absent files. Semantic no-op saves preserve ciphertext to avoid spurious versions from randomized encryption. This checkpoint does not reverse the remaining legacy console behavior; draft-removal decision reversals must be finalized with that cutover.
