#!/usr/bin/env bash
#
# Makes https://iam.anudeep.pro and https://config.anudeep.pro answer on this Mac (loopback 443)
# with one mkcert SAN certificate. IAM stays HTTP :8000; config stays HTTP :8200; Caddy is TLS.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m[iam-caddy %s] %s\033[0m\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'need %s on PATH\n' "$1" >&2
    exit 1
  }
}

upsert_env() {
  local key="$1" value="$2"
  python3 - "$key" "$value" <<'PY'
import sys
from pathlib import Path
key, value = sys.argv[1], sys.argv[2]
path = Path(".env")
lines = path.read_text().splitlines() if path.exists() else []
out, seen = [], False
for line in lines:
    if line.startswith(key + "="):
        out.append(f"{key}={value}")
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
}

need mkcert
need caddy

dir=deploy/local-iam-caddy
mkdir -p "$dir"
dir_abs="$(cd "$dir" && pwd)"
say "minting one SAN certificate for iam.anudeep.pro and config.anudeep.pro"
( cd "$dir_abs" && mkcert -cert-file local-anudeep.pem -key-file local-anudeep-key.pem \
    iam.anudeep.pro config.anudeep.pro )
test -f "$dir_abs/local-anudeep.pem" && test -f "$dir_abs/local-anudeep-key.pem"

caroot="$(mkcert -CAROOT)"
say "copying mkcert root CA for NODE_EXTRA_CA_CERTS"
cp "$caroot/rootCA.pem" "$dir/rootCA.pem"
upsert_env CONFIG_IAM_TLS_CA "$dir_abs/rootCA.pem"
upsert_env CONFIG_IAM_REDIRECT_URI 'https://config.anudeep.pro/login/callback'

hosts_line='127.0.0.1 iam.anudeep.pro config.anudeep.pro'
if grep -Eq '^[[:space:]]*127\.0\.0\.1[[:space:]].*iam\.anudeep\.pro' /etc/hosts \
  && grep -Eq '^[[:space:]]*127\.0\.0\.1[[:space:]].*config\.anudeep\.pro' /etc/hosts; then
  say "/etc/hosts already maps both names"
else
  say "add this line to /etc/hosts (once, needs administrator):"
  printf '  %s\n' "$hosts_line"
  printf '  sudo sh -c '\''printf %%s\\n "%s" >> /etc/hosts'\''\n' "$hosts_line"
fi

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q 'iam-anudeep-pro-db'; then
  say "registering HTTPS callback on IAM client config-local"
  docker exec iam-anudeep-pro-db-1 psql -U iam -d iam -v ON_ERROR_STOP=1 -c \
    "UPDATE oauth_client SET redirect_uris = ARRAY['https://config.anudeep.pro/login/callback','http://127.0.0.1:8200/login/callback']::text[] WHERE client_id = 'config-local' RETURNING client_id, redirect_uris;"
fi

say "recreate config app so extra_hosts, CA, and redirect URI apply"
docker compose up -d --force-recreate --no-deps app

say "start Caddy on 127.0.0.1:443 (may need sudo)"
if env IAM_CADDY_DIR="$dir_abs" caddy start --config "$dir_abs/Caddyfile"; then
  say "caddy started"
else
  say "caddy start failed — bind 443 usually needs:"
  printf '  sudo env IAM_CADDY_DIR=%s caddy start --config %s/Caddyfile\n' "$dir_abs" "$dir_abs"
fi
