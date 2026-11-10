# Configuration reference

Rocky is configured through environment variables only (12-factor). This page lists every
variable the server, the worker and the command-line tools read. A test
(`scripts/docs/config-keys.test.ts`) compares this page with the code: it fails when the code
reads a variable that has no row here, and when a row names a variable the code does not read.
`.env.example` is the annotated starting point for local development; this page is the reference.

General rules:

- **Empty counts as unset** for every variable below, except four the code reads as given:
  an empty `PORT` makes the server listen on a random port, an empty `HOST` is not
  `0.0.0.0`, an empty `LOG_LEVEL` is not a level the logger accepts, and an empty
  `DATABASE_URL` leaves the Postgres driver to its own `PG*` variables and defaults. Leave
  these unset rather than empty.
- **Values are never printed.** A refused value stops the process with an error that names the
  variable and the rule, never the value.
- **Production** means `NODE_ENV=production`, or `FLY_APP_NAME` set (the Fly.io platform sets
  it), so a deployment that forgets `NODE_ENV` still fails closed. Several variables are
  required in production and optional in development; the tables say which.
- **Keys are named, never given, for LLM providers.** A `*_API_KEY_ENV` variable holds the _name_
  of the variable that holds the key, and the adapters read the key at call time.
- **Typos are refused** for the families that have a fixed list: an unknown `ROCKY_LLM_*` or
  `ROCKY_RATE_LIMIT_*` variable stops the process instead of being ignored.

"Read by" names the process: **server** (`apps/server`), **worker** (`apps/worker`, also
`pnpm mirror:rebuild`), **migrate** (`pnpm db:migrate`), **seed** (`pnpm seed`), **cli**
(`pnpm rocky analyze`, [docs/cli.md](../cli.md)), **evals** (`pnpm evals`), **web dev** (the Vite
dev server and build).

## Runtime and network

| Variable            | Read by        | Default                               | Meaning                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`          | server, worker | unset                                 | `production` turns on the production rules (required secrets, https only, no setup routes).                                                                                                                                                                                                                                                                   |
| `FLY_APP_NAME`      | server, worker | unset                                 | Set by Fly.io. Counts as production, and decides which `ROCKY_TRUST_PROXY` modes are accepted. Do not set it yourself elsewhere.                                                                                                                                                                                                                              |
| `HOST`              | server         | `0.0.0.0`                             | Address the server listens on. Behind a reverse proxy on the same host, `127.0.0.1`.                                                                                                                                                                                                                                                                          |
| `PORT`              | server         | `4310`                                | Port the server listens on.                                                                                                                                                                                                                                                                                                                                   |
| `LOG_LEVEL`         | server, worker | `info`                                | Pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. Logs never carry code, diffs, prompts, tokens or emails at any level ([logging](../logging.md)).                                                                                                                                                                                  |
| `ROCKY_PUBLIC_URL`  | server         | `http://HOST:PORT` outside production | Where browsers reach Rocky, an origin with no path. **Required in production, https only.** http is accepted only on `127.0.0.1`, `localhost` or `[::1]` in development, so the default works only with a loopback `HOST`; with `HOST=0.0.0.0` (the default) set it explicitly or login and app setup refuse to start. CSRF checks accept this origin only.   |
| `ROCKY_TRUST_PROXY` | server         | `none` outside production             | Which client address the rate limits count. `none`: the socket's peer, forwarded headers ignored (refused on Fly.io). `fly`: `Fly-Client-IP` (only on Fly.io). `xff:<hops>`: the n-th `X-Forwarded-For` entry from the right, 1 to 9; safe only when the origin accepts traffic from the proxy alone. **Required in production.** The mode is logged at boot. |
| `ROCKY_WEB_DIR`     | server         | unset                                 | Absolute path of the built web app (`apps/web/dist`). The server serves it with the API's security headers. Unset in development, where Vite serves the app.                                                                                                                                                                                                  |

## Database

The three logins are different roles on purpose ([upgrades](upgrades.md#database-roles)). The
server refuses to start on a login that is the owner, the migrator, a superuser, a `BYPASSRLS`
role or the worker's login.

| Variable              | Read by       | Default  | Meaning                                                                                                                                                                  |
| --------------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`        | server, seed  | required | The application login: a plain member of `rocky_app`, row-level security enforced. Set it: unset or empty, the Postgres driver falls back to its `PG*` variables.        |
| `WORKER_DATABASE_URL` | worker, seed  | required | The worker's login: a member of `rocky_app` and `rocky_worker`. Only the worker creates orgs, claims webhook inbox rows and erases orgs. Never use it as `DATABASE_URL`. |
| `DATABASE_ADMIN_URL`  | migrate, seed | required | The table owner (migrator). Runs migrations and writes the retention settings. Never given to the server or the worker.                                                  |

## Retention

Retention periods are settings in the database that only the migrator writes. **`pnpm db:migrate`
writes all of them on every run**, from its own environment, so set the same values wherever
migrations run; an unset variable puts its period back to the default. Values are whole days.

| Variable                            | Read by | Default | Meaning                                                                                                     |
| ----------------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `RETENTION_ANALYSES_DAYS`           | migrate | `90`    | Analyses older than this are purged. At least 1.                                                            |
| `RETENTION_LOGS_DAYS`               | migrate | `30`    | Finished background jobs older than this are purged. At least 1.                                            |
| `RETENTION_AUDIT_DAYS`              | migrate | `365`   | Audit events older than this are purged. At least 30.                                                       |
| `ORG_DELETION_GRACE_DAYS`           | migrate | `7`     | Days between scheduling an org's deletion (for example the app was uninstalled) and erasing it. At least 1. |
| `RETENTION_WEBHOOK_DELIVERIES_DAYS` | migrate | `30`    | Webhook inbox retention and redelivery dedup window. At least 7.                                            |
| `RETENTION_LLM_USAGE_DAYS`          | migrate | `730`   | LLM usage rows (tokens and cost per call). At least 400.                                                    |
| `RETENTION_MEMORY_DECAY_DAYS`       | migrate | `90`    | Days without a citation before a learned memory entry loses a confidence step. At least 1.                  |
| `RETENTION_MEMORY_UNUSED_DAYS`      | migrate | `365`   | Days without a citation before a learned memory entry is removed. At least 30.                              |
| `RETENTION_MEMORY_SUPERSEDED_DAYS`  | migrate | `180`   | Days a superseded memory entry is kept as history. At least 7.                                              |

## Encryption keys

Envelope encryption ([ADR 0006](../adr/0006-envelope-encryption.md)): each org's data key is
stored wrapped by a key-encryption key (KEK) that never touches the database. Back the KEKs up
separately from the database ([backups](backups.md#the-encryption-keys)).

| Variable            | Read by | Default             | Meaning                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROCKY_KEK_KEYS`    | server  | unset               | Comma-separated `<id>=<base64 of 32 random bytes>` entries, for example `k1=<base64>,k2=<base64>`. Required when GitHub login is on (user tokens are stored encrypted). Weak keys (not 32 bytes, too few distinct byte values) are refused. Generate one with `openssl rand -base64 32`.                                                                                                     |
| `ROCKY_KEK_CURRENT` | server  | the last listed key | The id that wraps new data keys. Every listed key still unwraps. Rotation today means adding a new key and making it current: orgs that already have a data key keep it wrapped by the key that wrapped it, and there is no re-wrap command yet. **Never remove a key from `ROCKY_KEK_KEYS`**: the data keys it wrapped would become unreadable ([backups](backups.md#the-encryption-keys)). |

## GitHub App

| Variable                   | Read by             | Default                              | Meaning                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`            | server, worker, cli | unset                                | The app's numeric id. **Required in production** (the worker verifies installation events with it; login keeps only this app's installations).                                                                                                                                           |
| `GITHUB_APP_PRIVATE_KEY`   | server, worker, cli | unset                                | The app's RSA private key (PEM, 2048 bits or more; multi-line, or with `\n`). **Required in production.** Without it in development, installation events wait in the inbox and every route that reads a repository's data answers 503. Removed from the process environment once parsed. |
| `GITHUB_WEBHOOK_SECRET`    | server              | unset                                | The webhook secret, at least 32 characters (`openssl rand -hex 32`). **Required in production.** Unset in development disables `POST /webhooks/github`.                                                                                                                                  |
| `GITHUB_APP_CLIENT_ID`     | server              | unset                                | The app's OAuth client id for GitHub login. Set both client variables or neither. **Required in production.** Unset in development turns login off.                                                                                                                                      |
| `GITHUB_APP_CLIENT_SECRET` | server              | unset                                | The app's OAuth client secret. The app's callback URL must be `<ROCKY_PUBLIC_URL>/auth/github/callback`.                                                                                                                                                                                 |
| `ROCKY_SESSION_SECRET`     | server              | generated per process in development | HMAC key for the login cookie and CSRF tokens, at least 32 printable characters (`openssl rand -hex 32`). **Required in production.** Changing it signs everyone out.                                                                                                                    |
| `GITHUB_URL`               | server, worker, cli | `https://github.com`                 | GitHub Enterprise Server's web URL (https only).                                                                                                                                                                                                                                         |
| `GITHUB_API_URL`           | server, worker, cli | `<GITHUB_URL>/api/v3` on GHES        | GitHub's API URL, when it is not the default for `GITHUB_URL`.                                                                                                                                                                                                                           |

### One-time app setup

The server can create the GitHub App from its manifest ([runbook](../runbooks/h3-create-github-app.md),
[ADR 0008](../adr/0008-github-app-manifest.md)). These variables matter only while
`GITHUB_APP_SETUP=true`; remove them once the app exists. Setup writes the credentials to a file
that also holds a `GITHUB_APP_SLUG` line for your reference; Rocky does not read that one.

| Variable                      | Read by | Default                                                 | Meaning                                                                                                                                                                                           |
| ----------------------------- | ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_SETUP`            | server  | unset                                                   | `true` opens the one-time setup routes (the URL is printed in the terminal). Refused in production; ignored once `GITHUB_APP_ID` is set or the credentials file exists. Not supported on Windows. |
| `GITHUB_APP_NAME`             | server  | `Rocky Reviews`                                         | The new app's name on GitHub.                                                                                                                                                                     |
| `GITHUB_APP_HOMEPAGE_URL`     | server  | `ROCKY_PUBLIC_URL`                                      | The app's homepage (https).                                                                                                                                                                       |
| `GITHUB_APP_WEBHOOK_URL`      | server  | `<ROCKY_PUBLIC_URL>/webhooks/github` when that is https | Where GitHub delivers webhooks (https), for example a smee.io channel in local development.                                                                                                       |
| `GITHUB_APP_CREDENTIALS_FILE` | server  | `~/.rocky/github-app.env`                               | Absolute path the credentials are written to, once, with mode 0600.                                                                                                                               |

## Analysis and indexing

| Variable                         | Read by | Default   | Meaning                                                                                                                                                          |
| -------------------------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROCKY_ANALYSIS_AUTO`            | worker  | `off`     | `on`: every new head of an open pull request a webhook reports is queued and analysed. Off, nothing is analysed (and nothing spends) until someone asks.         |
| `ROCKY_ANALYSIS_TOKEN_LIMIT`     | worker  | `150000`  | Per-PR token estimate above which an analysis waits for "Analyze anyway"; no model is called. 1,000 to 10,000,000.                                               |
| `ROCKY_ANALYSIS_CONCURRENCY`     | worker  | `4`       | Analyses this worker runs at once. 1 to 32.                                                                                                                      |
| `ROCKY_ANALYSIS_ORG_CONCURRENCY` | worker  | `2`       | Analyses one org runs at once, across every worker. 1 to 32.                                                                                                     |
| `ROCKY_INDEX_AUTO`               | worker  | `off`     | `on`: pushes to a repository's default branch re-index the changed files. Needs an embedding model (`ROCKY_LLM_EMBED_PROVIDER`), or the worker refuses to start. |
| `ROCKY_INDEX_TOKEN_LIMIT`        | worker  | `5000000` | Tokens one index run may embed before it waits for "Index anyway". 10,000 to 500,000,000.                                                                        |

## Rate limits

Each limit is `<max>/<window seconds>` (window at most 86400). Malformed values and unknown names
stop the server; there is no way to turn a limit off. Limits are counted per server instance
([ADR 0025](../adr/0025-security-headers-and-rate-limits.md)).

| Variable                                | Read by | Default     | Counts                                                                       |
| --------------------------------------- | ------- | ----------- | ---------------------------------------------------------------------------- |
| `ROCKY_RATE_LIMIT_AUTH_LOGIN`           | server  | `30/600`    | Login starts, per client address.                                            |
| `ROCKY_RATE_LIMIT_AUTH_CALLBACK`        | server  | `30/600`    | Login callbacks, per client address.                                         |
| `ROCKY_RATE_LIMIT_AUTH_LOGOUT`          | server  | `30/600`    | Logouts, per client address.                                                 |
| `ROCKY_RATE_LIMIT_AUTH_SESSION`         | server  | `300/60`    | Session reads (the web app polls it), per client address.                    |
| `ROCKY_RATE_LIMIT_WEBHOOK_IP`           | server  | `600/60`    | Webhook deliveries, per client address.                                      |
| `ROCKY_RATE_LIMIT_WEBHOOK_INSTALLATION` | server  | `600/60`    | Webhook deliveries, per installation.                                        |
| `ROCKY_RATE_LIMIT_DIFF`                 | server  | `10/60`     | Pull request diff reads, per member.                                         |
| `ROCKY_RATE_LIMIT_DIFF_ORG`             | server  | `15/60`     | Diff reads that go to GitHub, per org (each costs the installation's quota). |
| `ROCKY_RATE_LIMIT_ASK`                  | server  | `10/60`     | Ask questions, per member, every request.                                    |
| `ROCKY_RATE_LIMIT_ASK_DAY`              | server  | `200/86400` | Ask questions, per member per day.                                           |
| `ROCKY_RATE_LIMIT_ASK_ORG`              | server  | `60/60`     | Ask questions about to be answered, per org.                                 |
| `ROCKY_RATE_LIMIT_ASK_ORG_DAY`          | server  | `600/86400` | Ask questions about to be answered, per org per day.                         |

## LLM roles

Rocky calls models in four completion roles and one embedding role
([ADR 0012](../adr/0012-llm-roles-and-provider-port.md)). With nothing set, every completion role
runs on the Anthropic API with these defaults, and embeddings are off:

| Role   | Default model       | Default effort | Used for                                                    |
| ------ | ------------------- | -------------- | ----------------------------------------------------------- |
| triage | `claude-haiku-5-5`  | low            | Sorting files by risk before the review                     |
| review | `claude-opus-5-5`   | high           | Findings                                                    |
| graph  | `claude-sonnet-5-5` | medium         | The change map                                              |
| ask    | `claude-sonnet-5-5` | medium         | Answering questions about a pull request (needs embeddings) |

The server reads these too, for Ask. Effort is `low`, `medium`, `high`, `xhigh` or `max`, as far
as the provider and model support it (an OpenAI-compatible server takes `low`, `medium` and
`high`). On `openai-compatible` the model is required and there is no default effort.

| Variable                          | Read by                    | Default              | Meaning                                                                                                                                                                                                  |
| --------------------------------- | -------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROCKY_LLM_PROVIDER`              | server, worker, cli, evals | `anthropic`          | Moves every completion role to another provider: `anthropic`, `bedrock`, `vertex`, `foundry` or `openai-compatible`.                                                                                     |
| `ROCKY_LLM_TRIAGE_PROVIDER`       | server, worker, cli, evals | `ROCKY_LLM_PROVIDER` | The triage role's provider.                                                                                                                                                                              |
| `ROCKY_LLM_TRIAGE_MODEL`          | server, worker, cli, evals | `claude-haiku-5-5`   | The triage role's model.                                                                                                                                                                                 |
| `ROCKY_LLM_TRIAGE_EFFORT`         | server, worker, cli, evals | `low`                | The triage role's effort.                                                                                                                                                                                |
| `ROCKY_LLM_TRIAGE_PLATFORM_MODEL` | server, worker, cli, evals | derived              | Bedrock, Vertex and Foundry only: the literal id to send (a Bedrock inference profile or ARN, a Vertex dated id, a Foundry deployment name). The model stays the canonical id effort is checked against. |
| `ROCKY_LLM_REVIEW_PROVIDER`       | server, worker, cli, evals | `ROCKY_LLM_PROVIDER` | The review role's provider.                                                                                                                                                                              |
| `ROCKY_LLM_REVIEW_MODEL`          | server, worker, cli, evals | `claude-opus-5-5`    | The review role's model.                                                                                                                                                                                 |
| `ROCKY_LLM_REVIEW_EFFORT`         | server, worker, cli, evals | `high`               | The review role's effort.                                                                                                                                                                                |
| `ROCKY_LLM_REVIEW_PLATFORM_MODEL` | server, worker, cli, evals | derived              | As for triage.                                                                                                                                                                                           |
| `ROCKY_LLM_GRAPH_PROVIDER`        | server, worker, cli, evals | `ROCKY_LLM_PROVIDER` | The graph role's provider.                                                                                                                                                                               |
| `ROCKY_LLM_GRAPH_MODEL`           | server, worker, cli, evals | `claude-sonnet-5-5`  | The graph role's model.                                                                                                                                                                                  |
| `ROCKY_LLM_GRAPH_EFFORT`          | server, worker, cli, evals | `medium`             | The graph role's effort.                                                                                                                                                                                 |
| `ROCKY_LLM_GRAPH_PLATFORM_MODEL`  | server, worker, cli, evals | derived              | As for triage.                                                                                                                                                                                           |
| `ROCKY_LLM_ASK_PROVIDER`          | server, worker, cli, evals | `ROCKY_LLM_PROVIDER` | The ask role's provider.                                                                                                                                                                                 |
| `ROCKY_LLM_ASK_MODEL`             | server, worker, cli, evals | `claude-sonnet-5-5`  | The ask role's model.                                                                                                                                                                                    |
| `ROCKY_LLM_ASK_EFFORT`            | server, worker, cli, evals | `medium`             | The ask role's effort.                                                                                                                                                                                   |
| `ROCKY_LLM_ASK_PLATFORM_MODEL`    | server, worker, cli, evals | derived              | As for triage.                                                                                                                                                                                           |

### Embeddings

Off until `ROCKY_LLM_EMBED_PROVIDER` (or another `ROCKY_LLM_EMBED_*`) is set
([ADR 0040](../adr/0040-repository-index-and-embedding-spaces.md)). The repository index and Ask
need it. At most 1024 dimensions. Changing the provider, model or dimensions re-indexes every
repository (and spends the embedding tokens again).

| Variable                     | Read by                    | Default                                                     | Meaning                                                                                                                                  |
| ---------------------------- | -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ROCKY_LLM_EMBED_PROVIDER`   | server, worker, cli, evals | `openai`, or `ROCKY_LLM_PROVIDER` when it has embeddings    | `openai`, `voyage` or `openai-compatible`.                                                                                               |
| `ROCKY_LLM_EMBED_MODEL`      | server, worker, cli, evals | `text-embedding-3-small` (openai), `voyage-code-3` (voyage) | Required on `openai-compatible`.                                                                                                         |
| `ROCKY_LLM_EMBED_DIMENSIONS` | server, worker, cli, evals | `1024` (openai, voyage)                                     | The vector width, at most 1024. Required on `openai-compatible`, where it must equal what the server returns: a mismatch fails the call. |

### Provider settings

| Variable                                | Read by                    | Default                                 | Meaning                                                                                                                                                                                                                          |
| --------------------------------------- | -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROCKY_LLM_ANTHROPIC_API_KEY_ENV`       | server, worker, cli, evals | `ANTHROPIC_API_KEY`                     | Name of the variable holding the Anthropic API key.                                                                                                                                                                              |
| `ROCKY_LLM_ANTHROPIC_BASE_URL`          | server, worker, cli, evals | Anthropic's API                         | A gateway URL (https only). It must accept the key as `Authorization: Bearer`.                                                                                                                                                   |
| `ROCKY_LLM_ANTHROPIC_FALLBACKS`         | server, worker, cli, evals | `on`                                    | Server-side refusal fallbacks on the models that take them; `off` for a gateway that rejects the beta.                                                                                                                           |
| `ROCKY_LLM_BEDROCK_REGION`              | server, worker, cli, evals | `AWS_REGION`, then `AWS_DEFAULT_REGION` | Amazon Bedrock region. Credentials come from the AWS default chain or `AWS_BEARER_TOKEN_BEDROCK`, read by the AWS SDK.                                                                                                           |
| `ROCKY_LLM_VERTEX_PROJECT_ID`           | server, worker, cli, evals | required on Vertex                      | Google Cloud project. Credentials are application default credentials.                                                                                                                                                           |
| `ROCKY_LLM_VERTEX_REGION`               | server, worker, cli, evals | required on Vertex                      | Vertex AI region, for example `global`.                                                                                                                                                                                          |
| `ROCKY_LLM_FOUNDRY_RESOURCE`            | server, worker, cli, evals | required on Foundry                     | Microsoft Foundry resource name.                                                                                                                                                                                                 |
| `ROCKY_LLM_FOUNDRY_API_KEY_ENV`         | server, worker, cli, evals | `ANTHROPIC_FOUNDRY_API_KEY`             | Name of the variable holding the Foundry key.                                                                                                                                                                                    |
| `ROCKY_LLM_OPENAI_BASE_URL`             | server, worker, cli, evals | required on openai-compatible           | The OpenAI-compatible server's base URL, including `/v1` (for example `http://127.0.0.1:11434/v1` for Ollama). With a key it must be https, or http on `127.0.0.1`, `localhost` or `[::1]`. See [local models](local-models.md). |
| `ROCKY_LLM_OPENAI_API_KEY_ENV`          | server, worker, cli, evals | unset (no key)                          | Name of the variable holding the OpenAI-compatible server's key, if it needs one.                                                                                                                                                |
| `ROCKY_LLM_OPENAI_PLATFORM_API_KEY_ENV` | server, worker, cli, evals | `OPENAI_API_KEY`                        | OpenAI's hosted API (embeddings only): name of the key's variable.                                                                                                                                                               |
| `ROCKY_LLM_OPENAI_PLATFORM_BASE_URL`    | server, worker, cli, evals | OpenAI's API                            | An https gateway for OpenAI's API.                                                                                                                                                                                               |
| `ROCKY_LLM_VOYAGE_API_KEY_ENV`          | server, worker, cli, evals | `VOYAGE_API_KEY`                        | Voyage AI (embeddings only): name of the key's variable.                                                                                                                                                                         |
| `ROCKY_LLM_VOYAGE_BASE_URL`             | server, worker, cli, evals | Voyage's API                            | An https gateway for Voyage's API.                                                                                                                                                                                               |
| `AWS_REGION`                            | server, worker, cli, evals | unset                                   | Bedrock's region when `ROCKY_LLM_BEDROCK_REGION` is unset.                                                                                                                                                                       |
| `AWS_DEFAULT_REGION`                    | server, worker, cli, evals | unset                                   | Bedrock's region when neither of the above is set.                                                                                                                                                                               |

### Provider keys

These are the **default names**; the `*_API_KEY_ENV` variables above can point at any other
variable. Keep the values in a secret manager. The adapters read them per call and never log
them. A live run that needs a key that is unset stops before calling anything.

| Variable                    | Read by                    | Default | Meaning                         |
| --------------------------- | -------------------------- | ------- | ------------------------------- |
| `ANTHROPIC_API_KEY`         | server, worker, cli, evals | unset   | Anthropic API key.              |
| `ANTHROPIC_FOUNDRY_API_KEY` | server, worker, cli, evals | unset   | Microsoft Foundry key.          |
| `OPENAI_API_KEY`            | server, worker, cli, evals | unset   | OpenAI API key (embeddings).    |
| `VOYAGE_API_KEY`            | server, worker, cli, evals | unset   | Voyage AI API key (embeddings). |

### Refused variables

Rocky refuses to run while these are set, because they would undo the adapters' hardening
([ADR 0013](../adr/0013-llm-provider-adapters.md)). Other SDK variables (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_LOG` and the platform ones) are overridden, not read: Rocky
sets every option explicitly.

| Variable                   | Read by                    | Default | Meaning                                                                             |
| -------------------------- | -------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `ANTHROPIC_CUSTOM_HEADERS` | server, worker, cli, evals | unset   | Must be unset on the Claude providers: it could replace the authentication headers. |
| `GOOGLE_SDK_NODE_LOGGING`  | server, worker, cli, evals | unset   | Must be unset on Vertex: it logs access tokens.                                     |

## Development only

| Variable               | Read by | Default                 | Meaning                                                                                                                                                   |
| ---------------------- | ------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROCKY_DEV_SERVER_URL` | web dev | `http://127.0.0.1:4310` | Where the Vite dev server proxies `/api` and `/auth`; `off` for no proxy. Not used in production, where the server serves the build.                      |
| `VITE_ROCKY_FIXTURES`  | web dev | unset                   | Build time: `on` keeps the fixture switches (`?fixture=`) in a build, for the Playwright performance build only. **Never set it for a deployment build.** |
