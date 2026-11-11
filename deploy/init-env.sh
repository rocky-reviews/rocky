#!/usr/bin/env bash
# Writes deploy/.env and deploy/rocky.env for a first start with the setup wizard (P10-2,
# docs/self-host/setup.md): fresh database passwords, a session secret and a key-encryption key,
# all random, and the public URL you pass. Never overwrites either file and prints no value.
#
#   deploy/init-env.sh https://rocky.example.com
#
# Afterwards, add your LLM key to deploy/rocky.env (ANTHROPIC_API_KEY, or ROCKY_LLM_* for another
# provider), then create the setup directory and start (the guide has both commands).
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
public_url="${1:-}"
if [[ ! "$public_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "usage: deploy/init-env.sh https://<host> (the https origin browsers and GitHub reach Rocky at, no path)" >&2
  exit 2
fi
for file in "$here/.env" "$here/rocky.env"; do
  if [[ -e "$file" ]]; then
    echo "refusing to overwrite ${file#"$here"/} (move it away first)" >&2
    exit 1
  fi
done
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

hex() { openssl rand -hex "$1"; }

cp "$here/.env.example" "$here/.env"
cp "$here/rocky.env.example" "$here/rocky.env"

# Values are hex or base64 (no `/` in hex; base64 is escaped for sed below), so they cannot
# break the substitutions.
set_value() {
  local file="$1" name="$2" value="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\/&|]/\\&/g')"
  sed -i.bak -e "s|^${name}=.*$|${name}=${escaped}|" "$file"
  rm -f "$file.bak"
  grep -q "^${name}=" "$file" || { echo "could not set ${name} in ${file#"$here"/}" >&2; exit 1; }
}

set_value "$here/.env" POSTGRES_PASSWORD "$(hex 24)"
set_value "$here/.env" ROCKY_DB_MIGRATOR_PASSWORD "$(hex 24)"
set_value "$here/.env" ROCKY_DB_APP_PASSWORD "$(hex 24)"
set_value "$here/.env" ROCKY_DB_WORKER_PASSWORD "$(hex 24)"

set_value "$here/rocky.env" ROCKY_PUBLIC_URL "$public_url"
# The TLS proxy runs on this host and the server is published on 127.0.0.1 only, so the one
# X-Forwarded-For hop it adds is the client (ADR 0025).
set_value "$here/rocky.env" ROCKY_TRUST_PROXY "xff:1"
set_value "$here/rocky.env" ROCKY_SESSION_SECRET "$(hex 32)"
set_value "$here/rocky.env" ROCKY_KEK_KEYS "prod=$(openssl rand -base64 32)"

chmod 600 "$here/.env" "$here/rocky.env"
echo "wrote deploy/.env and deploy/rocky.env (mode 600). Next: add your LLM key to deploy/rocky.env."
echo "Back up ROCKY_KEK_KEYS from deploy/rocky.env somewhere safe: without it stored tokens are lost."
