# ADR 0043: Container images and the self-host compose file

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-10
- **Task:** P10-1
- **Builds on:** [ADR 0005](0005-migrations-and-roles.md) (the migrator, `rocky_app` and the
  provisioning revokes), [ADR 0009](0009-installation-lifecycle.md) (the worker's own login),
  [ADR 0025](0025-security-headers-and-rate-limits.md) §2 (the server serves the built web app),
  [ADR 0033](0033-repository-access-check-wiring.md) (what production requires at boot)

## Context

Until now Rocky ran from source (`tsx`) on a workstation. Self-hosting needs images that a team
can run with one compose file: the server, the worker, the database and the migration step.
The acceptance criteria are Trivy 0 critical, every image under 250 MB, and containers that run
on a read-only root filesystem. Nothing is published yet: the owner has not approved pushing
images anywhere, so the pipeline builds, scans, generates an SBOM and signs without a registry,
and the push path stays off until a repository variable turns it on.

## Decision

### 1. Three images from one Dockerfile; the web app is static files inside the server image

`deploy/Dockerfile` has one builder stage and three final stages (`--target server|worker|migrate`):

- **Builder** (`node:24-trixie-slim`, pinned by digest): `pnpm install --frozen-lockfile`
  (the lockfile is the only input: `minimumReleaseAge`, `trustPolicy` and
  `blockExoticSubdeps` apply as on a workstation), `vite build` of `apps/web`, and
  `deploy/bundle.mjs`, which bundles each entrypoint with esbuild into one ESM file:
  `apps/server/src/main.ts`, `apps/worker/src/main.ts` and `scripts/migrate.ts`. The bundle
  carries every dependency except the tree-sitter grammars and `web-tree-sitter` (their `.wasm`
  is resolved at run time with `import.meta.resolve`, so the script copies exactly those
  packages, `package.json`, licence and `.wasm` only, into `dist/node_modules`) and `pg-native`
  (optional, never installed). The SQL migrations are copied next to the bundles
  (`packages/db` resolves `../migrations/` from its own URL, which inside the image is
  `/app/migrations`).
- **Final stages** (`gcr.io/distroless/nodejs24-debian13:nonroot`, pinned by digest): no shell,
  no package manager, no `pnpm`, `npm` or compiler; the process runs as uid 65532 (`nonroot`);
  the files are owned by root and read-only to the process; `NODE_ENV=production` is baked in,
  so the fail-closed rules of the server and the worker (required secrets, https public URL)
  apply by default. Each image has a `HEALTHCHECK` that runs a small Node script
  (`deploy/healthcheck/`): the server's fetches `/healthz` on the loopback; the worker's checks
  a heartbeat file the worker touches every 10 s (`ROCKY_HEARTBEAT_FILE`, on a tmpfs). The
  migrate image's command runs `migrate up` and exits.
- **The web app is static assets served by the server.** Vite's build goes into
  `/app/web` of the server image and `ROCKY_WEB_DIR=/app/web` is set there; the server reads
  it once at boot into a fixed route table under the same CSP and headers as the API
  (ADR 0025 §2). One origin, no second web server, no nginx image to patch, and the SPA cannot
  be served from a writable directory.

Why bundling, not `pnpm deploy` with `node_modules`: the apps import workspace packages by
their `.ts` sources (`exports` point at `src/*.ts`), so a runtime `node_modules` would need
either a loader (`tsx`, a build tool in the final stage) or a second set of package manifests.
One file per process is what Node runs natively, keeps the image at the base plus ~15 MB, and
leaves nothing in the image that `require` can load at run time but the bundle itself and the
grammars. The trade-off is that the image's own SBOM lists OS packages and the grammars only;
the bundled npm dependencies are in the lockfile SBOM generated next to it (§4).

### 2. `deploy/docker-compose.yml`: four services, three database roles, loopback ports

| Service    | Image / role                                                                      | Runs as                    | Writable paths                                       |
| ---------- | --------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| `postgres` | `pgvector/pgvector` (the dev digest, `scripts/security/images.sh`)                | `postgres` (uid 999)       | the data volume; tmpfs `/var/run/postgresql`, `/tmp` |
| `migrate`  | `rocky-migrate`, logs in as the **migrator** (`rocky`, owner, `CREATEROLE`)       | 65532, runs once and exits | none                                                 |
| `server`   | `rocky-server`, logs in as **`rocky_app_user`** (member of `rocky_app`)           | 65532                      | none                                                 |
| `worker`   | `rocky-worker`, logs in as **`rocky_worker_user`** (`rocky_app` + `rocky_worker`) | 65532                      | tmpfs `/tmp` (the heartbeat file), `noexec,nosuid`   |

- Every service: `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
  log rotation, `restart: unless-stopped` (the migrate step: `on-failure`).
- **Provisioning** (`deploy/postgres-init.sh`, run once by the Postgres entrypoint on an empty
  volume, as the superuser): the `vector` and `pgcrypto` extensions, the revokes of ADR 0005 §2,
  the migrator role (`LOGIN CREATEROLE`, not superuser, owner of the database, `USAGE` on
  `plpgsql` and `sql`). Nothing else: the group roles come from the migrations and the login
  roles from the migration step, exactly like the test harness (`packages/db/src/testing`).
  Passwords reach `psql` as variables (`:'name'`), never spliced into SQL text.
- **The migration step** (`scripts/migrate.ts up`, as the migrator) applies pending migrations,
  writes the retention settings and, when `ROCKY_DB_APP_PASSWORD` / `ROCKY_DB_WORKER_PASSWORD`
  are set, creates or updates the two login roles through `ensureLoginRole` (ADR 0005: a
  client-side SCRAM verifier, the role is verified to be a plain member of its groups before and
  after, anything with more privileges is refused). Re-running rotates passwords; the server and
  the worker start only after it exited 0 (`service_completed_successfully`).
- **Who sees which secret:** the superuser password reaches the `postgres` container only; the
  migrator password the `migrate` container only (`DATABASE_ADMIN_URL`); the app password the
  `migrate` and `server` containers; the worker password `migrate` and `worker`. The server
  refuses to boot on an owner or worker login and the worker on a login without `rocky_worker`
  (both existing checks), so a swapped URL fails closed. Application secrets (GitHub App, session
  key, KEKs, LLM keys) live in `deploy/rocky.env`, read by the server and the worker only; the
  compose-level variables (passwords, ports, image tags) in `deploy/.env`. Neither file enters
  the build context (`.dockerignore`) or an image.
- **Ports:** the server publishes `127.0.0.1:${ROCKY_PORT:-4310}` by default (a reverse proxy
  terminates TLS: `ROCKY_PUBLIC_URL` must be https in production, and `ROCKY_TRUST_PROXY` tells
  the server which forwarded header to trust); Postgres publishes nothing. `ROCKY_BIND` changes
  the bind address on purpose only.

### 3. CI: build, scan, size, smoke, SBOM, sign; publishing off by default

`.github/workflows/images.yml` (pull requests, pushes to `main`, a weekly schedule so a new CVE
in a pinned base is noticed, and `workflow_dispatch`):

1. `deploy/build.sh` builds the three images with BuildKit (loaded locally, never pushed).
2. `scripts/security/trivy.sh` (the pinned Trivy container, `scripts/security/images.sh`):
   `trivy config` over `deploy/` (Dockerfile misconfigurations, HIGH and CRITICAL; Trivy does not read compose files),
   then for each image `trivy image --scanners vuln,secret --severity CRITICAL --exit-code 1`
   (unfixed vulnerabilities count), an SPDX SBOM per image and one of the lockfile
   (`trivy fs`), and the size check (`docker image inspect`, under 250 MB).
3. `deploy/smoke.sh`: generated secrets, `docker compose up --wait`, `/healthz` answers
   `{"ok":true}` through the published loopback port, both services are healthy, and inside
   the running containers (`docker compose exec`, the Node binary is the only executable) a
   write to `/app`, `/etc` and `/home/nonroot` fails with `EROFS`, the process runs as 65532,
   and the host config has `ReadonlyRootfs`, `CapDrop=[ALL]` and `no-new-privileges`.
4. Keyless cosign via GitHub OIDC (`id-token: write` on this job only): `cosign sign-blob`
   over every SBOM and over the file of image digests, bundles verified in the same job with
   the workflow's identity, uploaded as artifacts. Skipped for pull requests from forks (no
   OIDC token there).
5. **`publish`** runs only when the repository variable `ROCKY_PUBLISH_IMAGES` is `"true"` and
   the event is a push to `main`: it pushes to `ghcr.io/<owner>/rocky-{server,worker,migrate}`,
   `cosign sign`s each digest and attaches the SBOM as an attestation. The variable does not
   exist until the maintainer creates it, so nothing is published by this task. The job is the
   only place with `packages: write`.

### 4. Pinned digests in one place

Base images are pinned by digest in the Dockerfile (the only place Docker reads them) and
repeated in `scripts/security/images.sh` with the Trivy image; `deploy/deploy.test.ts` fails
when the two drift. Bumping is by hand (`docker buildx imagetools inspect`), as for the scanner
images.

## Threat model

**Assets:** the images people run (integrity: what runs is what was built from this
repository's lockfile), the self-hoster's database (tenant data, encrypted tokens, the migrator
credentials), the application secrets in `rocky.env`, the host running compose, the SBOM and
signatures as evidence, logs free of secrets.

**Attackers:** a compromised or typosquatted npm package or base image (supply chain); a
contributor's PR that edits the Dockerfile, compose file or workflow; a process inside a
container after a remote code execution (through the server's HTTP surface or a model-steered
worker); a network neighbour of the host; someone reading image layers, build logs or CI
artifacts; an operator mistake (a swapped database URL, a port exposed by accident).

| #   | What can go wrong                                                                                                | Prevention                                                                                                                                                                                                                                                                                                                                           | Test                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Supply chain:** a dependency not in the lockfile, or a newer version, gets into the image                      | `pnpm install --frozen-lockfile` with the workspace's `minimumReleaseAge`, `trustPolicy: no-downgrade`, `blockExoticSubdeps`; `onlyBuiltDependencies` keeps postinstall scripts off except esbuild's; the bundle is built from that install; the lockfile SBOM lists what was bundled                                                                | `deploy.test.ts` (the Dockerfile installs with `--frozen-lockfile` and nothing else fetches packages); the image SBOM and lockfile SBOM in CI                                                                                                                     |
| S2  | **Base-image drift:** a tag moves to a vulnerable or tampered image                                              | Both bases pinned by digest; the Trivy image too; the weekly scheduled scan re-checks the pinned bases against new advisories; bumps are reviewed diffs                                                                                                                                                                                              | `deploy.test.ts` (every `FROM` has a digest and equals `images.sh`; the compose Postgres digest equals the dev one); `trivy image` fails CI on a critical                                                                                                         |
| S3  | **Secrets in layers or in the context:** `.env`, a PEM or a token copied into an image or printed in a build log | `.dockerignore` excludes `.env*`, `*.pem`, `*.key`, credentials files; the Dockerfile has no `ARG`/`ENV` for secrets and no `COPY` of a dotenv; secrets reach containers only through compose `environment`/`env_file`; Trivy's secret scanner runs over every image                                                                                 | `deploy.test.ts` (no secret-like `ENV`/`ARG`, no `.env` copy, `.dockerignore` entries); `trivy image --scanners secret`                                                                                                                                           |
| S4  | **Container escape surface:** code execution in a container reaches the host, another container or its own code  | Distroless (no shell, no package manager, no interpreter but Node), non-root uid 65532, `read_only` rootfs with the code owned by root, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs `noexec,nosuid,nodev` only where a file is written, no Docker socket or host mounts, no `privileged`, pids/log limits                                          | `deploy.test.ts` (every service has these options); `smoke.sh` (writes fail with `EROFS` inside the running containers, uid 65532, host config flags)                                                                                                             |
| S5  | **Migration role split lost:** the server or worker runs as the owner, or the migrator becomes a superuser       | Three logins with three passwords; only `migrate` gets `DATABASE_ADMIN_URL`; the server refuses owner, worker and superuser logins and the worker refuses the server's (existing boot checks); `ensureLoginRole` refuses a login with extra privileges; the migrator is `CREATEROLE`, not superuser; provisioning quotes passwords as psql variables | `provision-logins.db.test.ts` (roles end up as plain members; a role with `BYPASSRLS` is refused; both-or-neither variables); `deploy.test.ts` (which URL reaches which service); `smoke.sh` (the server's `/healthz` reports the database through the app login) |
| S6  | **Exposed ports:** the database or the server reachable from the network by default                              | Postgres has no `ports:`; the server binds `127.0.0.1` by default; https is required for `ROCKY_PUBLIC_URL` in production, so a TLS proxy sits in front; `ROCKY_TRUST_PROXY` documented next to it                                                                                                                                                   | `deploy.test.ts` (no Postgres port; the server's published port defaults to `127.0.0.1`); `smoke.sh` reaches the server through the loopback mapping only                                                                                                         |
| S7  | **A malicious PR changes the workflow to publish or to leak OIDC/registry credentials**                          | `permissions` are least-privilege per job (`contents: read` plus `id-token: write` on the signing job, `packages: write` on `publish` only); `publish` is gated on a repository variable and `push` to `main`; actions pinned by full SHA; forks get no OIDC token; `actionlint` runs on every workflow                                              | `deploy.test.ts` (pinned SHAs, the gate expression, no `packages: write` outside `publish`); `scripts/security/actionlint.sh`                                                                                                                                     |
| S8  | **An unhealthy container keeps serving or a wedged worker goes unnoticed**                                       | `HEALTHCHECK` per image; the server's hits `/healthz` (which checks the database); the worker's reads a heartbeat the event loop must refresh; compose starts the apps only after the migration step succeeded                                                                                                                                       | `heartbeat.test.ts`, `healthcheck.test.ts`; `smoke.sh` (`--wait` returns only when both are healthy; a stale heartbeat makes the worker check fail)                                                                                                               |
| S9  | **Secrets or code in logs:** the build, the smoke test or the healthcheck prints a URL with a password or a key  | The smoke test generates its secrets and prints only sizes, states and exit codes; the healthchecks print nothing; the migrate step logs migration names and settings only; the image build runs no step that echoes the environment                                                                                                                 | Review of `smoke.sh` output; `deploy.test.ts` forbids `echo $` of the password variables in the scripts                                                                                                                                                           |

## Consequences

- Self-hosting is `cp deploy/.env.example deploy/.env`, `cp deploy/rocky.env.example
deploy/rocky.env`, fill in both, `docker compose -f deploy/docker-compose.yml up -d --build`.
  The wizard (P10-2) and the docs (P10-3) build on these two files.
- Changing a `.wasm`-loading or file-reading dependency means checking it still works inside a
  bundle; the smoke test boots both processes, so a break is caught in CI.
- Image bumps (Node, distroless, Trivy) are manual and tested by the scheduled scan.

## Residual risks

- The grammars and `web-tree-sitter` are copied from the builder's `node_modules` by package
  name: a grammar added to `packages/indexer` without an entry in `deploy/bundle.mjs` is missing
  at run time (the chunker refuses the language; the worker logs it; analysis of that language is
  skipped, not silently wrong).
- `cosign sign-blob` on pull requests from the repository proves the signing path works; the
  signatures over published images are exercised only once `ROCKY_PUBLISH_IMAGES` is on.
- The compose file runs Postgres from the dev image. A self-hoster with a managed database runs
  `deploy/postgres-init.sh`'s SQL by hand as a superuser once (ADR 0005 §2).
- Node's own CVEs are found through the distroless base's Debian packages and the Node version
  pinned by the digest; Trivy does not read the Node binary itself. The bump path is the same.
