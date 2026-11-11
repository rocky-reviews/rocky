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
  csrfToken: CSRF,
  database: { state: "ok", details: [] },
  githubApp: {
    state: "not_created",
    error: null,
    createPath: "/setup/github-app",
    createBlocked: null,
    credentialsFile: "/setup/github-app.env",
    installUrl: null,
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

export const SETUP_FIXTURES = {
  fresh: SETUP_FRESH,
  created: SETUP_CREATED,
  installed: SETUP_INSTALLED,
  done: SETUP_DONE,
  failures: SETUP_FAILURES,
  "invalid-llm": SETUP_INVALID_LLM,
} as const;
