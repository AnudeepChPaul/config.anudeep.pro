# config.anudeep.pro

The configuration registry: one place to hold and edit every service's configuration, with git
as the database and a commit trail as the audit log.

## Running it locally

    make dev

That is the whole thing, from nothing: it builds the image, seeds a sample configuration
repository, generates an age key and a break-glass credential, and starts the service. The UI
is at **http://localhost:8200**.

It prints the break-glass password once — that is the only time it exists in readable form.
For the six-digit code:

    make code

Sign in with break-glass because **iam does not exist locally**: `make dev` points the
reachability check at a dead port, which is exactly what opens that path. The editor refuses to
run unauthenticated in prod, so this is how you get in.

    make logs     follow the service
    make reset    throw away the repository, drafts and credentials and start over
    make test     the suite, on Linux, where SO_PEERCRED and sops exist
    make check    lint and typecheck on the host, then the suite

## What is running

Two listeners with deliberately different exposure:

- the **editor** on `127.0.0.1:8200`, behind a session
- the **read API** on a Unix socket at `/run/config/config.sock`, which binds no TCP port at
  all — a service proves its identity by the uid the kernel reports for the socket peer, so
  nothing on the network can reach it whatever credentials it holds

Plus a webhook listener for GitHub pushes, and a background loop that retries unpushed commits
and re-reads the repository.

## The local secrets

`make dev` writes `.env` (gitignored) with a session signing key, the age key it generated, and
the dead-port health URL. IAM availability is checked once at startup and refreshed every 10
seconds; the default health endpoint is `http://127.0.0.1:8000/healthz`. All three are
development-only. On a real host the age key and the session secret come from the environment,
and the break-glass record is committed to the configuration repository SOPS-encrypted.

## Where the design lives

`markdown_plans/config.anudeep.pro/git-backed-config-registry-2026-09-07.md` carries the plan,
the decisions and the deviations from it. The console's design is a canvas linked from there.
