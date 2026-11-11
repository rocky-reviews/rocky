# deploy/

Container images and the self-host compose file (P10-1, [ADR 0043](../docs/adr/0043-container-images-and-self-host-compose.md)).
The full self-hosting guide (configuration reference, upgrades, backups) is P10-3's.

| File                                    | What                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Dockerfile`                            | One builder, three distroless non-root final stages: `server` (API + the built web app), `worker`, `migrate` |
| `bundle.mjs`                            | Builds one ESM file per process with esbuild, plus the migrations and the tree-sitter grammars               |
| `docker-compose.yml`                    | Postgres (pgvector) → migration step (owner) → server and worker (their own logins), all read-only           |
| `.env.example`                          | Compose-level variables: database passwords, port, image names, retention                                    |
| `rocky.env.example`                     | The application's configuration (GitHub App, secrets, LLM keys), read by the server and the worker           |
| `postgres-init.sh`                      | One-time provisioning on an empty volume: extensions, the ADR 0005 revokes, the migrator role                |
| `healthcheck/`                          | The `HEALTHCHECK` scripts of the server (`/healthz`) and the worker (heartbeat file)                         |
| `build.sh`, `smoke.sh`                  | Build the images locally; boot the compose file with generated secrets and check it                          |
| `smoke-probe.mjs`, `smoke-grammars.mjs` | Run inside the containers by the smoke test: uid 65532 and `EROFS` writes; every grammar loads               |
| `deploy.test.ts`                        | The policy these files keep (digests, no secrets, hardening, role split, ports, workflow permissions)        |
| `dev/`                                  | The development database's init SQL (`docker-compose.dev.yml`)                                               |

## Run it

```sh
cp deploy/.env.example deploy/.env           # passwords: openssl rand -hex 24
cp deploy/rocky.env.example deploy/rocky.env # the GitHub App, secrets, LLM key
docker compose -f deploy/docker-compose.yml up -d --build
curl http://127.0.0.1:4310/healthz           # {"ok":true,"database":true}
```

The server is published on `127.0.0.1:4310` only; put a TLS-terminating reverse proxy in front
and set `ROCKY_PUBLIC_URL` (https) and `ROCKY_TRUST_PROXY` in `rocky.env`. Upgrading is
`docker compose -f deploy/docker-compose.yml up -d --build`: the migration step runs again
before the apps restart.

## Check it

```sh
pnpm images:build      # rocky-server:local, rocky-worker:local, rocky-migrate:local
pnpm security:images   # Trivy: 0 critical, no secrets; size < 250 MB; SBOMs in artifacts/images/
pnpm images:smoke      # compose up with generated secrets; health, read-only FS, uid 65532
```

CI runs the same three steps and signs the SBOMs with cosign (`.github/workflows/images.yml`).
Images are not published anywhere: the `publish` job stays off until a maintainer creates the
repository variable `ROCKY_PUBLISH_IMAGES` with the value `true`.
