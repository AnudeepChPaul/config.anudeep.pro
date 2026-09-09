#!/usr/bin/env bash
#
# Brings the whole service up so the editor works end to end, from nothing.
#
# Everything it creates is for LOCAL DEVELOPMENT: the age key and the break-glass password are
# generated here, printed once, and kept in the compose .env. None of it belongs on a real host.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- the secrets compose passes in -------------------------------------------------------
# Kept in .env (gitignored) rather than exported per shell, so a restart does not invalidate
# the session cookie you are already holding.
touch .env
# Required in every environment now, not only prod: keying authentication off an environment
# string is what let one unset variable serve the console with no login on it.
grep -q '^CONFIG_SESSION_SECRET=' .env 2>/dev/null || {
  printf 'CONFIG_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
}
# iam does not exist locally. Pointing the health check at a dead port makes it unreachable,
# which is what opens the break-glass sign-in — the only way in without an identity provider.
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
  printf 'CONFIG_IAM_HEALTH_URL=http://127.0.0.1:1/healthz\n' >> .env
}

say "Building"
docker compose build app >/dev/null

# --- the configuration repository --------------------------------------------------------
if ! docker compose run --rm --entrypoint sh app -c 'test -d /var/lib/config/repo/.git' 2>/dev/null; then
  say "Seeding a configuration repository"
  docker compose run --rm -v ./scripts:/app/scripts:ro --entrypoint sh app /app/scripts/seed.sh
fi

# Seeding generates a fresh age key, and `make reset` leaves .env alone, so the key named there
# can belong to a volume that no longer exists. Appending only when absent left that stale key
# in place and every secret failed to decrypt with nothing saying why: overwrite whenever a key
# was generated. A clone generates none, and the operator's own key in .env is left untouched.
AGE_KEY="$(docker compose run --rm --entrypoint sh app -c 'grep AGE-SECRET-KEY /var/lib/config/age.key 2>/dev/null' 2>/dev/null | tr -d '\r')"
if [ -n "$AGE_KEY" ]; then
  # Never lose a key by overwriting it. The key in .env may be the operator's own -- the one
  # that decrypts the remote's secrets -- and a clone that failed falls back to seeding, which
  # would otherwise replace it with a throwaway. It may also be the only copy.
  PREVIOUS="$(grep '^CONFIG_AGE_KEY=.' .env 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$AGE_KEY" ]; then
    printf '# replaced on %s when a sample repository was seeded; the volume it belonged to is gone\n' \
      "$(date -u +%Y-%m-%d)" >> .env
    printf '# CONFIG_AGE_KEY=%s\n' "$PREVIOUS" >> .env
    say "Kept the previous age key in .env as a comment"
  fi
  ./scripts/env-set.sh .env CONFIG_AGE_KEY "$AGE_KEY"
else
  grep -q '^CONFIG_AGE_KEY=' .env 2>/dev/null || printf 'CONFIG_AGE_KEY=\n' >> .env
fi

# --- the break-glass credential ----------------------------------------------------------
# Without iam there is no other way to sign in, and the editor refuses to run unguarded.
# Written beside the repository, never into it. Committed, the credential is pushable, and on a
# repository with a remote the first publish sent it to GitHub — the reason a history had to be
# rewritten once already. A file the tree does not contain cannot be committed by accident.
if ! docker compose run --rm --entrypoint sh app -c 'test -f /var/lib/config/break-glass.yaml' 2>/dev/null; then
  say "Minting a break-glass credential"
  pnpm -s tsx --conditions=development src/cli/bootstrap-breakglass.ts ops@anudeep.pro \
    > /tmp/config-break-glass.yaml 2> /tmp/config-break-glass.txt
  docker compose run --rm -v /tmp/config-break-glass.yaml:/tmp/record.yaml:ro --entrypoint sh app -c '
    cp /tmp/record.yaml /var/lib/config/break-glass.yaml' >/dev/null
  cat /tmp/config-break-glass.txt
fi

say "Starting"
docker compose up -d app >/dev/null
until curl -sf -o /dev/null http://localhost:8200/login 2>/dev/null; do sleep 1; done

say "Ready — http://localhost:8200"
cat <<'NOTE'
  Sign in with break-glass (iam is deliberately unreachable locally).
  The password was printed when the credential was minted; the six-digit code comes from
  the TOTP URI in the same output — scan it, or run:

      make code

NOTE
