#!/usr/bin/env bash
#
# Brings the whole service up so the editor works end to end, from nothing.
#
# Everything it creates is for LOCAL DEVELOPMENT: the age key and the break-glass password are
# generated here, printed once, and kept in the compose .env. None of it belongs on a real host.
set -euxo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m[dev-up %s] %s\033[0m\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

say "cwd=$(pwd) user=$(id -un) docker=$(docker --version 2>/dev/null || echo missing)"
say "compose project files: $(ls -1 docker-compose.yml Dockerfile.dev 2>&1)"

# --- the secrets compose passes in -------------------------------------------------------
# Kept in .env (gitignored) rather than exported per shell, so a restart does not invalidate
# the session cookie you are already holding.
touch .env
say "ensuring .env keys"
# Required in every environment now, not only prod: keying authentication off an environment
# string is what let one unset variable serve the console with no login on it.
if grep -q '^CONFIG_SESSION_SECRET=' .env 2>/dev/null; then
  say "CONFIG_SESSION_SECRET already set"
else
  say "writing CONFIG_SESSION_SECRET"
  printf 'CONFIG_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
fi
# IAM is expected on the host (health via host.docker.internal from Compose). Leave OIDC env
# unset to see "not configured"; set a dead CONFIG_IAM_HEALTH_URL to exercise break-glass.
# Where publishes go. Both are left empty by default: a local registry that pushes nowhere is a
# working registry, and pointing a sample repository at a real remote by default is not something
# a dev script gets to decide. Fill these in .env to turn pushing on:
#
#   CONFIG_GIT_REMOTE=git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git
#   CONFIG_DEPLOY_KEY=$HOME/.ssh/config-deploy-key
#
# The key should be a deploy key on that one repository, not a personal key: it is write-scoped
# and revocable on its own.
grep -q '^CONFIG_GIT_REMOTE=' .env 2>/dev/null || printf 'CONFIG_GIT_REMOTE=\n' >> .env
grep -q '^CONFIG_DEPLOY_KEY=' .env 2>/dev/null || printf 'CONFIG_DEPLOY_KEY=\n' >> .env
# Linking the served commit needs only this, not a key or a configured push.
grep -q '^CONFIG_REPO_WEB_URL=' .env 2>/dev/null || \
  printf 'CONFIG_REPO_WEB_URL=https://github.com/AnudeepChPaul/config.bare.anudeep.pro\n' >> .env

grep -q '^CONFIG_IAM_HEALTH_URL=' .env 2>/dev/null || {
  printf 'CONFIG_IAM_HEALTH_URL=http://host.docker.internal:8000/healthz\n' >> .env
}
say ".env keys present:"
grep -E '^[A-Z_]+=' .env | cut -d= -f1 | sort

say "Building app image (progress=plain)"
# The commit the image is built from, shown in the console footer so an operator can tell which
# build is in front of them. Exported rather than passed inline: compose reads it as a build arg.
BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
export BUILD_SHA
say "BUILD_SHA=${BUILD_SHA:-unset}"
docker compose build --progress=plain app

# --- the configuration repository --------------------------------------------------------
# Cloned, never generated. A history invented here shares no ancestor with the remote and can
# never be pushed, and the console gives no sign of it beyond saying "not yet pushed" forever.
say "checking whether /var/lib/config/repo/.git already exists in the app volume"
if docker compose run --rm --entrypoint sh app -c 'test -d /var/lib/config/repo/.git'; then
  say "repository already cloned; skipping seed"
else
  say "Cloning the configuration repository via seed.sh"
  docker compose run --rm -v ./scripts:/app/scripts:ro --entrypoint sh app /app/scripts/seed.sh
fi

# Nothing generates an age key any more, so this is the operator's own: the secret half of the
# recipient the remote's .sops.yaml encrypts to. Left empty, the clone above refuses to run and
# says so, which is the only place that can tell the difference.
grep -q '^CONFIG_AGE_KEY=' .env 2>/dev/null || printf 'CONFIG_AGE_KEY=\n' >> .env

# --- the break-glass credential ----------------------------------------------------------
# Without iam there is no other way to sign in, and the editor refuses to run unguarded.
#
# Written beside the repository, never into it. Committed, the credential is pushable, and on a
# repository with a remote the first publish sent it to GitHub — the reason a history had to be
# rewritten once already. A file the tree does not contain cannot be committed by accident.
say "checking for break-glass.yaml in the config volume"
if docker compose run --rm --entrypoint sh app -c 'test -f /var/lib/config/break-glass.yaml'; then
  say "break-glass.yaml already present"
else
  say "Minting a break-glass credential"
  pnpm tsx --conditions=development src/cli/bootstrap-breakglass.ts ops@anudeep.pro \
    > /tmp/config-break-glass.yaml 2> /tmp/config-break-glass.txt
  say "break-glass yaml bytes=$(wc -c < /tmp/config-break-glass.yaml) notes:"
  cat /tmp/config-break-glass.txt
  docker compose run --rm -v /tmp/config-break-glass.yaml:/tmp/record.yaml:ro --entrypoint sh app -c '
    set -x
    cp /tmp/record.yaml /var/lib/config/break-glass.yaml
    ls -l /var/lib/config/break-glass.yaml'
fi

say "Starting app service"
docker compose up -d app
docker compose ps
say "waiting for http://localhost:8200/login"
until curl -sv -o /dev/null http://localhost:8200/login; do
  say "login not ready yet; compose logs (last 20):"
  docker compose logs --tail=20 app || true
  sleep 1
done

say "Ready — http://localhost:8200"
cat <<'NOTE'
  Sign in with break-glass (iam is deliberately unreachable locally).
  The password was printed when the credential was minted; the six-digit code comes from
  the TOTP URI in the same output — scan it, or run:

      make code

NOTE
