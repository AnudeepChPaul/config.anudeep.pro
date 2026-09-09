#!/usr/bin/env sh
#
# Decides where the local configuration repository comes from. Prints one of:
#
#   keep    a repository is already there; nothing to do
#   clone   clone CONFIG_GIT_REMOTE
#
# and exits non-zero, saying why, when neither is possible.
#
# There is no third answer. Seeding invented a history, so a seeded repository shared no
# ancestor with the remote: git merge-base returned nothing, a rebase had nothing to sit on, and
# no publish could ever be pushed. The console looked healthy the whole time and reported "not
# yet pushed" as though it were a transient state. Every reset rebuilt that same repository,
# which is why the condition survived several attempts to fix it.
#
# Stopping is therefore the behaviour, not a fallback: a registry that cannot reach its remote
# is a configuration problem to fix, and inventing a local one hides it.
#
# The age key is a precondition rather than something discovered later. A clone whose secrets
# will not decrypt is a console that looks broken instead of one that says it is unconfigured.
#
# POSIX sh: the image's /bin/sh is dash, which has no `pipefail`.
set -eu

repo="${1:?usage: repo-provenance.sh <repo-dir>}"

if [ -d "$repo/.git" ]; then
  echo "keep"
  exit 0
fi

if [ -z "${CONFIG_GIT_REMOTE:-}" ]; then
  echo "no git remote is configured, so there is nothing to clone." >&2
  echo "set CONFIG_GIT_REMOTE in .env and run again." >&2
  exit 1
fi

if [ -z "${CONFIG_AGE_KEY:-}" ]; then
  echo "a git remote is configured but no age key is, and the clone's secrets" >&2
  echo "would not decrypt. set CONFIG_AGE_KEY in .env and run again." >&2
  exit 1
fi

echo "clone"
