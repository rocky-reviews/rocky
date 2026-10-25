#!/usr/bin/env bash
# Create the `cla-signatures` branch that .github/workflows/cla.yml commits CLA
# signatures to. CLA Assistant Lite cannot create the branch itself, and the
# branch must NOT be protected (the GITHUB_TOKEN of the workflow pushes to it).
# Idempotent.
#
#   scripts/github/setup-cla-branch.sh OWNER/REPO [SOURCE_BRANCH]   (SOURCE_BRANCH defaults to main)
set -euo pipefail

REPO="${1:?usage: $0 OWNER/REPO [SOURCE_BRANCH]}"
SOURCE="${2:-main}"
TARGET="cla-signatures"

command -v gh >/dev/null 2>&1 || { echo "error: gh is required" >&2; exit 2; }

if gh api "repos/$REPO/git/ref/heads/$TARGET" --jq .object.sha >/dev/null 2>&1; then
  echo "$TARGET already exists on $REPO — nothing to do"
  exit 0
fi

sha=$(gh api "repos/$REPO/git/ref/heads/$SOURCE" --jq .object.sha)
gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$TARGET" -f sha="$sha" --jq '.ref + " -> " + .object.sha'
echo "created $TARGET from $SOURCE@$sha"
