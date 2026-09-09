#!/usr/bin/env sh
#
# Decides where the local configuration repository should come from. Prints one of:
#
#   keep            a repository is already there; nothing to do
#   clone           clone CONFIG_GIT_REMOTE
#   seed <reason>   invent the sample history, because cloning cannot work
#
# Seeding invents a history. A seeded repository therefore shares no ancestor with the remote,
# `git merge-base` returns nothing, and no publish can ever be pushed — which is exactly the
# state this repository was found in. Cloning is the default whenever it can work.
#
# The age key is a precondition rather than a later discovery: a clone whose secrets cannot be
# decrypted is a console that looks broken instead of one that says it is unconfigured.
#
# The reason is printed because the fallback is silent otherwise, and a silent fallback after a
# rejected key recreates the divergence with nothing to show for it.
set -eu

repo="${1:?usage: repo-provenance.sh <repo-dir>}"

if [ -d "$repo/.git" ]; then
  echo "keep"
elif [ -z "${CONFIG_GIT_REMOTE:-}" ]; then
  echo "seed no git remote is configured, so there is nothing to clone"
elif [ -z "${CONFIG_AGE_KEY:-}" ]; then
  echo "seed a remote is configured but no age key is, and a clone's secrets would not decrypt"
else
  echo "clone"
fi
