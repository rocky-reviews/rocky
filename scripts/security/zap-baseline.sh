#!/usr/bin/env sh
# OWASP ZAP baseline scan (passive DAST) of the real server (P7-3, ADR 0025).
#
#   pnpm security:zap
#
# Builds the web app, starts a throwaway Postgres (pinned dev image, random local port), applies
# the migrations, starts the server with webhooks, GitHub login (dummy client, never contacted)
# and the built web app on 127.0.0.1, then runs the pinned ZAP baseline container against it.
# Fails on any High or Medium alert (check-report.mjs) and on any alert not accepted in
# scripts/security/zap/rules.tsv. Reports go to artifacts/zap/ (gitignored): report.html,
# report.json, report.md, plus server.log.
#
# Every secret is generated for this run and never printed. Requires: docker, pnpm install.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

if ! docker_available; then
  echo "zap: Docker is required and must be running" >&2
  exit 2
fi

OUT="$ROOT/artifacts/zap"
PORT="${ZAP_SERVER_PORT:-4319}"
rm -rf "$OUT"
mkdir -p "$OUT"
# The ZAP container runs as its own user and writes the reports here.
chmod 777 "$OUT"
cp "$ROOT/scripts/security/zap/rules.tsv" "$ROOT/scripts/security/zap/hooks.py" "$OUT/"

DB=""
SERVER=""
cleanup() {
  if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null || true; fi
  if [ -n "$DB" ]; then docker rm -f "$DB" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

echo "zap: building the web app" >&2
pnpm --dir "$ROOT/apps/web" exec vite build --outDir "$OUT/web" --emptyOutDir --logLevel warn

echo "zap: starting a throwaway Postgres ($POSTGRES_IMAGE)" >&2
DB=$(docker run -d --rm \
  -e POSTGRES_USER=rocky -e POSTGRES_PASSWORD=rocky-dev-only -e POSTGRES_DB=rocky \
  -p 127.0.0.1::5432 \
  -v "$ROOT/deploy/dev/init.sql:/docker-entrypoint-initdb.d/00-init.sql:ro" \
  "$POSTGRES_IMAGE")
# TCP readiness: the init phase listens on the Unix socket only, so this is the final server.
tries=0
until docker exec "$DB" pg_isready -q -h 127.0.0.1 -U rocky -d rocky; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    echo "zap: Postgres did not become ready" >&2
    exit 1
  fi
  sleep 1
done
DB_PORT=$(docker port "$DB" 5432/tcp | head -n 1 | sed 's/.*://')

echo "zap: applying migrations" >&2
(cd "$ROOT" && DATABASE_ADMIN_URL="postgres://rocky:rocky-dev-only@127.0.0.1:$DB_PORT/rocky" \
  pnpm exec tsx scripts/migrate.ts >"$OUT/migrate.log" 2>&1)

random_hex() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'; }
random_b64() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'; }

echo "zap: starting the server on 127.0.0.1:$PORT" >&2
(
  cd "$ROOT/apps/server"
  DATABASE_URL="postgres://rocky_app_dev:rocky-dev-only@127.0.0.1:$DB_PORT/rocky" \
    HOST=127.0.0.1 PORT="$PORT" LOG_LEVEL=info \
    ROCKY_PUBLIC_URL="http://127.0.0.1:$PORT" \
    ROCKY_WEB_DIR="$OUT/web" \
    GITHUB_WEBHOOK_SECRET="$(random_hex)" \
    GITHUB_APP_CLIENT_ID="Iv23liZapBaselineOnly" \
    GITHUB_APP_CLIENT_SECRET="$(random_hex)" \
    ROCKY_SESSION_SECRET="$(random_hex)" \
    ROCKY_KEK_KEYS="zap=$(random_b64)" ROCKY_KEK_CURRENT=zap \
    exec pnpm exec tsx src/main.ts
) >"$OUT/server.log" 2>&1 &
SERVER=$!

tries=0
until curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ] || ! kill -0 "$SERVER" 2>/dev/null; then
    echo "zap: the server did not become healthy (see artifacts/zap/server.log)" >&2
    exit 1
  fi
  sleep 1
done

# Linux (CI): the container shares the host network. Docker Desktop: host.docker.internal.
if [ "$(uname -s)" = "Linux" ]; then
  NETWORK="--network host"
  TARGET="http://127.0.0.1:$PORT/"
else
  NETWORK=""
  TARGET="http://host.docker.internal:$PORT/"
fi

echo "zap: scanning $TARGET with $ZAP_IMAGE" >&2
set +e
# shellcheck disable=SC2086  # NETWORK is intentionally word-split
docker run --rm $NETWORK -v "$OUT:/zap/wrk:rw" "$ZAP_IMAGE" zap-baseline.py \
  -t "$TARGET" -c rules.tsv --hook=/zap/wrk/hooks.py \
  -J report.json -r report.html -w report.md -s
ZAP_STATUS=$?
node "$ROOT/scripts/security/zap/check-report.mjs" "$OUT/report.json"
CHECK_STATUS=$?
set -e

echo "zap: reports in artifacts/zap/ (zap-baseline exit $ZAP_STATUS, high/medium check exit $CHECK_STATUS)" >&2
if [ "$ZAP_STATUS" -ne 0 ] || [ "$CHECK_STATUS" -ne 0 ]; then
  exit 1
fi
