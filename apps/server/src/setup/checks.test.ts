import { ForgeReadError, type ForgeInstallation, type OrgId } from "@rocky-reviews/core";
import type { OrgSetupProgress } from "@rocky-reviews/db";
import { githubEndpoints, type GitHubInstallationReader } from "@rocky-reviews/forge-github";
import { recordingAdapters } from "@rocky-reviews/llm/testing";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { createSetupChecks, type SetupCheckOptions } from "./checks.js";

/**
 * P10-2 (ADR 0044): each wizard step's check, with fakes for the pool, GitHub and the database.
 * The database queries themselves run against Postgres in `packages/db` (`setup.db.test.ts`).
 */

const endpoints = githubEndpoints({});

/** A pool whose client answers the two catalogue queries of `checkDatabaseSetup`. */
const pool = (
  answers:
    { extensions?: string[]; columns?: { table_name: string; column_name: string }[] } | Error,
): SetupCheckOptions["pool"] => ({
  connect: async () => {
    if (answers instanceof Error) throw answers;
    let call = 0;
    return {
      query: async () => {
        call += 1;
        if (call === 1)
          return { rows: (answers.extensions ?? ["vector"]).map((extname) => ({ extname })) };
        if (answers.columns === undefined) throw new Error("connection lost");
        return { rows: answers.columns };
      },
      release: () => undefined,
    } as unknown as pg.PoolClient;
  },
});

const base = (overrides: Partial<SetupCheckOptions> = {}): SetupCheckOptions => ({
  pool: pool({ columns: [] }),
  env: {},
  adapters: recordingAdapters({ ok: true }).factories,
  endpoints,
  credentialsFile: "/setup/github-app.env",
  appConfigured: false,
  credentialsWritten: false,
  manifest: { webhookUrl: new URL("https://rocky.example.com/webhooks/github") },
  ...overrides,
});

const app = (overrides: Partial<GitHubInstallationReader> = {}): GitHubInstallationReader => ({
  kind: "github",
  getInstallation: async () => null,
  verifyApp: async () => undefined,
  appSlug: async () => "rocky-reviews",
  listInstallations: async () => [],
  ...overrides,
});

const installation = (id: number, login: string): ForgeInstallation => ({
  id,
  account: { id: id + 1000, login, kind: "organization" },
  suspended: false,
});

const progress: OrgSetupProgress = {
  repositories: 2,
  pullRequests: 1,
  analyses: { queued: 0, running: 0, awaitingApproval: 0, done: 1, failed: 0 },
  latestDone: { fullName: "acme/api", number: 7 },
};

describe("database check (P10-2)", () => {
  it("names pending migrations, then reports ok once nothing is missing", async () => {
    const pending = await createSetupChecks(base({ pool: pool({ columns: [] }) })).database();
    expect(pending.state).toBe("migrations_pending");
    expect(pending.details.length).toBeGreaterThan(0);
    expect(pending.details.length).toBeLessThanOrEqual(20);
  });

  it("reports a missing extension before missing tables", async () => {
    const check = await createSetupChecks(
      base({ pool: pool({ extensions: [], columns: [] }) }),
    ).database();
    expect(check).toEqual({ state: "extension_missing", details: ["vector"] });
  });

  it("reports the pool's login refusal by code, and anything else as unreachable", async () => {
    const refused = Object.assign(new Error("DATABASE_URL must log in as …"), {
      refusals: ["login:owner", "login:privileged"],
    });
    expect(await createSetupChecks(base({ pool: pool(refused) })).database()).toEqual({
      state: "login_refused",
      details: ["login:owner", "login:privileged"],
    });
    const down = new Error("connect ECONNREFUSED postgres://rocky:secret@db");
    const answer = await createSetupChecks(base({ pool: pool(down) })).database();
    expect(answer).toEqual({ state: "unreachable", details: [] });
    expect(JSON.stringify(answer)).not.toContain("secret");
    expect(await createSetupChecks(base({ pool: pool({}) })).database()).toEqual({
      state: "unreachable",
      details: [],
    });
  });
});

describe("GitHub App check (P10-2)", () => {
  it("offers the manifest flow before an app exists, or says what blocks it", async () => {
    expect(await createSetupChecks(base()).githubApp()).toEqual({
      state: "not_created",
      error: null,
      createPath: "/setup/github-app",
      createBlocked: null,
      credentialsFile: "/setup/github-app.env",
      installUrl: null,
    });
    const blocked = await createSetupChecks(
      base({ manifest: { webhookUrl: undefined } }),
    ).githubApp();
    expect(blocked).toMatchObject({ createPath: null, createBlocked: "webhook_url_missing" });
  });

  it("asks for the restart once the credentials file was written", async () => {
    const check = await createSetupChecks(
      base({ credentialsWritten: true, manifest: undefined }),
    ).githubApp();
    expect(check).toMatchObject({ state: "created", createPath: null });
  });

  it("checks a configured app with GitHub and builds its install link", async () => {
    const check = await createSetupChecks(base({ appConfigured: true, app: app() })).githubApp();
    expect(check).toMatchObject({
      state: "configured",
      installUrl: "https://github.com/apps/rocky-reviews/installations/new",
    });
    const noSlug = await createSetupChecks(
      base({ appConfigured: true, app: app({ appSlug: async () => null }) }),
    ).githubApp();
    expect(noSlug).toMatchObject({ state: "configured", installUrl: null });
  });

  it("reports a failed check by code, and a missing key", async () => {
    const mismatch = await createSetupChecks(
      base({
        appConfigured: true,
        app: app({
          appSlug: () => Promise.reject(new ForgeReadError("app_mismatch")),
        }),
      }),
    ).githubApp();
    expect(mismatch).toMatchObject({ state: "check_failed", error: "app_mismatch" });
    const other = await createSetupChecks(
      base({ appConfigured: true, app: app({ appSlug: () => Promise.reject(new Error("x")) }) }),
    ).githubApp();
    expect(other).toMatchObject({ state: "check_failed", error: "internal_error" });
    const noKey = await createSetupChecks(base({ appConfigured: true })).githubApp();
    expect(noKey).toMatchObject({ state: "check_failed", error: "private_key_missing" });
  });
});

describe("LLM check (P10-2)", () => {
  it("lists what the test call would reach, from the worker's variables", () => {
    const check = createSetupChecks(
      base({ env: { ROCKY_LLM_REVIEW_MODEL: "claude-opus-5-5" } }),
    ).llm();
    expect(check.state).toBe("not_tested");
    expect(check.targets.flatMap((t) => t.roles).sort()).toEqual([
      "ask",
      "graph",
      "review",
      "triage",
    ]);
    expect(check.targets.every((t) => t.provider === "anthropic")).toBe(true);
  });

  it("reports an invalid configuration by variable, never by key value", () => {
    const check = createSetupChecks(
      base({ env: { ROCKY_LLM_PROVIDER: "nope", ANTHROPIC_API_KEY: "sk-ant-secret" } }),
    ).llm();
    expect(check.state).toBe("invalid_config");
    expect(check.configError).toMatch(/ROCKY_LLM_PROVIDER|provider/);
    expect(check.configError).not.toContain("sk-ant-secret");
    expect(check.targets).toEqual([]);
  });

  it("runs the test call through the configured adapters", async () => {
    const adapters = recordingAdapters({ ok: true });
    const results = await createSetupChecks(base({ adapters: adapters.factories })).probe();
    expect(results.every((r) => r.outcome === "ok")).toBe(true);
    expect(adapters.calls.length).toBe(results.length);
  });
});

describe("first repository check (P10-2)", () => {
  const db = (orgs: { orgId: OrgId; installationId: number }[]) => ({
    sessions: { loginOrgs: async () => orgs } as never,
    withOrg: (async (_orgId: OrgId, fn: (tx: never) => Promise<unknown>) =>
      fn({} as never)) as never,
  });

  it("waits for the app, then for an installation", async () => {
    expect(await createSetupChecks(base()).repositories()).toEqual({
      state: "waiting_for_app",
      error: null,
      installations: [],
    });
    expect(
      await createSetupChecks(base({ appConfigured: true, app: app(), db: db([]) })).repositories(),
    ).toEqual({ state: "not_installed", error: null, installations: [] });
    expect(await createSetupChecks(base({ appConfigured: true })).repositories()).toMatchObject({
      state: "check_failed",
      error: "private_key_missing",
    });
  });

  it("shows an installation Rocky has not received yet as not ready", async () => {
    const check = await createSetupChecks(
      base({
        appConfigured: true,
        app: app({ listInstallations: async () => [installation(5, "acme")] }),
        db: db([]),
      }),
    ).repositories();
    expect(check.state).toBe("installed");
    expect(check.installations).toEqual([
      {
        account: "acme",
        kind: "organization",
        suspended: false,
        ready: false,
        repositories: 0,
        pullRequests: 0,
        analyses: { queued: 0, running: 0, awaitingApproval: 0, done: 0, failed: 0 },
        latestDone: null,
      },
    ]);
  });

  it("reports the first analysed pull request", async () => {
    const orgId = "00000000-0000-4000-8000-000000000001" as OrgId;
    const withProgress = {
      ...db([{ orgId, installationId: 5 }]),
      withOrg: (async () => progress) as never,
    };
    const check = await createSetupChecks(
      base({
        appConfigured: true,
        app: app({
          listInstallations: async () => [installation(5, "acme"), installation(6, "beta")],
        }),
        db: withProgress,
      }),
    ).repositories();
    expect(check.state).toBe("analysed");
    expect(check.installations[0]).toMatchObject({
      account: "acme",
      ready: true,
      latestDone: { fullName: "acme/api", number: 7 },
    });
    expect(check.installations[1]).toMatchObject({ account: "beta", ready: false });
  });

  it("fails closed on GitHub and database errors, by code", async () => {
    const github = await createSetupChecks(
      base({
        appConfigured: true,
        app: app({
          listInstallations: () => Promise.reject(new ForgeReadError("http_status", 401)),
        }),
        db: db([]),
      }),
    ).repositories();
    expect(github).toEqual({ state: "check_failed", error: "http_status", installations: [] });
    const broken = await createSetupChecks(
      base({
        appConfigured: true,
        app: app({ listInstallations: async () => [installation(5, "acme")] }),
        db: {
          ...db([]),
          sessions: { loginOrgs: () => Promise.reject(new Error("db down")) } as never,
        },
      }),
    ).repositories();
    expect(broken).toEqual({ state: "check_failed", error: "database", installations: [] });
  });
});
