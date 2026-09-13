#!/bin/sh
# Puts the configuration repository into the app volume, by cloning the configured remote.
#
# It used to generate a sample registry instead. A generated history shares no ancestor with the
# remote, so `git merge-base` returned nothing, a rebase had nothing to sit on, and no publish
# could ever be pushed -- while the console looked healthy and said "not yet pushed" as though
# that were temporary. Every reset rebuilt exactly that repository. There is no sample any more:
# the registry is the remote, and a machine that cannot reach it stops and says so.
set -ex
REPO="${CONFIG_REPO_DIR:-/var/lib/config/repo}"

echo "[seed] REPO=$REPO CONFIG_GIT_REMOTE=${CONFIG_GIT_REMOTE:-} CONFIG_GIT_SSH_KEY=${CONFIG_GIT_SSH_KEY:-} CONFIG_GIT_KNOWN_HOSTS=${CONFIG_GIT_KNOWN_HOSTS:-}"

# Prints `keep` or `clone`, or exits non-zero explaining what is unconfigured.
PROVENANCE="$(dirname "$0")/repo-provenance.sh"
echo "[seed] running $PROVENANCE $REPO"
DECISION="$(sh "$PROVENANCE" "$REPO")"
echo "[seed] provenance decision=$DECISION"
if [ "$DECISION" = "keep" ]; then
  echo "[seed] already cloned at $REPO"
  ls -la "$REPO" || true
  git -C "$REPO" rev-parse --is-inside-work-tree
  git -C "$REPO" status -sb || true
  exit 0
fi

# The service builds this itself at runtime; the clone happens before the service exists, so it
# is built here too. IdentitiesOnly stops ssh offering an agent key ahead of the deploy key and
# being refused for a repository that key can reach.
if [ -n "${CONFIG_GIT_SSH_KEY:-}" ]; then
  GIT_SSH_COMMAND="ssh -v -i $CONFIG_GIT_SSH_KEY -o IdentitiesOnly=yes"
  if [ -n "${CONFIG_GIT_KNOWN_HOSTS:-}" ]; then
    GIT_SSH_COMMAND="$GIT_SSH_COMMAND -o UserKnownHostsFile=$CONFIG_GIT_KNOWN_HOSTS"
  fi
  export GIT_SSH_COMMAND
  echo "[seed] GIT_SSH_COMMAND=$GIT_SSH_COMMAND"
  ls -l "$CONFIG_GIT_SSH_KEY" || true
fi

echo "[seed] cloning $CONFIG_GIT_REMOTE into $REPO"
mkdir -p "$(dirname "$REPO")"
if ! git clone --progress --verbose "$CONFIG_GIT_REMOTE" "$REPO"; then
  # Left behind, a half-written directory would read as `keep` on the next run and the failure
  # would never be seen again.
  echo "[seed] clone failed; removing $REPO"
  rm -rf "$REPO"
  echo
  echo "the clone failed. nothing was seeded in its place: a local history invented here"
  echo "could never be pushed to $CONFIG_GIT_REMOTE."
  echo "check the deploy key and the remote above, then run 'make dev' again."
  exit 1
fi

echo "[seed] cloned $REPO"
git -C "$REPO" log -1 --oneline || true
git -C "$REPO" remote -v || true
ls -la "$REPO"
