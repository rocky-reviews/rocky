#!/usr/bin/env sh
# Pinned container images used by CI (.github/workflows/*) AND by the local
# scripts in this directory, so a local run is byte-for-byte the same scanner
# as CI. Every image is pinned by digest; the human-readable tag is a comment.
#
# Dependabot does not bump these (it only tracks `uses:` lines in workflows),
# so bump them by hand: `docker buildx imagetools inspect <image>:<tag>` prints
# the multi-arch index digest. Keep the comment in sync with the digest.

# shellcheck disable=SC2034  # variables are consumed by the sourcing script
GITLEAKS_IMAGE="ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f" # v8.30.1
# shellcheck disable=SC2034
SEMGREP_IMAGE="semgrep/semgrep@sha256:3db5c7af55eb1f512eac0abf0ab69a97b52c74b5e9a27314c221aee1a78d7ab2" # 1.181.1
# shellcheck disable=SC2034
OSV_SCANNER_IMAGE="ghcr.io/google/osv-scanner@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0" # v2.7.0
# shellcheck disable=SC2034
ACTIONLINT_IMAGE="rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667" # 1.7.12

# Lets git inside a root container read a checkout owned by another uid
# (GitHub runners check out as uid 1001). Harmless where uids already match.
# shellcheck disable=SC2034
GIT_SAFE_DIR_ENV="-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=*"

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}
