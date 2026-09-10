# Testing

## Strategy

Tests here are asked to answer one question: **would this fail if the behaviour regressed?** Three
habits follow from that, each learned from a test that passed while the code was wrong.

1. **Assert what reaches the page, not what is defined.** A CSS rule in the stylesheet and a class
   never attached to any element both "pass" a stylesheet assertion. Twice a rule existed and
   applied to nothing.
2. **Make the fixture contain the thing under test.** A test that archived a file and asserted its
   SOPS envelope survived passed against a fixture committed as **plain text** — there was no
   envelope to damage. Same for `version` leaking into the product list: the fixture had no
   version.
3. **Mutate the code and watch the test fail.** Every rule that matters has a recorded mutation:
   remove it, run the test, see red. A rule nothing fails for is a rule nobody is enforcing.

## Suites

| Suite | Count | What it covers |
|---|---|---|
| `tests/unit` | 39 files | Schema validation and building, drafts, the registry, notices, the rendered CSS and DOM, the browser scripts under jsdom |
| `tests/integration` | 20 files | The console end to end over Fastify inject, the read API over a real Unix socket, git behaviour against real repositories, SOPS round trips |

Notable ones: `every-page-state.test.ts` renders twelve page states and asserts four rules across
all of them, because a rule holds only where it is looked at. `key-form.test.ts` and
`ticks.test.ts` run the real browser scripts against real markup in jsdom rather than grepping
their source.

## Commands

```sh
make test                                   # the whole suite in the container
docker compose run --rm test pnpm vitest run tests/unit/schema-builder.test.ts
pnpm lint && pnpm typecheck                 # on the host
make check                                  # both, then the suite
```

The suite runs in Docker because two things it asserts do not exist on macOS: `SO_PEERCRED` and
`sops`. Tests needing them skip themselves elsewhere rather than pretending to pass.

## Fixtures

Repositories are real: `TestRepo` initialises one, commits into it, and can be given a bare remote
to push to. Age keys are generated per test. Nothing is mocked at the git or SOPS boundary,
because every interesting bug in this project lived exactly there.

## Known gaps

- **htmx behaviour cannot be tested here.** jsdom has no htmx, so the capture-phase interception
  that stops a click navigating before its confirmation appears passes every test while broken.
  It was caught in Chrome and is verified there.
- **Rendered pixels.** CSS assertions pin mechanisms (a font-size is declared, a row has a fixed
  height); alignment and spacing are checked in a browser.
- **The webhook path** is covered for signature handling, not against GitHub itself.
- **Archiving** is covered by integration tests; the only end-to-end archive against a real remote
  was performed by the operator.

## Data engine coverage

The product-write foundation adds `tests/unit/atomic-writes.test.ts` for ordered publication,
whole-request validation and ETags, expected absence, delete mutations, reader isolation,
parallel staging, unique revisions, corrupt payload refusal, and restart recovery.
`tests/integration/transaction-recovery.test.ts` launches a real writer process and kills it with
SIGKILL after schema, environment, registry, and revision writes. A fresh engine must recover
the complete tree at revision 1, retain attribution, and clean its private journal.
These tests verify process-crash recovery; actual hardware power-loss testing is not performed.

Run this slice's focused checks with:

```sh
pnpm exec vitest run tests/unit/atomic-writes.test.ts tests/unit/data-layer.test.ts tests/unit/db-topology-write-service.test.ts tests/unit/sync-engine.test.ts tests/integration/transaction-recovery.test.ts
pnpm typecheck
pnpm build
```

Unit tests cover atomic file writes, revisions, ETags, path-scoped conflicts, journal recovery,
flag validation and resolution, schema composition, synchronization, scheduling, and client
fallbacks. Integration coverage against a real Git mirror and a running database-backed server is
still required before general availability.
# Direct-write safety checkpoint — 2026-09-10

Additional regressions in tests/unit/db-config-write-service.test.ts cover document version increments, semantic no-op encryption avoidance, mixed encrypted/plaintext secret refusal, concurrent modification during encryption, and dependency-error redaction. tests/unit/db-topology-write-service.test.ts covers atomic refusal when the global schema changes during product encryption. The version, mixed-secret, and topology-conflict tests were observed failing before their fixes. Focused verification: pnpm exec vitest run tests/unit/db-config-write-service.test.ts tests/unit/db-topology-write-service.test.ts — 11 passed; pnpm typecheck passed. Full cutover/end-to-end verification remains outstanding.
