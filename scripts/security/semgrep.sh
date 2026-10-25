#!/usr/bin/env sh
# Static analysis with Semgrep (pinned container, same image as CI).
#
#   scripts/security/semgrep.sh [project-dir]     (default: repo root)
#
# Rulesets: p/typescript, p/nodejs, p/secrets, p/owasp-top-ten (fetched from
# the public Semgrep registry). Exits 1 on any finding. Metrics are off.
# Requires: docker.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

PROJECT_DIR=$(cd "${1:-$ROOT}" && pwd)

if ! docker_available; then
  echo "semgrep: Docker is required and must be running" >&2
  exit 2
fi

echo "semgrep: scanning $PROJECT_DIR with $SEMGREP_IMAGE" >&2
# shellcheck disable=SC2086  # GIT_SAFE_DIR_ENV is intentionally word-split
exec docker run --rm -v "$PROJECT_DIR:/src:ro" -w /src $GIT_SAFE_DIR_ENV \
  -e SEMGREP_SEND_METRICS=off \
  "$SEMGREP_IMAGE" semgrep scan \
  --config p/typescript \
  --config p/nodejs \
  --config p/secrets \
  --config p/owasp-top-ten \
  --metrics=off \
  --disable-version-check \
  --error \
  --exclude node_modules --exclude dist --exclude coverage --exclude design-poc \
  .
