import { APP_ROLE, checkServerLogin, createDb, SERVER_FORBIDDEN_ROLES } from "@rocky-reviews/db";
import type { RepositoryAccessCheck } from "@rocky-reviews/core";
import { CryptoError, localKeyWrapperFromEnv } from "@rocky-reviews/crypto";
import {
  createGitHubForge,
  createGitHubLogin,
  createGitHubReviewPoster,
  createGitHubUserAccessReader,
  createGitHubWebhookIngress,
} from "@rocky-reviews/forge-github";
import type { Logger } from "@rocky-reviews/log";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import pg from "pg";
import { buildApp, type ReviewPostingDeps } from "./app.js";
import type { AuthDeps } from "./auth/routes.js";
import {
  authFromEnv,
  ConfigError,
  githubAppAuthFromEnv,
  githubAppSetupFromEnv,
  githubAppIdFromEnv,
  isProduction,
  webhookSecretFromEnv,
} from "./config.js";
import { SETUP_PATH, type GitHubAppSetupDeps } from "./github-app-setup.js";
import { createRepositoryAccess } from "./repository-access.js";
import { describeTrustProxy, trustProxyFromEnv } from "./security/client-ip.js";
import { createRateLimits, rateLimitRulesFromEnv } from "./security/rate-limit.js";
import { authRateLimit, webhookRateLimit } from "./security/route-limits.js";
import { loadWebApp, type WebApp } from "./web-app.js";
import type { WebhookDeps } from "./webhooks.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The pool bounds only how long a request waits for a connection (2 s). Statement bounds are
 * set per query where they belong (the inbox insert has 3 s, `packages/db`), so future
 * `withOrg` routes do not inherit a hidden cap. The route's 6 s guard (INBOX_RECORD_TIMEOUT_MS)
 * is the backstop; all stay under GitHub's 10 s delivery timeout.
 */
export const POOL_TIMEOUTS = { connectionTimeoutMillis: 2_000 } as const;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

/**
 * DATABASE_URL does not log in as a plain member of `rocky_app` (ADR 0009, L28): the owner or
 * migrator, a superuser or BYPASSRLS login, the worker's login, or a login that can reach
 * `rocky_worker`, `rocky_lifecycle` or `rocky_retention` by any grant option. The
 * internet-facing server must never hold those privileges: creating orgs, claiming inbox rows,
 * erasing orgs, disabling triggers. The message names roles, checks and variables only, never
 * the connection string or the login.
 */
export class ServerLoginError extends ConfigError {
  readonly refusals: readonly string[];
  constructor(refusals: readonly string[]) {
    super(
      `DATABASE_URL must log in as a plain member of ${APP_ROLE} (refused: ${refusals.join(", ")}): not the database owner or migrator (DATABASE_ADMIN_URL), a superuser, a BYPASSRLS login, the worker's login (WORKER_DATABASE_URL), or a member of ${SERVER_FORBIDDEN_ROLES.join(", ")}`,
    );
    this.refusals = refusals;
  }
}

/** Connections live at most this long, bounding a grant made after the check (S4). */
export const POOL_MAX_LIFETIME_SECONDS = 300;

/**
 * The server's single Postgres pool. Each new connection is checked before first use
 * (`onConnect`, `checkServerLogin`): anything but a plain `rocky_app` login is closed and the
 * query fails, and so is any error or unexpected answer from the check (fail closed). This
 * covers new connections only: a role granted to the login takes effect at once on connections
 * already open, which keep it until they are recycled (`maxLifetimeSeconds`, 5 minutes; a
 * checked-out connection ends when released). A database unreachable at boot is checked on the
 * first connection that succeeds. An idle client losing its connection (Postgres restart,
 * pg_terminate_backend) emits `error` on the pool; without a listener that crashes the process.
 * Only codes are logged: driver messages can carry connection details or values.
 */
export const createServerPool = (connectionString: string | undefined, log: Logger): pg.Pool => {
  const options: pg.PoolConfig & { onConnect: (client: pg.ClientBase) => Promise<void> } = {
    ...(connectionString === undefined ? {} : { connectionString }),
    max: 10,
    ...POOL_TIMEOUTS,
    maxLifetimeSeconds: POOL_MAX_LIFETIME_SECONDS,
    // pg-pool awaits the hook and discards the connection when it rejects (@types/pg types it
    // as returning void).
    onConnect: async (client) => {
      let refusals: readonly string[];
      let code: string | undefined;
      try {
        refusals = await checkServerLogin(client);
      } catch (error) {
        refusals = ["check_failed"];
        code = errorCode(error) ?? "unknown";
      }
      if (refusals.length === 0) return;
      log.error(
        { refusals, ...(code === undefined ? {} : { errorCode: code }) },
        "database login refused",
      );
      throw new ServerLoginError(refusals);
    },
  };
  const pool = new pg.Pool(options);
  pool.on("error", (error) =>
    log.error({ errorCode: errorCode(error) }, "postgres idle client error"),
  );
  return pool;
};

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly webhooks: boolean;
  /** Whether GitHub login and the session API are registered (P7-1). */
  readonly auth: boolean;
  /** Whether the GitHub App manifest setup routes are registered (P3-1). */
  readonly githubAppSetup: boolean;
  /**
   * Whether the repository access check (P3-6) is built (H4-1): login plus the app's key.
   * Without it every route that reads a repository's data answers 503.
   */
  readonly repositoryAccess: boolean;
  close(): Promise<void>;
}

export interface StartOptions {
  /**
   * Shows the one-time setup URL to the operator. Defaults to writing to the terminal (stderr),
   * deliberately not through the logger: log pipelines ship and retain lines, and the token is a
   * credential (ADR 0008).
   */
  announce?: (text: string) => void;
}

const announceToTerminal = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

/**
 * Validates configuration (throws `ConfigError` before opening anything), builds the app on one
 * pool and listens. `main.ts` turns a ConfigError into exit code 1.
 */
export const startServer = async (
  env: Env,
  log: Logger,
  options: StartOptions = {},
): Promise<RunningServer> => {
  const webhookSecret = webhookSecretFromEnv(env);
  const setup = githubAppSetupFromEnv(env, homedir());
  const authSetup = authFromEnv(env);
  // P7-3 (ADR 0025): limits and the trusted proxy are checked before anything opens.
  const trustProxy = trustProxyFromEnv(env);
  const rateLimits = createRateLimits({ rules: rateLimitRulesFromEnv(env), trustProxy });
  const appId = githubAppIdFromEnv(env);
  const appAuth = githubAppAuthFromEnv(env);
  const webDir = env["ROCKY_WEB_DIR"];
  const web: WebApp | undefined =
    webDir === undefined || webDir === "" ? undefined : loadWebApp(webDir);
  let keys;
  if (authSetup.enabled) {
    try {
      keys = localKeyWrapperFromEnv(env);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      throw new ConfigError(
        "GitHub login stores user tokens encrypted: set ROCKY_KEK_KEYS (and ROCKY_KEK_CURRENT) (ADR 0006)",
      );
    }
  }
  let githubAppSetup: GitHubAppSetupDeps | undefined;
  if (setup.enabled) {
    githubAppSetup = { ...setup.config, token: randomBytes(32).toString("base64url") };
  } else if (setup.reason === "configured" && env["GITHUB_APP_SETUP"] === "true") {
    log.warn("GITHUB_APP_SETUP ignored: a GitHub App is already configured");
  }
  // The mode only: which header (if any) names the client. Never an address.
  log.info({ trustProxy: describeTrustProxy(trustProxy) }, "rate limits count per client address");
  const pool = createServerPool(env["DATABASE_URL"], log);
  // Review rounds 4 and 5: refuse to start on anything but a plain rocky_app login. Booting does
  // not need the database (health reports it); when it is unreachable now, the pool's hook checks
  // each new connection later.
  try {
    await pool.query("select 1");
  } catch (error) {
    if (error instanceof ServerLoginError) {
      await pool.end();
      throw error;
    }
    log.warn({ errorCode: errorCode(error) ?? "unknown" }, "database unreachable at boot");
  }

  let webhooks: WebhookDeps | undefined;
  if (webhookSecret === undefined) {
    log.warn("GITHUB_WEBHOOK_SECRET is not set: webhook receiver disabled (development only)");
  } else {
    const db = createDb({ pool });
    webhooks = {
      ingress: createGitHubWebhookIngress({
        secret: webhookSecret,
        ...(appId === undefined ? {} : { appId }),
      }),
      inbox: { record: (delivery) => db.recordWebhookDelivery(delivery) },
      rateLimit: webhookRateLimit(rateLimits),
    };
  }

  let auth: AuthDeps | undefined;
  let reviewPosting: ReviewPostingDeps | undefined;
  let repositoryAccess: RepositoryAccessCheck | undefined;
  if (authSetup.enabled && keys !== undefined) {
    const { config } = authSetup;
    const db = createDb({ pool });
    if (config.sessionSecret === undefined) {
      log.warn("ROCKY_SESSION_SECRET is not set: generated for this process (development only)");
    }
    if (!config.cookieSecure) {
      log.warn(
        "ROCKY_PUBLIC_URL is http on loopback: session cookies are not Secure (development only)",
      );
    }
    const secret =
      config.sessionSecret === undefined
        ? randomBytes(32)
        : Buffer.from(config.sessionSecret, "utf8");
    // The repository access check (P3-6, ADR 0011; wired by H4-1, ADR 0033): asks GitHub as
    // the member with their stored token, and for membership on an installation token minted
    // with the app's key. Without the key there is no check, and the routes that need one
    // answer 503 (fail closed): nothing here ever stands in for it.
    if (appAuth === undefined) {
      log.warn(
        "GITHUB_APP_PRIVATE_KEY is not set: repository access check disabled; routes that read a repository's data answer 503 (development only)",
      );
    } else {
      const clock = { now: () => new Date() };
      repositoryAccess = createRepositoryAccess({
        db,
        keys,
        reader: createGitHubUserAccessReader({
          api: config.endpoints.api,
          collaborators: createGitHubForge({ auth: appAuth, api: config.endpoints.api, clock }),
        }),
        log,
      });
    }
    // A const, so the closure below keeps the narrowing.
    const access = repositoryAccess;
    auth = {
      publicUrl: config.publicUrl,
      cookieSecure: config.cookieSecure,
      secret,
      login: createGitHubLogin({
        endpoints: config.endpoints,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        ...(config.appId === undefined ? {} : { appId: config.appId }),
      }),
      db,
      keys,
      requireTokenExpiry: config.production,
      rateLimit: authRateLimit(rateLimits, { secret, cookieSecure: config.cookieSecure }),
      // After each commit that stores or clears a token, changes a role, removes or restores a
      // member (ADR 0011 §6): the member's cached answers are dropped.
      ...(access === undefined
        ? {}
        : {
            onMemberTokenChanged: (orgId, memberId) => {
              access.invalidateMember(orgId, memberId);
            },
          }),
    };
    // Posting as the user (P3-5): the one poster in the process, held by the review routes only.
    // They answer 503 without the repository access check above.
    reviewPosting = { poster: createGitHubReviewPoster({ api: config.endpoints.api }), keys };
  } else {
    log.warn("GITHUB_APP_CLIENT_ID is not set: GitHub login disabled (development only)");
  }

  const app = buildApp({
    checkDatabase: async () => (await pool.query("select 1 as ok")).rowCount === 1,
    log,
    hsts: isProduction(env),
    rateLimits,
    ...(web === undefined ? {} : { web }),
    ...(webhooks === undefined ? {} : { webhooks }),
    ...(githubAppSetup === undefined ? {} : { githubAppSetup }),
    ...(auth === undefined ? {} : { auth }),
    ...(reviewPosting === undefined ? {} : { reviewPosting }),
    ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
  });

  // 0.0.0.0 in containers (Fly.io); .env.example binds 127.0.0.1 for local development.
  const host = env["HOST"] ?? "0.0.0.0";
  const port = Number(env["PORT"] ?? 4310);
  try {
    await app.listen({ port, host });
  } catch (error) {
    await pool.end();
    throw error;
  }
  log.info(
    {
      host,
      port,
      webhooks: webhooks !== undefined,
      auth: auth !== undefined,
      githubAppSetup: githubAppSetup !== undefined,
      repositoryAccess: repositoryAccess !== undefined,
      web: web !== undefined,
    },
    "server listening",
  );
  if (githubAppSetup !== undefined) {
    const url = new URL(SETUP_PATH, githubAppSetup.publicUrl);
    url.searchParams.set("token", githubAppSetup.token);
    (options.announce ?? announceToTerminal)(
      `\nGitHub App setup is open. Open this one-time URL in your browser (do not share it):\n  ${url.href}\n`,
    );
  }

  // Idempotent: a second signal (or caller) awaits the same shutdown instead of ending the pool
  // twice, which pg refuses.
  let closing: Promise<void> | undefined;
  return {
    app,
    pool,
    webhooks: webhooks !== undefined,
    auth: auth !== undefined,
    githubAppSetup: githubAppSetup !== undefined,
    repositoryAccess: repositoryAccess !== undefined,
    close: () => {
      closing ??= (async () => {
        try {
          await app.close();
        } finally {
          await pool.end();
        }
      })();
      return closing;
    },
  };
};
