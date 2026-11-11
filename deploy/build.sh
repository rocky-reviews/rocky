#!/usr/bin/env sh
# Builds the three Rocky images locally from deploy/Dockerfile (P10-1, ADR 0043). Never pushes.
#
#   pnpm images:build                      rocky-server:local, rocky-worker:local, rocky-migrate:local
#   ROCKY_IMAGE_TAG=<tag> deploy/build.sh  another tag (ROCKY_IMAGE_PREFIX changes the name)
#
# Then `pnpm security:images` scans them and `pnpm images:smoke` boots the compose file with
# them. Requires: docker with BuildKit (buildx).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/security/images.sh
. "$ROOT/scripts/security/images.sh"

if ! docker_available; then
  echo "build: Docker is required and must be running" >&2
  exit 2
fi

PREFIX="${ROCKY_IMAGE_PREFIX:-rocky}"
TAG="${ROCKY_IMAGE_TAG:-local}"

for target in server worker migrate; do
  image="$PREFIX-$target:$TAG"
  echo "build: $image (target $target)" >&2
  docker buildx build --load \
    --file "$ROOT/deploy/Dockerfile" \
    --target "$target" \
    --tag "$image" \
    "$ROOT"
done

echo "build: done; uncompressed sizes (sum of the layers in docker history)" >&2
for target in server worker migrate; do
  image="$PREFIX-$target:$TAG"
  # `docker image inspect .Size` is the compressed size under the containerd image store and
  # the uncompressed one under overlay2; the layer sum is the uncompressed size on both.
  bytes=$(docker history --human=false --format '{{.Size}}' "$image" | awk '{ s += $1 } END { print s }')
  echo "  $image  $((bytes / 1000000)) MB" >&2
done
