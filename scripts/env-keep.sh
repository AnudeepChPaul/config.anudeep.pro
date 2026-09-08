#!/usr/bin/env sh
#
# Rewrite an env file down to the settings named on the command line.
#
# `make reset` throws away the local repository, its age key and the break-glass credential —
# all of it regenerable. The git remote and the deploy key path are not: nobody can derive them,
# and losing them disarms publishing silently, because dev-up.sh then writes empty placeholders
# and compose mounts a directory where the key should be. So reset keeps those and drops the rest.
#
#   env-keep.sh <env-file> [KEY ...]
# POSIX sh: the image's /bin/sh is dash, which has no `pipefail`.
set -eu

file="${1:?usage: env-keep.sh <env-file> [KEY ...]}"
shift

[ -f "$file" ] || exit 0

kept=""
for key in "$@"; do
  # An empty placeholder is not a setting: carrying `CONFIG_DEPLOY_KEY=` across would look like
  # configuration while behaving like none. Only a line with a value survives.
  line="$(grep -m1 "^${key}=." "$file" || true)"
  # An `x && y` list is not a condition, so under `set -e` a key with no value would end the
  # script rather than skip the line.
  if [ -n "$line" ]; then
    kept="${kept}${line}
"
  fi
done

printf '%s' "$kept" > "$file"
