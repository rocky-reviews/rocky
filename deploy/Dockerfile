# Rocky Reviews images (P10-1, ADR 0043). One builder, three final stages:
#
#   docker buildx build -f deploy/Dockerfile --target server  -t rocky-server:local  .
#   docker buildx build -f deploy/Dockerfile --target worker  -t rocky-worker:local  .
#   docker buildx build -f deploy/Dockerfile --target migrate -t rocky-migrate:local .
#
# (deploy/build.sh does all three.) The context is the repository root; .dockerignore keeps
# .git, node_modules and every dotenv, PEM or key file out of it. Base images are pinned by
# digest; the same digests are listed in scripts/security/images.sh (deploy/deploy.test.ts keeps
# them equal). Bump: `docker buildx imagetools inspect <image>:<tag>`.
#
# Builder: Node 24 slim + pnpm at the version package.json declares. `pnpm install
# --frozen-lockfile --ignore-scripts`: the lockfile is the only input and no lifecycle script
# runs (the workspace's minimumReleaseAge, trustPolicy and blockExoticSubdeps apply as on a
# workstation). Then the web app's Vite build and deploy/bundle.mjs (one ESM file per process).

FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS build
ENV CI=true
RUN npm install -g pnpm@10.34.8
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=rocky-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --dir apps/web exec vite build --outDir /out/web --emptyOutDir --logLevel warn
RUN node deploy/bundle.mjs /out/app

# Final stages: distroless Node 24 (no shell, no package manager), the process as uid 65532
# (`nonroot`), the files owned by root so the process cannot change its own code even on a
# writable filesystem, NODE_ENV=production so the fail-closed boot rules apply by default. The
# image's ENTRYPOINT is /nodejs/bin/node; CMD is the script. Each HEALTHCHECK runs a small Node
# script from deploy/healthcheck/.

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78 AS server
WORKDIR /app
COPY --from=build --chown=0:0 /out/app/server /app/server
COPY --from=build --chown=0:0 /out/web /app/web
COPY --chown=0:0 deploy/healthcheck/server.mjs /app/healthcheck.mjs
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4310
ENV ROCKY_WEB_DIR=/app/web
USER 65532:65532
EXPOSE 4310
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.mjs"]
CMD ["/app/server/main.mjs"]

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78 AS worker
WORKDIR /app
COPY --from=build --chown=0:0 /out/app/worker /app/worker
COPY --from=build --chown=0:0 /out/app/node_modules /app/node_modules
COPY --chown=0:0 deploy/healthcheck/worker.mjs /app/healthcheck.mjs
ENV NODE_ENV=production
USER 65532:65532
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.mjs"]
CMD ["/app/worker/main.mjs"]

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78 AS migrate
WORKDIR /app
COPY --from=build --chown=0:0 /out/app/migrate /app/migrate
COPY --from=build --chown=0:0 /out/app/migrations /app/migrations
ENV NODE_ENV=production
USER 65532:65532
# Runs to completion and exits; nothing to probe.
HEALTHCHECK NONE
CMD ["/app/migrate/main.mjs", "up"]
