#!/usr/bin/env sh
# Secret scanning with gitleaks, using the repo's .gitleaks.toml.
#
#   scripts/security/gitleaks.sh                 scan the full git history
#   scripts/security/gitleaks.sh --range A..B    scan only the commits in A..B (CI, PR range)
#   scripts/security/gitleaks.sh --staged        scan staged changes only (pre-commit hook)
#
# Uses a local `gitleaks` binary when present, otherwise the pinned container
# image (same image as CI). Fails closed when neither is available.
# Secrets are always redacted from output.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

MODE="history"
RANGE=""
case "${1:-}" in
  "") ;;
  --staged) MODE="staged" ;;
  --range)
    MODE="range"
    RANGE="${2:?usage: gitleaks.sh --range <base>..<head>}"
    ;;
  *)
    echo "usage: $0 [--staged | --range <base>..<head>]" >&2
    exit 2
    ;;
esac

# Arguments after `git` are identical for the binary and the container because
# both run with the repo root as the working directory.
set -- git --config .gitleaks.toml --redact --verbose --no-banner --exit-code 1
case "$MODE" in
  staged) set -- "$@" --pre-commit --staged ;;
  range) set -- "$@" --log-opts="$RANGE" ;;
  history) ;;
esac

cd "$ROOT"
# Prefer the pinned container so local scans use exactly CI's rules; a local binary is only a
# fallback when Docker isn't running.
if docker_available; then
  echo "gitleaks: using container $GITLEAKS_IMAGE" >&2
  # shellcheck disable=SC2086  # GIT_SAFE_DIR_ENV is intentionally word-split
  exec docker run --rm -v "$ROOT:/repo:ro" -w /repo $GIT_SAFE_DIR_ENV "$GITLEAKS_IMAGE" "$@"
elif command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks: Docker unavailable; using local binary $(gitleaks version 2>/dev/null || echo '(unknown version)'). CI uses $GITLEAKS_IMAGE" >&2
  exec gitleaks "$@"
else
  cat >&2 <<'EOF'
gitleaks: neither a local `gitleaks` binary nor a running Docker daemon was found.
Refusing to continue without a secret scan (fail closed).

Install one of:
  - gitleaks binary:  brew install gitleaks        (https://github.com/gitleaks/gitleaks#installing)
  - Docker:           https://docs.docker.com/get-docker/  (then start the daemon)
EOF
  exit 1
fi
