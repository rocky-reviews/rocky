#!/usr/bin/env sh
# Lints .github/workflows/*.yml with actionlint (pinned container, same image
# as CI). Includes shellcheck for `run:` blocks. Exits non-zero on any error.
# Requires: docker.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

if ! docker_available; then
  echo "actionlint: Docker is required and must be running" >&2
  exit 2
fi

echo "actionlint: linting $ROOT/.github/workflows with $ACTIONLINT_IMAGE" >&2
exec docker run --rm -v "$ROOT:/repo:ro" -w /repo "$ACTIONLINT_IMAGE" -color
