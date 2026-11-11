import type {
  AvailableRepositoriesResponse,
  ConnectionResponse,
  ConnectionToken,
  InboxSync,
  SyncResponse,
} from "@rocky-reviews/core";

/**
 * The token connection's states (P10-4), for the unit tests and the Playwright suites, which
 * answer `/api/connection*` and `/api/inbox` with them. Fake names and times: the clock is the
 * inbox fixture's (2026-10-25 12:12 UTC). No token value appears anywhere: the API never sends
 * one back. Type imports only: the e2e tests load this file outside the app's bundler.
 */

const uuid = (n: number): string => `00000000-0000-4000-8009-${String(n).padStart(12, "0")}`;

export const FINE_GRAINED_TOKEN: ConnectionToken = {
  login: "sam-r",
  forgeUserId: 5_120_331,
  kind: "fine_grained",
  expiresAt: "2027-01-23T00:00:00.000Z",
  savedAt: "2026-10-20T09:30:00.000Z",
  warnings: [],
};

/** A classic token without an expiry: both warnings. */
export const CLASSIC_TOKEN: ConnectionToken = {
  ...FINE_GRAINED_TOKEN,
  kind: "classic",
  expiresAt: null,
  warnings: ["classic_token", "no_expiry"],
};

export const CONNECTION: ConnectionResponse = {
  connection: "token",
  token: FINE_GRAINED_TOKEN,
  repositories: [
    {
      id: uuid(1),
      forgeRepoId: 81_220_001,
      owner: "sam-r",
      name: "rocky-app",
      private: true,
      openPullRequests: 4,
      lastSyncedAt: "2026-10-25T12:09:00.000Z",
    },
    {
      id: uuid(2),
      forgeRepoId: 81_220_002,
      owner: "acme",
      name: "billing-api",
      private: false,
      openPullRequests: 1,
      lastSyncedAt: "2026-10-25T11:58:00.000Z",
    },
  ],
  lastSyncedAt: "2026-10-25T12:09:00.000Z",
  analysisAuto: true,
  syncing: false,
};

/** No token saved (it was removed): nothing is read or posted. */
export const CONNECTION_NO_TOKEN: ConnectionResponse = {
  ...CONNECTION,
  token: null,
  analysisAuto: false,
  syncing: false,
};

/** A classic token with warnings, nothing followed yet, automatic analysis off. */
export const CONNECTION_EMPTY: ConnectionResponse = {
  connection: "token",
  token: CLASSIC_TOKEN,
  repositories: [],
  lastSyncedAt: null,
  analysisAuto: false,
  syncing: false,
};

export const AVAILABLE: AvailableRepositoriesResponse = {
  repositories: [
    { forgeRepoId: 81_220_001, owner: "sam-r", name: "rocky-app", private: true, added: true },
    { forgeRepoId: 81_220_002, owner: "acme", name: "billing-api", private: false, added: true },
    { forgeRepoId: 81_220_003, owner: "acme", name: "web-console", private: true, added: false },
    { forgeRepoId: 81_220_004, owner: "acme", name: "docs-site", private: false, added: false },
    { forgeRepoId: 81_220_005, owner: "sam-r", name: "dotfiles", private: false, added: false },
  ],
  truncated: false,
};

/** The repository the e2e path adds (web-console) and what adding it read. */
export const ADDED_REPOSITORY = {
  repository: {
    id: uuid(3),
    forgeRepoId: 81_220_003,
    owner: "acme",
    name: "web-console",
    private: true,
    openPullRequests: 3,
    lastSyncedAt: "2026-10-25T12:12:00.000Z",
  },
  sync: {
    outcome: "synced",
    retryAt: null,
    syncedAt: "2026-10-25T12:12:00.000Z",
    repositories: [
      {
        id: uuid(3),
        listed: 3,
        mirrored: 3,
        unchanged: 0,
        analysesQueued: 2,
        problem: null,
      },
    ],
  },
} as const;

export const SYNCED: SyncResponse = {
  outcome: "synced",
  retryAt: null,
  syncedAt: "2026-10-25T12:12:00.000Z",
  repositories: [
    { id: uuid(1), listed: 4, mirrored: 1, unchanged: 3, analysesQueued: 1, problem: null },
    { id: uuid(2), listed: 1, mirrored: 0, unchanged: 1, analysesQueued: 0, problem: null },
  ],
};

export const SYNC_RATE_LIMITED: SyncResponse = {
  outcome: "rate_limited",
  retryAt: "2026-10-25T12:40:00.000Z",
  syncedAt: null,
  repositories: [],
};

/** What `/api/inbox` carries in token mode, per state. */
export const INBOX_SYNC = {
  synced: {
    state: "synced",
    lastSyncedAt: "2026-10-25T12:09:00.000Z",
    problem: null,
    retryAt: null,
  },
  running: {
    state: "running",
    lastSyncedAt: "2026-10-25T11:58:00.000Z",
    problem: null,
    retryAt: null,
  },
  rateLimited: {
    state: "failed",
    lastSyncedAt: "2026-10-25T11:58:00.000Z",
    problem: "rate_limited",
    retryAt: "2026-10-25T12:40:00.000Z",
  },
  tokenRejected: {
    state: "failed",
    lastSyncedAt: "2026-10-25T11:58:00.000Z",
    problem: "token_rejected",
    retryAt: null,
  },
} as const satisfies Record<string, InboxSync>;

/**
 * A token-shaped test value, assembled at run time so no literal in the source looks like a
 * credential (gitleaks). Fine-grained by default; `classic` for the `ghp_` shape.
 */
export const fakeToken = (kind: "fine_grained" | "classic" = "fine_grained"): string =>
  kind === "classic"
    ? ["gh", "p_", "Z".repeat(4), "0123456789".repeat(3), "ab"].join("")
    : ["github", "_pat_", "11AAAA", "0".repeat(16), "_", "x".repeat(60)].join("");
