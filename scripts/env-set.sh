#!/usr/bin/env sh
#
# Set one key in a dev env file, replacing it if it is already there.
#
#   env-set.sh <env-file> <KEY> <VALUE>
#
# `make reset` deliberately leaves .env alone, which means a value can outlive the thing it
# describes: reset deletes the volume, seeding generates a new age key, and .env still names the
# old one. Appending only when a key is absent left that stale key in place and every secret
# quietly failed to decrypt, so seeding overwrites instead.
#
# POSIX sh: the image's /bin/sh is dash, which has no `pipefail`.
set -eu

file="${1:?usage: env-set.sh <env-file> <KEY> <VALUE>}"
key="${2:?usage: env-set.sh <env-file> <KEY> <VALUE>}"
value="${3-}"

touch "$file"

# Rewritten rather than edited in place: a value holds ':' and '/' (a remote) or arbitrary
# base64 (an age key), and none of it should ever be read as part of an expression.
tmp="$file.env-set.$$"
grep -v "^${key}=" "$file" > "$tmp" || true
printf '%s=%s\n' "$key" "$value" >> "$tmp"
mv "$tmp" "$file"
