#!/usr/bin/env sh
# Smoke test of the self-host compose file against the locally built images (P10-1, ADR 0043).
#
#   pnpm images:build && pnpm images:smoke
#
# Generates every secret for this run (printed nowhere), boots deploy/docker-compose.yml in a
# throwaway project on a free loopback port, and checks: the migration step exited 0, the server
# answers /healthz with ok:true through the published loopback port, both services are healthy,
# and inside the running containers the process is uid 65532, a write to /app, /etc, /home and /
# fails with EROFS (the worker's /tmp is the one writable path), while the host config carries
# ReadonlyRootfs, CapDrop=[ALL] and no-new-privileges; the worker image also loads every
# tree-sitter grammar the way the bundled chunker does. Everything is torn down at the end,
# including the database volume. Requires: docker compose v2, openssl.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

if ! docker_available; then
  echo "smoke: Docker is required and must be running" >&2
  exit 2
fi

PORT="${SMOKE_PORT:-4318}"
PROJECT="rocky-smoke-$$"
WORK=$(mktemp -d)
chmod 700 "$WORK"
COMPOSE="docker compose --project-name $PROJECT --project-directory $ROOT/deploy --env-file $WORK/.env --file $ROOT/deploy/docker-compose.yml"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "smoke: FAILED (exit $status); container states:" >&2
    $COMPOSE ps -a >&2 || true
    echo "smoke: last log lines of each service:" >&2
    $COMPOSE logs --tail 40 >&2 || true
  fi
  $COMPOSE down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

hex() { openssl rand -hex "$1"; }

# Compose-level variables (deploy/.env.example): passwords, the port, the images, and the
# application env file written below.
{
  echo "POSTGRES_PASSWORD=$(hex 24)"
  echo "ROCKY_DB_MIGRATOR_PASSWORD=$(hex 24)"
  echo "ROCKY_DB_APP_PASSWORD=$(hex 24)"
  echo "ROCKY_DB_WORKER_PASSWORD=$(hex 24)"
  echo "ROCKY_PORT=$PORT"
  echo "ROCKY_ENV_FILE=$WORK/rocky.env"
  echo "ROCKY_IMAGE_PREFIX=${ROCKY_IMAGE_PREFIX:-rocky}"
  echo "ROCKY_IMAGE_TAG=${ROCKY_IMAGE_TAG:-local}"
} >"$WORK/.env"

# The application env file (deploy/rocky.env.example) with the full production set: a throwaway
# RSA key stands in for the GitHub App's (GitHub is never reached with it), the public URL is
# https as production requires, every secret is random.
pem=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | awk '{ printf "%s\\n", $0 }')
{
  echo "ROCKY_PUBLIC_URL=https://rocky.smoke.invalid"
  echo "ROCKY_TRUST_PROXY=none"
  echo "LOG_LEVEL=info"
  echo "GITHUB_APP_ID=1"
  echo "GITHUB_APP_CLIENT_ID=Iv23liSmokeTestOnly0"
  echo "GITHUB_APP_CLIENT_SECRET=$(hex 20)"
  echo "GITHUB_WEBHOOK_SECRET=$(hex 32)"
  echo "GITHUB_APP_PRIVATE_KEY=\"$pem\""
  echo "ROCKY_SESSION_SECRET=$(hex 32)"
  echo "ROCKY_KEK_KEYS=smoke=$(openssl rand -base64 32)"
  echo "ROCKY_KEK_CURRENT=smoke"
} >"$WORK/rocky.env"
unset pem

echo "smoke: starting project $PROJECT on 127.0.0.1:$PORT" >&2
$COMPOSE up -d --wait --wait-timeout 240

echo "smoke: the migration step exited 0" >&2
migrate_id=$($COMPOSE ps -a -q migrate)
[ -n "$migrate_id" ]
[ "$(docker inspect --format '{{.State.ExitCode}}' "$migrate_id")" = "0" ]

echo "smoke: /healthz through the published loopback port" >&2
body=$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/healthz")
case "$body" in
  *'"ok":true'*) ;;
  *)
    echo "smoke: /healthz did not report ok:true" >&2
    exit 1
    ;;
esac

for service in server worker; do
  echo "smoke: $service is healthy and hardened" >&2
  id=$($COMPOSE ps -q "$service")
  [ -n "$id" ]
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$id")" = "healthy" ]
  [ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$id")" = "true" ]
  [ "$(docker inspect --format '{{.Config.User}}' "$id")" = "65532:65532" ]
  docker inspect --format '{{join .HostConfig.CapDrop ","}}' "$id" | grep -q '^ALL$'
  docker inspect --format '{{join .HostConfig.SecurityOpt ","}}' "$id" | grep -q 'no-new-privileges:true'
  [ "$(docker inspect --format '{{.HostConfig.Privileged}}' "$id")" = "false" ]
  # Inside the running container: the only executable is Node; the probe reads from stdin.
  $COMPOSE exec -T "$service" /nodejs/bin/node --input-type=module <"$ROOT/deploy/smoke-probe.mjs"
done

echo "smoke: the worker image loads every tree-sitter grammar from /app/node_modules" >&2
$COMPOSE exec -T worker /nodejs/bin/node --input-type=module <"$ROOT/deploy/smoke-grammars.mjs"

echo "smoke: image sizes, uncompressed (sum of the layers in docker history)" >&2
for target in server worker migrate; do
  image="${ROCKY_IMAGE_PREFIX:-rocky}-$target:${ROCKY_IMAGE_TAG:-local}"
  bytes=$(docker history --human=false --format '{{.Size}}' "$image" | awk '{ s += $1 } END { print s }')
  echo "  $image  $((bytes / 1000000)) MB" >&2
done

echo "smoke: OK" >&2
