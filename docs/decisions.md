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

The direct-write cutover has landed: Save is live, ticks select Promote/Delete only, and
`DraftStore` is gone. Historical decisions below that depended on staging are marked obsolete or
reversed rather than deleted, so the reasoning survives.

The product toolbar is one idle span. Save is inserted into that span only while a live value
differs from what was loaded. Promote then Delete keys are inserted only while a key is ticked.
Nothing the line is not showing is left in the HTML. Delete is danger-coloured. Save still
writes the live values posted in the form.

Product schemas live at `schema/<product>.yaml`. The console and product writes do not use a
global `schema.yaml` for that. Creating a product writes that file; retirement, key deletion and
archive update or remove it.

What was chosen, what else was considered, and what it cost. Recorded because the reasoning is
the part that does not survive in the code.

## The registry is git

**Alternative:** a database with an audit table.
**Why:** every value that reaches a service is already a reviewable, attributable, revertible
commit. Rolling back is `git revert`, not a migration.
**Consequence:** everything is bounded by one repository on one host, and a draft — which is not
in git — is explicitly not durable.

## Drafts publish whole, and a draft is one press of Save — obsolete

**Status:** obsolete after the direct-write cutover.
**Why it existed:** a partial publish shipped a document nobody reviewed as a whole.
**Why it ended:** `db/` is the source of truth; Save writes live values. There is no draft and no
publish step left to protect.

## A tick is a change — reversed

**Status:** reversed.
**Was:** a tick without an edit still wrote a draft and bumped the revision.
**Now:** a tick selects keys for exactly two actions — Promote and Delete — and writes nothing.

## Nobody types a commit message

**Why:** an operator mid-incident has better things to do, and a generated subject cannot be left
as "wip".
**Consequence:** messages are generated as `[{service}-{env}] {date} {KEYS}`, one line per save.
Key *names* appear; values never do.

## A draft says what it is — obsolete

**Status:** obsolete. `Draft.kind` and `DraftStore` are gone with the draft model.

## Retiring is separate from archiving

**Alternative:** delete a product in one act.
**Why:** deletion looks harmless for exactly as long as nothing restarts. A running consumer keeps
its last-known-good cache and never learns the registry forgot it; a cold start gets 403.
**Consequence:** two steps with an operator-chosen interval, and the read API reports
`retiring: true` so a consumer can see it **without restarting** — the part none of the five
original options had.

## Archiving commits immediately — obsolete as an exception

**Status:** obsolete as a special case. Every write is immediate now; archive remains confirmation-
gated and sharp, but it is no longer "the one write that skips review".

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
audit medium. Database revisions wake consumers immediately. Git synchronization is off until the
operator turns **Auto sync** on (then idle + interval, and an immediate flush). While it is off,
pending work is confirmed with **Sync changes now**. This reverses the earlier decision that Git
itself was the registry.

## SOPS rules are read from the clone

**Why:** `.sops.yaml` is a git-reviewed encryption policy. `CONFIG_DB_PATH` holds live values and
only copies `.sops.yaml` on an empty first bootstrap. Pointing `SopsEncryptor` at `db/` made a
save of `SMTP_PASSWORD` return `secret_not_encrypted` while leaving live values unchanged.
A later save of a non-secret field refused with `secret values were not encrypted: SMTP_PASSWORD`
because the empty key is not ciphertext. Empty secrets are allowed to remain empty; a filled
secret that encryption left in plaintext is still refused.

## Feature flags are global booleans

`flags.yaml` contains globally unique flag names with boolean values per declared environment.
Flag names are TitleCase with optional digits (`NewCheckout`, `Checkout2`): they must start with
an uppercase letter and then contain only letters or digits. Underscores and leading digits are
refused. There is no targeting, rollout, context, or draft path. An absent environment value
resolves to false, which is the safe failure direction.

## Flag names are TitleCase — 2026-09-12

**Chosen:** `/^[A-Z][A-Za-z0-9]*$/` for flag names in `FlagValidator` and the Features add form.
**Rejected:** keep `UPPER_SNAKE_CASE`; allow camelCase or kebab-case.
**Why:** operators asked for TitleCase identifiers with number support (`Checkout2`).
**Consequence:** existing `NEW_CHECKOUT`-style names fail validation until renamed. Product schema
keys stay upper snake case.

# Direct-write safety checkpoint — 2026-09-10

Direct writers capture their base before expensive encryption and use explicit expected ETags, including null for absent files. Semantic no-op saves preserve ciphertext to avoid spurious versions from randomized encryption.

## Direct-write cutover — 2026-09-11

Staging existed to make "saved" mean something weaker than "live". Once `db/` became the source of
truth that middle state stopped paying for itself. Product creation, environment values, retirement,
archive, promote, and product-wide key delete all write through `ProductWriteOperations` /
`DBEngine.writeMany()`. The console says **Live now** and **Backed up to git**; nothing says Publish.
Pending `drafts.json` is discarded at boot (`discardLegacyWork`).

## Postgres request_sid logging — 2026-09-11

**Chosen:** IAM-shaped sink (`log.app_log` / `log.access_log`), minted `request_sid`, and field errors on the product page.
**Rejected:** stdout-only (no Postgres); shipping through `audit.anudeep.pro` ingest.
**Why:** promote failures already computed `ValidationError[]` but the console showed only "configuration is invalid". Operators debug IAM by request id in Postgres; this service uses `request_sid` (`sid_` prefix) and copies the same value into `request_id`.
**Consequence:** Compose owns `log-db` (`postgresql://config:config@log-db:5432/log`, host port 5435). `CONFIG_LOG_DATABASE_URL` may still be unset for a host process. Inbound `X-Request-Sid` is ignored; secret values are redacted or never passed to log fields.

## Compiled Eta console templates — 2026-09-12

**Chosen:** Option 4 — compile `.eta` files to JavaScript at build time (`pnpm eta:compile`), one runtime path of compiled functions, `render*` kept for routes and tests.
**Rejected:** file-based `eta.render` at request time; `@fastify/view` on the web app or Read API; Eta strings inside TypeScript; a second disk renderer for `tsx watch`.
**Why:** missing templates and syntax errors must fail at compile, not on the first operator request. Production must not read `.eta` from disk.
**Consequence:** `src/views/generated/` is gitignored and produced before test, typecheck, and build. Unused `@fastify/view` was removed. Tagged templates in `src/views` are gone; `escapeHtml` remains as Eta's `escapeFunction`.

## Unauthenticated console traffic starts IAM when it can — 2026-09-12

**Chosen:** Option 1 — automatic OIDC redirect. Guard and `GET /login` send the browser to `/login/iam?next=…` while IAM is reachable and OIDC is configured. Callback returns to a `safeNextPath` stored on the flow cookie. Logout still clears only `config_session`.
**Rejected:** click-through login page (Option 2); reverse-proxy identity headers (Option 3).
**Why:** the operator asked to be sent to IAM and back without an extra click, using the existing authorization-code + PKCE client.
**Consequence:** Compose `app` must reach IAM health (`host.docker.internal`, not a planted dead port) and must pass `CONFIG_IAM_*`. A missing OIDC trio still shows “not configured”, never the console and never break-glass. `/login?error=` does not auto-redirect.

## Local `https://iam.anudeep.pro` via host Caddy — 2026-09-12

**Chosen:** Option 1 — Caddy on the Mac, mkcert, `/etc/hosts`, Compose `extra_hosts` + `NODE_EXTRA_CA_CERTS`. Health stays on `:8000`.
**Rejected:** rewriting discovery URLs in `OidcClient`; changing local `TOKEN_ISSUER` to `host.docker.internal`.
**Why:** IAM already stamps `iss=https://iam.anudeep.pro`; the missing piece is that origin on loopback 443, not a second issuer string.
**Consequence:** `make iam-caddy`. Caddy binds `127.0.0.1` only. One mkcert SAN certificate covers `iam.anudeep.pro` and `config.anudeep.pro`. Local console URL is `https://config.anudeep.pro/`. Production Caddy is unchanged.

