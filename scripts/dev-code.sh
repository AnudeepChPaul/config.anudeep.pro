#!/usr/bin/env bash
# Prints the current break-glass six-digit code, for signing in locally without an
# authenticator app. Reads the TOTP secret from the record committed in the dev repository.
set -euxo pipefail
cd "$(dirname "$0")/.."

echo "[dev-code] cwd=$(pwd) inspecting break-glass.yaml in the app volume"
docker compose run --rm --entrypoint sh app -c 'ls -l /var/lib/config/break-glass.yaml; grep totpSecret /var/lib/config/break-glass.yaml'
SECRET="$(docker compose run --rm --entrypoint sh app -c \
  'grep totpSecret /var/lib/config/break-glass.yaml' \
  | sed 's/.*"\(.*\)".*/\1/' | tr -d '\r')"

echo "[dev-code] totp secret length=${#SECRET}"
if [ -z "$SECRET" ]; then
  echo "[dev-code] no totpSecret found" >&2
  exit 1
fi

cat > /tmp/config-totp.ts <<'TS'
import { decodeBase32 } from '@config/src/auth/base32.js';
import { generateTotp, totpCounter } from '@config/src/auth/totp.js';
process.stderr.write(`[dev-code] generating TOTP digits=6 now=${Date.now()}\n`);
process.stdout.write(
  generateTotp(decodeBase32(process.argv[2] ?? ''), {
    counter: totpCounter(Math.floor(Date.now() / 1000)),
    digits: 6,
  }) + '\n',
);
TS
cp /tmp/config-totp.ts ./.config-totp.ts
trap 'rm -f ./.config-totp.ts' EXIT
echo "[dev-code] running tsx .config-totp.ts"
pnpm tsx --conditions=development ./.config-totp.ts "$SECRET"
