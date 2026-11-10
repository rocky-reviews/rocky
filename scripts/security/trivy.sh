#!/usr/bin/env sh
# Scans the Rocky images with Trivy (pinned container, same image as CI) and writes their SBOMs
# (P10-1, ADR 0043 §3). Run after `pnpm images:build`.
#
#   pnpm security:images
#
# 1. `trivy config` over deploy/ (Dockerfile misconfigurations, HIGH and CRITICAL).
# 2. For each image: the size limit (under 250 MB), `trivy image --scanners vuln,secret
#    --severity CRITICAL --exit-code 1` (unfixed vulnerabilities count; a secret in a layer
#    fails too), and an SPDX SBOM.
# 3. An SPDX SBOM of the lockfile: the npm dependencies bundled into the images (the image SBOM
#    lists OS packages and the on-disk grammars only).
# Reports go to artifacts/images/ (gitignored). Images are handed to Trivy as `docker save`
# tarballs: the scanner never gets the Docker socket. The vulnerability database is cached in
# the docker volume rocky-trivy-cache. Requires: docker.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

if ! docker_available; then
  echo "trivy: Docker is required and must be running" >&2
  exit 2
fi

PREFIX="${ROCKY_IMAGE_PREFIX:-rocky}"
TAG="${ROCKY_IMAGE_TAG:-local}"
SIZE_LIMIT_BYTES=250000000
OUT="$ROOT/artifacts/images"
rm -rf "$OUT"
mkdir -p "$OUT"
chmod 777 "$OUT"
CACHE="-v rocky-trivy-cache:/root/.cache/trivy"

trivy() {
  # shellcheck disable=SC2086  # CACHE is intentionally word-split
  docker run --rm $CACHE -v "$OUT:/out" -v "$ROOT:/src:ro" "$TRIVY_IMAGE" "$@"
}

echo "trivy: configuration scan of deploy/ with $TRIVY_IMAGE" >&2
trivy config --exit-code 1 --severity HIGH,CRITICAL /src/deploy

status=0
: >"$OUT/digests.txt"
for target in server worker migrate; do
  image="$PREFIX-$target:$TAG"
  bytes=$(docker image inspect --format '{{.Size}}' "$image")
  echo "trivy: $image is $((bytes / 1000000)) MB" >&2
  if [ "$bytes" -gt "$SIZE_LIMIT_BYTES" ]; then
    echo "trivy: $image is over the $((SIZE_LIMIT_BYTES / 1000000)) MB limit" >&2
    status=1
  fi
  docker image inspect --format '{{.Id}}' "$image" | sed "s|^|$image |" >>"$OUT/digests.txt"

  docker save "$image" -o "$OUT/$target.tar"
  echo "trivy: scanning $image (vulnerabilities, critical only; secrets)" >&2
  trivy image --input "/out/$target.tar" --scanners vuln,secret --severity CRITICAL \
    --exit-code 1 --no-progress --format table --output "/out/$target.trivy.txt" || status=1
  cat "$OUT/$target.trivy.txt" >&2
  echo "trivy: SBOM of $image" >&2
  trivy image --input "/out/$target.tar" --format spdx-json --no-progress \
    --output "/out/$target.spdx.json"
  rm -f "$OUT/$target.tar"
done

echo "trivy: SBOM of the lockfile (the bundled npm dependencies)" >&2
trivy fs --scanners vuln --format spdx-json --no-progress --output /out/lockfile.spdx.json /src/pnpm-lock.yaml

if [ "$status" -ne 0 ]; then
  echo "trivy: FAILED (see artifacts/images/)" >&2
  exit 1
fi
echo "trivy: OK, reports and SBOMs in artifacts/images/" >&2
