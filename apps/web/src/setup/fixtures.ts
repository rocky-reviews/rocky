import type { SetupStatusResponse } from "@rocky-reviews/core";

/**
 * The setup wizard's states (P10-2), for the unit tests and the Playwright suites, which answer
 * `/api/setup/status` with them. One per moment of a fresh install, plus the failures.
 */

type Status = SetupStatusResponse;

const CSRF = "c".repeat(43);
type Target = Status["llm"]["targets"][number];
const SMALL: Target = {
  roles: ["triage", "ask"],
  provider: "anthropic",
  model: "claude-haiku-5-5",
};
const LARGE: Target = {
  roles: ["review", "graph"],
  provider: "anthropic",
  model: "claude-sonnet-5-5",
};
const TARGETS = [SMALL, LARGE];

/** A fresh server in setup mode: database ready, nothing else yet. */
export const SETUP_FRESH: Status = {
  mode: "setup",
  connection: "app",
  csrfToken: CSRF,
  database: { state: "ok", details: [] },
  githubApp: {
    state: "not_created",
    error: null,
    createPath: "/setup/github-app",
    createBlocked: null,
    credentialsFile: "/setup/github-app.env",
    installUrl: null,
    token: null,
  },
  llm: { state: "not_tested", configError: null, targets: TARGETS, results: null },
  repositories: { state: "waiting_for_app", error: null, installations: [] },
};

/** The app was created; Rocky waits for its restart with the credentials. */
export const SETUP_CREATED: Status = {
  ...SETUP_FRESH,
  githubApp: { ...SETUP_FRESH.githubApp, state: "created", createPath: null },
  llm: {
    ...SETUP_FRESH.llm,
    state: "ok",
    results: [
      { ...SMALL, outcome: "ok", durationMs: 840 },
      { ...LARGE, outcome: "answered", durationMs: 2310 },
    ],
  },
};

const INSTALL_URL = "https://github.com/apps/rocky-reviews/installations/new";
const INSTALLATION: Status["repositories"]["installations"][number] = {
  account: "acme",
  kind: "organization",
  suspended: false,
  ready: true,
  repositories: 1,
  pullRequests: 1,
  analyses: { queued: 0, running: 1, awaitingApproval: 0, done: 0, failed: 0 },
  latestDone: null,
};

/** Restarted with the app: installed on one account, the first pull request being analysed. */
export const SETUP_INSTALLED: Status = {
  ...SETUP_CREATED,
  mode: "full",
  githubApp: {
    state: "configured",
    error: null,
    createPath: null,
    createBlocked: null,
    credentialsFile: "/setup/github-app.env",
    installUrl: INSTALL_URL,
    token: null,
  },
  repositories: {
    state: "installed",
    error: null,
    installations: [INSTALLATION],
  },
};

/** Every step done: the first pull request is analysed. */
export const SETUP_DONE: Status = {
  ...SETUP_INSTALLED,
  repositories: {
    state: "analysed",
    error: null,
    installations: [
      {
        ...INSTALLATION,
        analyses: { queued: 0, running: 0, awaitingApproval: 0, done: 1, failed: 0 },
        latestDone: { fullName: "acme/rocky-app", number: 12 },
      },
    ],
  },
};

/** What goes wrong most often on a first install. */
export const SETUP_FAILURES: Status = {
  ...SETUP_FRESH,
  database: { state: "migrations_pending", details: ["orgs", "analyses", "repos.memory_enabled"] },
  githubApp: { ...SETUP_FRESH.githubApp, createPath: null, createBlocked: "webhook_url_missing" },
  llm: {
    ...SETUP_FRESH.llm,
    state: "failed",
    results: [
      { ...SMALL, outcome: "auth", durationMs: 310 },
      { ...LARGE, outcome: "model_not_found", durationMs: 290 },
    ],
  },
};

/** An LLM configuration the worker would refuse. */
export const SETUP_INVALID_LLM: Status = {
  ...SETUP_FRESH,
  llm: {
    state: "invalid_config",
    configError:
      "invalid LLM config: ROCKY_LLM_PROVIDER: unknown provider; set one of anthropic, bedrock, vertex, foundry, openai-compatible",
    targets: [],
    results: null,
  },
};

/** Restarted with the app, not installed anywhere yet. */
export const SETUP_NOT_INSTALLED: Status = {
  ...SETUP_INSTALLED,
  repositories: { state: "not_installed", error: null, installations: [] },
};

/** Several accounts: one ready, one whose installation event has not arrived, one suspended. */
export const SETUP_ACCOUNTS: Status = {
  ...SETUP_INSTALLED,
  repositories: {
    state: "installed",
    error: null,
    installations: [
      INSTALLATION,
      { ...INSTALLATION, account: "octo-labs", ready: false, repositories: 0, pullRequests: 0 },
      { ...INSTALLATION, account: "old-team", kind: "user", suspended: true },
    ],
  },
};

/** Token mode (P10-4), before a token is saved: the GitHub step asks for one. */
export const SETUP_TOKEN_REQUIRED: Status = {
  ...SETUP_CREATED,
  mode: "full",
  connection: "token",
  githubApp: {
    state: "token_required",
    error: null,
    createPath: null,
    createBlocked: null,
    credentialsFile: "",
    installUrl: null,
    token: null,
  },
  repositories: { state: "waiting_for_token", error: null, installations: [] },
};

/** Token mode, a classic token saved (with its warnings), one repository being analysed. */
export const SETUP_TOKEN_CONNECTED: Status = {
  ...SETUP_TOKEN_REQUIRED,
  githubApp: {
    ...SETUP_TOKEN_REQUIRED.githubApp,
    state: "token_connected",
    token: {
      login: "sam-r",
      forgeUserId: 5_120_331,
      kind: "classic",
      expiresAt: null,
      savedAt: "2026-10-25T12:02:00.000Z",
      warnings: ["classic_token", "no_expiry"],
    },
  },
  repositories: {
    state: "installed",
    error: null,
    installations: [{ ...INSTALLATION, account: "sam-r", kind: "user" }],
  },
};

export const SETUP_FIXTURES = {
  fresh: SETUP_FRESH,
  created: SETUP_CREATED,
  "not-installed": SETUP_NOT_INSTALLED,
  installed: SETUP_INSTALLED,
  accounts: SETUP_ACCOUNTS,
  done: SETUP_DONE,
  failures: SETUP_FAILURES,
  "invalid-llm": SETUP_INVALID_LLM,
  "token-required": SETUP_TOKEN_REQUIRED,
  "token-connected": SETUP_TOKEN_CONNECTED,
} as const;
