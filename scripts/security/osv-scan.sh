#!/usr/bin/env sh
# Dependency vulnerability scan of pnpm-lock.yaml with osv-scanner (pinned
# container, same image as CI).
#
#   scripts/security/osv-scan.sh [project-dir]     (default: repo root)
#
# Exit 1 when any vulnerability of HIGH or CRITICAL severity (CVSS >= 7.0) is
# found, or when a vulnerability has no severity at all (fail closed: that is
# typical of malicious-package advisories, which have no CVSS score).
# Lower-severity findings are printed but do not fail the run.
# Requires: docker, jq.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

PROJECT_DIR=$(cd "${1:-$ROOT}" && pwd)
LOCKFILE="pnpm-lock.yaml"
THRESHOLD="7.0"

if [ ! -f "$PROJECT_DIR/$LOCKFILE" ]; then
  echo "osv-scan: $PROJECT_DIR/$LOCKFILE not found" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "osv-scan: jq is required (brew install jq / apt-get install jq)" >&2
  exit 2
fi
if ! docker_available; then
  echo "osv-scan: Docker is required and must be running" >&2
  exit 2
fi

echo "osv-scan: scanning $PROJECT_DIR/$LOCKFILE with $OSV_SCANNER_IMAGE" >&2

RESULT=$(mktemp)
trap 'rm -f "$RESULT"' EXIT

# osv-scanner exit codes: 0 = no vulns, 1 = vulns found, anything else = error.
set +e
docker run --rm -v "$PROJECT_DIR:/src:ro" -w /src "$OSV_SCANNER_IMAGE" \
  scan source --lockfile "$LOCKFILE" --format json --verbosity warn >"$RESULT"
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 1 ]; then
  echo "osv-scan: osv-scanner failed with exit code $STATUS" >&2
  cat "$RESULT" >&2
  exit "$STATUS"
fi

# One line per (package, vulnerability group): "<severity-or-empty> <pkg>@<ver> <ids>"
SUMMARY=$(jq -r '
  [ .results[]?.packages[]? as $p
    | $p.groups[]? as $g
    | { pkg: ($p.package.name + "@" + $p.package.version),
        ids: ($g.ids | join(",")),
        sev: ($g.max_severity // "") } ]
  | .[] | "\(.sev)\t\(.pkg)\t\(.ids)"' "$RESULT")

if [ -z "$SUMMARY" ]; then
  if [ "$STATUS" -eq 1 ]; then
    # osv-scanner says there are vulnerabilities but none could be parsed: the JSON format
    # changed or the output is truncated. Fail closed instead of passing silently.
    echo "osv-scan: osv-scanner reported vulnerabilities but the result could not be parsed" >&2
    cat "$RESULT" >&2
    exit 1
  fi
  echo "osv-scan: no known vulnerabilities in $LOCKFILE" >&2
  exit 0
fi

printf 'osv-scan: findings (severity = max CVSS score; empty = unknown)\n%s\n' "$SUMMARY" >&2

FAILING=$(printf '%s\n' "$SUMMARY" | awk -F'\t' -v t="$THRESHOLD" '$1 == "" || ($1 + 0) >= (t + 0)')
if [ -n "$FAILING" ]; then
  printf '\nosv-scan: FAIL — %s vulnerability group(s) at or above CVSS %s (or with unknown severity):\n%s\n' \
    "$(printf '%s\n' "$FAILING" | wc -l | tr -d ' ')" "$THRESHOLD" "$FAILING" >&2
  echo "Fix: upgrade the package. If an advisory does not apply, ignore it in osv-scanner.toml with a reason and an expiry." >&2
  exit 1
fi

echo "osv-scan: OK — only findings below CVSS $THRESHOLD" >&2
exit 0
