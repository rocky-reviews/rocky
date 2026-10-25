#!/usr/bin/env sh
# Pre-commit hook (installed by simple-git-hooks on `pnpm install`).
# Scans the staged changes for secrets with gitleaks and blocks the commit on
# any finding. Fails closed: if gitleaks cannot run, the commit is refused.
#
# There is deliberately no skip switch. If gitleaks is wrong, add a narrowly
# scoped allowlist entry to .gitleaks.toml (with a comment saying why) instead.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)

if "$ROOT/scripts/security/gitleaks.sh" --staged; then
  exit 0
fi

cat >&2 <<'EOF'

pre-commit: commit blocked.
  - Findings above: remove the secret from the staged changes (and rotate it if it is real).
  - gitleaks unavailable: install it or start Docker (see instructions above), then retry.
EOF
exit 1
