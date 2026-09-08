#!/usr/bin/env bash
# Prints the current break-glass six-digit code, for signing in locally without an
# authenticator app. Reads the TOTP secret from the record committed in the dev repository.
set -euo pipefail
cd "$(dirname "$0")/.."

SECRET="$(docker compose run --rm --entrypoint sh app -c \
  'grep totpSecret /var/lib/config/repo/break-glass.yaml' 2>/dev/null \
  | sed 's/.*"\(.*\)".*/\1/' | tr -d '\r')"

cat > /tmp/config-totp.ts <<'TS'
import { decodeBase32 } from '@config/src/auth/base32.js';
import { generateTotp, totpCounter } from '@config/src/auth/totp.js';
process.stdout.write(
  generateTotp(decodeBase32(process.argv[2] ?? ''), {
    counter: totpCounter(Math.floor(Date.now() / 1000)),
    digits: 6,
  }) + '\n',
);
TS
cp /tmp/config-totp.ts ./.config-totp.ts
trap 'rm -f ./.config-totp.ts' EXIT
pnpm -s tsx --conditions=development ./.config-totp.ts "$SECRET"
