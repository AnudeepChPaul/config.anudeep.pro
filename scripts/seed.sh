#!/bin/sh
# Seeds a sample config repository into the app volume, so the UI has something to show.
#
# Generates a throwaway age key and prints it: put it in CONFIG_AGE_KEY to decrypt secrets.
set -e
REPO="${CONFIG_REPO_DIR:-/var/lib/config/repo}"

if [ -d "$REPO/.git" ]; then echo "already seeded at $REPO"; exit 0; fi

mkdir -p "$REPO/config/iam" "$REPO/config/api" "$REPO/schema"
KEY_FILE="$(dirname "$REPO")/age.key"
age-keygen -o "$KEY_FILE" 2>/dev/null
RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$KEY_FILE" | head -1)"

cat > "$REPO/services.yaml" <<YAML
services:
  - name: iam
    uid: 1002
    namespaces: [iam/prod, iam/dev]
  - name: api
    uid: 1003
    namespaces: [api/prod]
YAML

cat > "$REPO/environments.yaml" <<'YAML'
# Which environment promotes into which, lowest first. Absent means no promotion is offered.
order: [dev, prod]
YAML

cat > "$REPO/schema/iam.yaml" <<YAML
keys:
  REGISTRATION_MODE:
    type: enum
    values: [open, invite_only, closed]
    description: Hot-toggle registration
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  KILL_PASSWORD_LOGIN:
    type: bool
    description: Passkey-only mode
  KILL_NEW_SESSIONS:
    type: bool
  IAM_READ_ONLY:
    type: bool
  FP_COMPONENTS:
    type: string[]
    description: Fingerprint components, comma separated
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
  SMTP_PASSWORD:
    type: string
    secret: true
YAML

cat > "$REPO/schema/api.yaml" <<'YAML'
keys:
  RATE_LIMIT:
    type: int
    min: 1
    max: 10000
YAML

cat > "$REPO/.sops.yaml" <<YAML
creation_rules:
  - path_regex: config/.*\.yaml\$
    encrypted_regex: "^(SMTP_PASSWORD)\$"
    age: $RECIPIENT
YAML

printf 'REGISTRATION_MODE: invite_only\nMFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n' > "$REPO/config/iam/prod.yaml"
printf 'REGISTRATION_MODE: open\n' > "$REPO/config/iam/dev.yaml"
printf 'RATE_LIMIT: 100\n' > "$REPO/config/api/prod.yaml"

cd "$REPO"
git init -q -b main
git add -A
git commit -q -m "Seed the configuration registry

Sample services, schemas and namespaces for local development."

echo "seeded $REPO"
echo
echo "age key written to $KEY_FILE. To decrypt secrets locally:"
echo "  export CONFIG_AGE_KEY=\"$(grep AGE-SECRET-KEY "$KEY_FILE")\""
