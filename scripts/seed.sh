#!/bin/sh
# Seeds a sample config repository into the app volume, so the UI has something to show.
#
# Generates a throwaway age key and prints it: put it in CONFIG_AGE_KEY to decrypt secrets.
set -e
REPO="${CONFIG_REPO_DIR:-/var/lib/config/repo}"

# Where the repository comes from. A seeded history shares no ancestor with the remote, so a
# seeded repository can never be pushed: clone whenever cloning can work.
DECISION="$(sh "$(dirname "$0")/repo-provenance.sh" "$REPO")"
case "$DECISION" in
  keep)
    echo "already seeded at $REPO"; exit 0 ;;
  clone)
    echo "cloning $CONFIG_GIT_REMOTE into $REPO"
    mkdir -p "$(dirname "$REPO")"
    # The service builds this itself at runtime; the clone happens before the service exists, so
    # it is built here too. IdentitiesOnly stops ssh offering an agent key ahead of the deploy
    # key and being refused for a repository that key can reach.
    if [ -n "${CONFIG_GIT_SSH_KEY:-}" ]; then
      GIT_SSH_COMMAND="ssh -i $CONFIG_GIT_SSH_KEY -o IdentitiesOnly=yes"
      if [ -n "${CONFIG_GIT_KNOWN_HOSTS:-}" ]; then
        GIT_SSH_COMMAND="$GIT_SSH_COMMAND -o UserKnownHostsFile=$CONFIG_GIT_KNOWN_HOSTS"
      fi
      export GIT_SSH_COMMAND
    fi
    if git clone "$CONFIG_GIT_REMOTE" "$REPO"; then
      echo "cloned $REPO"
      exit 0
    fi
    # The operator's decision: any failure falls back to seeding. Said loudly, because the
    # resulting repository cannot be pushed and the reason must not be lost.
    echo
    echo "!! the clone failed, so a fresh sample history is being seeded instead."
    echo "!! it will share no ancestor with $CONFIG_GIT_REMOTE and cannot be pushed."
    echo "!! fix the error above and re-run 'make reset && make dev' to clone properly."
    echo
    rm -rf "$REPO"
    ;;
  *)
    echo "seeding a sample repository: ${DECISION#seed }" ;;
esac

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
