# Self-hosting Rocky

Rocky runs as two Node processes, a server and a worker, in front of one Postgres database. You
bring a GitHub App and an LLM provider (a hosted API with your own key, or a local model). This
section covers what you need to run it and keep it running.

| Page                                        | What it covers                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Setup](setup.md)                           | A fresh VM to the first analysed pull request with the containers and the setup wizard            |
| [Containers](../../deploy/README.md)        | The images, the compose file, how they are hardened and checked                                   |
| [Configuration reference](configuration.md) | Every environment variable the server, worker and command-line tools read                         |
| [Upgrades and migrations](upgrades.md)      | How migrations run, the database roles, backing up before an upgrade, rolling back                |
| [Backups and restore](backups.md)           | What must be backed up, what can be rebuilt from GitHub, dump and restore with RLS                |
| [Local models](local-models.md)             | Ollama, vLLM or any OpenAI-compatible server for each role and for embeddings, and what to expect |

Start with [Setup](setup.md): it uses the container images and the compose file
([deploy/README.md](../../deploy/README.md)), the quickest path. The rest of this page covers the
bare-metal path (Node and `pnpm` on a host you manage); the reference pages apply to both.

## What you need

- **Node 24.11 or later** and **pnpm 10** (the version is pinned in `package.json`, so
  `corepack enable` picks it up).
- **Postgres 15 or later with the `vector` extension (pgvector 0.5 or later)**. Development and
  the test suite use Postgres 17 with pgvector 0.8 (`docker-compose.dev.yml`); that is the tested
  combination. Postgres 15 is the floor because the migrations use `ON DELETE SET NULL (column)`,
  and pgvector 0.5 because the code index uses an HNSW index.
- **A superuser on that cluster, once**, to provision the extensions, the roles and the revokes
  the tenant isolation depends on ([Provisioning](upgrades.md#provisioning-once-per-database)).
- **A GitHub App** for your installation. The setup wizard creates one for you from its manifest
  (`ROCKY_SETUP=true`, see [Setup](setup.md); by hand: the [runbook](../runbooks/h3-create-github-app.md)).
- **An LLM provider for the completion roles**: the Anthropic API (the default), Amazon Bedrock,
  Google Vertex AI, Microsoft Foundry, or an [OpenAI-compatible server](local-models.md).
  Embeddings (the repository index and Ask) are optional and off by default.

## Running it (bare metal)

From a checkout of the release you are deploying:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @rocky-reviews/web exec vite build   # writes apps/web/dist
```

Point `ROCKY_WEB_DIR` at the absolute path of `apps/web/dist`: the server serves the web app
itself, with the same security headers as the API.

### Where the environment comes from

The convenience scripts are built for development and treat `.env` in the checkout specially:

| Command                                                           | `.env`                                                                                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:migrate`, `pnpm seed`, `pnpm mirror:rebuild`, `pnpm dev` | **Create it when it is missing**, from `.env.example` (development database URLs) plus a freshly generated `ROCKY_KEK_KEYS` development key, then load it. |
| `pnpm rocky`                                                      | Loads it when it exists.                                                                                                                                   |
| `pnpm evals`, and `tsx` run directly                              | Never read it: only the process environment counts.                                                                                                        |

Variables already in the process environment win over the file. That means a variable your
supervisor does not set is silently taken from the file, which may be a development default.

**Do not let the scripts create `.env` on a server.** Its generated KEK is a development key that
nothing backs up: if the server ever started with it and stored tokens, losing the file loses them
([backups](backups.md#the-encryption-keys)). Pick one of the two layouts and stick to it:

- **The supervisor supplies the environment** (preferred, from your secret store), and you call
  the entry points directly, so no file is involved:

  ```sh
  pnpm exec tsx scripts/migrate.ts                 # migrations, as the table owner
  pnpm exec tsx apps/server/src/main.ts            # HTTP API, webhooks, login; serves the web app
  pnpm exec tsx apps/worker/src/main.ts            # webhook inbox, analysis and index lanes, retention
  ```

- **A `.env` file you write yourself** (mode 0600, owned by the service user, every value
  production's, no development leftovers), loaded explicitly by every process:

  ```sh
  pnpm db:migrate                                  # reads your .env (it exists, so nothing is generated)
  pnpm exec tsx --env-file=.env apps/server/src/main.ts
  pnpm exec tsx --env-file=.env apps/worker/src/main.ts
  ```

### Starting

Run the migrations first ([upgrades](upgrades.md)), then start the server and the worker under
your process supervisor (systemd, for example). Set `NODE_ENV=production` for both. In production
the server refuses to start without the webhook secret, the GitHub App credentials, GitHub login,
a session secret, an https `ROCKY_PUBLIC_URL` and `ROCKY_TRUST_PROXY`; the
[configuration reference](configuration.md) marks each of these. Run one server instance: rate
limits are counted per instance, so several servers multiply them. Several workers can share the
queues (the per-org analysis limit holds across workers).

There is no `start` script or compiled build yet: the processes run from TypeScript through `tsx`,
as they do in development.

## Security notes for operators

- Keep the key-encryption keys (`ROCKY_KEK_KEYS`), the GitHub App private key, the webhook secret,
  the login client secret and the session secret in a secret manager. Never commit them and
  never put them in a backup next to the database dump ([Backups](backups.md#what-to-back-up)).
- Rocky's logs carry ids, sizes and hashes, never code, diffs, prompts, tokens or emails
  ([logging](../logging.md)). Variable values are never echoed in configuration errors; the
  error names the variable.
- Only a person posts reviews. Model output is validated JSON and never triggers a side effect,
  whatever model you run.
