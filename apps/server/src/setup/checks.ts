import { ForgeReadError, type SetupStatusResponse } from "@rocky-reviews/core";
import { checkDatabaseSetup, loadOrgSetupProgress, type Db } from "@rocky-reviews/db";
import type { GitHubEndpoints, GitHubInstallationReader } from "@rocky-reviews/forge-github";
import {
  envSecrets,
  LlmConfigError,
  llmConfigFromEnv,
  probeLlmConfig,
  probeTargets,
  type ProbeResult,
  type ProviderAdapters,
} from "@rocky-reviews/llm";
import type pg from "pg";

/**
 * The setup wizard's checks (P10-2, ADR 0044), one per step. Each answers with fixed codes,
 * counts and names (provider, model, GitHub logins and repository names); none of them returns
 * or logs a key, a token, a connection string or a driver message.
 */

type Status = SetupStatusResponse;

export interface SetupChecks {
  database(): Promise<Status["database"]>;
  githubApp(): Promise<Status["githubApp"]>;
  /** The LLM configuration as the worker will read it; `state` before any test call. */
  llm(): Omit<Status["llm"], "results">;
  /** The test call (`probeLlmConfig`). Throws `LlmConfigError` when roles cannot be built. */
  probe(): Promise<ProbeResult[]>;
  repositories(): Promise<Status["repositories"]>;
}

export interface SetupCheckOptions {
  /** The server's pool: every connection is checked as a plain `rocky_app` login first. */
  readonly pool: Pick<pg.Pool, "connect">;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly adapters: ProviderAdapters;
  readonly endpoints: GitHubEndpoints;
  readonly credentialsFile: string;
  readonly appConfigured: boolean;
  readonly credentialsWritten: boolean;
  /** The manifest flow is registered (no app yet). */
  readonly manifest: { readonly webhookUrl: URL | undefined } | undefined;
  /** The app's reader (its key), once configured; absent in development without a key. */
  readonly app?: GitHubInstallationReader;
  /** The application database, once the app is configured (installations → orgs → progress). */
  readonly db?: Pick<Db, "withOrg" | "sessions">;
}

const MAX_DETAILS = 20;
const MAX_CONFIG_ERROR = 2000;

const refusalsOf = (error: unknown): string[] | undefined => {
  const refusals = (error as { refusals?: unknown } | null)?.refusals;
  return Array.isArray(refusals) && refusals.every((r) => typeof r === "string")
    ? refusals
    : undefined;
};

const forgeCode = (error: unknown): string =>
  error instanceof ForgeReadError ? error.reason : "internal_error";

export const createSetupChecks = (options: SetupCheckOptions): SetupChecks => {
  const database: SetupChecks["database"] = async () => {
    let client: pg.PoolClient;
    try {
      client = await options.pool.connect();
    } catch (error) {
      // The pool's login check (`checkServerLogin`) refuses owner, worker and superuser logins.
      const refusals = refusalsOf(error);
      return refusals === undefined
        ? { state: "unreachable", details: [] }
        : { state: "login_refused", details: refusals.slice(0, MAX_DETAILS) };
    }
    try {
      const check = await checkDatabaseSetup(client);
      if (check.missingExtensions.length > 0) {
        return {
          state: "extension_missing",
          details: check.missingExtensions.slice(0, MAX_DETAILS),
        };
      }
      if (check.missingSchema.length > 0) {
        return { state: "migrations_pending", details: check.missingSchema.slice(0, MAX_DETAILS) };
      }
      return { state: "ok", details: [] };
    } catch {
      return { state: "unreachable", details: [] };
    } finally {
      client.release();
    }
  };

  const createFields = () => ({
    createPath:
      options.manifest === undefined || options.manifest.webhookUrl === undefined
        ? null
        : ("/setup/github-app" as const),
    createBlocked:
      options.manifest !== undefined && options.manifest.webhookUrl === undefined
        ? "webhook_url_missing"
        : null,
    credentialsFile: options.credentialsFile,
  });

  const githubApp: SetupChecks["githubApp"] = async () => {
    if (!options.appConfigured) {
      return {
        state: options.credentialsWritten ? "created" : "not_created",
        error: null,
        ...createFields(),
        installUrl: null,
      };
    }
    const base = {
      createPath: null,
      createBlocked: null,
      credentialsFile: options.credentialsFile,
    };
    if (options.app === undefined) {
      return { state: "check_failed", error: "private_key_missing", ...base, installUrl: null };
    }
    try {
      const slug = await options.app.appSlug();
      return {
        state: "configured",
        error: null,
        ...base,
        installUrl:
          slug === null
            ? null
            : new URL(`apps/${slug}/installations/new`, options.endpoints.web).href,
      };
    } catch (error) {
      return { state: "check_failed", error: forgeCode(error), ...base, installUrl: null };
    }
  };

  const llm: SetupChecks["llm"] = () => {
    try {
      const config = llmConfigFromEnv(options.env);
      return {
        state: "not_tested",
        configError: null,
        targets: probeTargets(config).map((t) => ({
          roles: [...t.roles],
          provider: t.provider,
          model: t.model,
        })),
      };
    } catch (error) {
      const message =
        error instanceof LlmConfigError ? error.message : "ROCKY_LLM_* could not be read";
      return {
        state: "invalid_config",
        configError: message.slice(0, MAX_CONFIG_ERROR),
        targets: [],
      };
    }
  };

  const probe: SetupChecks["probe"] = () =>
    probeLlmConfig(llmConfigFromEnv(options.env), options.adapters, envSecrets(options.env));

  const repositories: SetupChecks["repositories"] = async () => {
    if (!options.appConfigured) {
      return { state: "waiting_for_app", error: null, installations: [] };
    }
    if (options.app === undefined || options.db === undefined) {
      return { state: "check_failed", error: "private_key_missing", installations: [] };
    }
    const db = options.db;
    let installations;
    try {
      installations = await options.app.listInstallations();
    } catch (error) {
      return { state: "check_failed", error: forgeCode(error), installations: [] };
    }
    if (installations.length === 0) {
      return { state: "not_installed", error: null, installations: [] };
    }
    try {
      const orgs = await db.sessions.loginOrgs(
        "github",
        installations.map((i) => ({ installationId: i.id, accountId: i.account.id })),
      );
      const rows = [];
      for (const installation of installations) {
        const org = orgs.find((o) => o.installationId === installation.id);
        const progress =
          org === undefined ? undefined : await db.withOrg(org.orgId, loadOrgSetupProgress);
        rows.push({
          account: installation.account.login,
          kind: installation.account.kind,
          suspended: installation.suspended,
          ready: progress !== undefined,
          repositories: progress?.repositories ?? 0,
          pullRequests: progress?.pullRequests ?? 0,
          analyses: progress?.analyses ?? {
            queued: 0,
            running: 0,
            awaitingApproval: 0,
            done: 0,
            failed: 0,
          },
          latestDone: progress?.latestDone ?? null,
        });
      }
      return {
        state: rows.some((r) => r.latestDone !== null) ? "analysed" : "installed",
        error: null,
        installations: rows,
      };
    } catch {
      return { state: "check_failed", error: "database", installations: [] };
    }
  };

  return { database, githubApp, llm, probe, repositories };
};
