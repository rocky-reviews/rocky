# Self-hosting Rocky

Rocky runs as two Node processes, a server and a worker, in front of one Postgres database. You
bring a GitHub App and an LLM provider (a hosted API with your own key, or a local model). This
section covers what you need to run it and keep it running.

| Page                                        | What it covers                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Configuration reference](configuration.md) | Every environment variable the server, worker and command-line tools read                         |
| [Upgrades and migrations](upgrades.md)      | How migrations run, the database roles, backing up before an upgrade, rolling back                |
| [Backups and restore](backups.md)           | What must be backed up, what can be rebuilt from GitHub, dump and restore with RLS                |
| [Local models](local-models.md)             | Ollama, vLLM or any OpenAI-compatible server for each role and for embeddings, and what to expect |

These pages cover the bare-metal path (Node and `pnpm` on a host you manage). The container images
and the self-host compose file are documented separately in `deploy/README.md`.

## What you need

- **Node 24.11 or later** and **pnpm 10** (the version is pinned in `package.json`, so
  `corepack enable` picks it up).
- **Postgres 15 or later with the `vector` extension (pgvector 0.5 or later)**. Development and
  the test suite use Postgres 17 with pgvector 0.8 (`docker-compose.dev.yml`); that is the tested
  combination. Postgres 15 is the floor because the migrations use `ON DELETE SET NULL (column)`,
  and pgvector 0.5 because the code index uses an HNSW index.
- **A superuser on that cluster, once**, to provision the extensions, the roles and the revokes
  the tenant isolation depends on ([Provisioning](upgrades.md#provisioning-once-per-database)).
- **A GitHub App** for your installation. The server can create one for you from its manifest
  (`GITHUB_APP_SETUP=true`, see the [runbook](../runbooks/h3-create-github-app.md)).
- **An LLM provider for the completion roles**: the Anthropic API (the default), Amazon Bedrock,
  Google Vertex AI, Microsoft Foundry, or an [OpenAI-compatible server](local-models.md).
  Embeddings (the repository index and Ask) are optional and off by default.

## Running it (bare metal)

From a checkout of the release you are deploying:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env          # then fill it in; see the configuration reference
pnpm db:migrate               # as the table owner (DATABASE_ADMIN_URL)
pnpm --filter @rocky-reviews/web exec vite build   # writes apps/web/dist
```

Point `ROCKY_WEB_DIR` at the absolute path of `apps/web/dist`: the server serves the web app
itself, with the same security headers as the API.

Then start the two processes under your process supervisor (systemd, for example), each with the
environment from your secret store rather than a file on disk where you can:

```sh
pnpm exec tsx apps/server/src/main.ts   # HTTP API, webhooks, login; serves the web app
pnpm exec tsx apps/worker/src/main.ts   # webhook inbox, analysis and index lanes, retention
```

Set `NODE_ENV=production` for both. In production the server refuses to start without the
webhook secret, the GitHub App credentials, GitHub login, a session secret, an https
`ROCKY_PUBLIC_URL` and `ROCKY_TRUST_PROXY`; the [configuration reference](configuration.md)
marks each of these. Run one server instance: rate limits are counted per instance, so several
servers multiply them. Several workers can share the queues (the per-org analysis limit holds
across workers).

There is no `start` script or compiled build yet: the processes run from TypeScript through `tsx`,
as they do in development. The container images are the packaged form of the same commands.

## Security notes for operators

- Keep the key-encryption keys (`ROCKY_KEK_KEYS`), the GitHub App private key, the webhook secret,
  the login client secret and the session secret in a secret manager. Never commit them and
  never put them in a backup next to the database dump ([Backups](backups.md#what-to-back-up)).
- Rocky's logs carry ids, sizes and hashes, never code, diffs, prompts, tokens or emails
  ([logging](../logging.md)). Variable values are never echoed in configuration errors; the
  error names the variable.
- Only a person posts reviews. Model output is validated JSON and never triggers a side effect,
  whatever model you run.
