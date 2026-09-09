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
