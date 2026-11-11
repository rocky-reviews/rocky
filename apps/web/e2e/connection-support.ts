import type { Page } from "@playwright/test";
import type {
  ConnectionResponse,
  InboxSync,
  SetupStatusResponse,
  SyncResponse,
} from "@rocky-reviews/core";
import {
  ADDED_REPOSITORY,
  AVAILABLE,
  CONNECTION,
  fakeToken,
  FINE_GRAINED_TOKEN,
  INBOX_SYNC,
  SYNCED,
} from "../src/connection/fixtures.js";
import { INBOX_FIXTURE } from "../src/inbox/fixtures.js";
import { SETUP_FIXTURES } from "../src/setup/fixtures.js";
import { FIXTURE_NOW } from "./support.js";

export { ADDED_REPOSITORY, AVAILABLE, CONNECTION, fakeToken, INBOX_SYNC, SETUP_FIXTURES, SYNCED };

/**
 * P10-4: token mode's API answered here (no server, no GitHub): the session (signed in, token
 * mode), `/api/connection*` with a small in-memory state, `/api/inbox` with a `sync` field, and
 * the wizard's `/api/setup/token`. Every request that changes something is recorded with its
 * CSRF header and body, so a test can prove what was (and was not) sent.
 */

export const CSRF = "csrf-token-for-e2e";

export interface Sent {
  readonly method: string;
  readonly path: string;
  readonly csrf: string | null;
  readonly body: unknown;
}

type Answer = { status: number; json?: unknown };

export interface ConnectionMock {
  readonly sent: Sent[];
  /** What the next requests to a route answer (`PUT token`, `POST sync`, …). */
  answer(key: string, answer: Answer | null): void;
}

const session = {
  authenticated: true,
  user: { id: "u1", forgeUserId: 5_120_331 },
  orgs: [],
  activeOrgId: null,
  csrfToken: CSRF,
  expiresAt: "2026-10-26T00:00:00.000Z",
  idleExpiresAt: "2026-10-26T00:00:00.000Z",
  connection: "token",
};

const record = (sent: Sent[], route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
  const request = route.request();
  const url = new URL(request.url());
  const entry: Sent = {
    method: request.method(),
    path: url.pathname,
    csrf: request.headers()["x-rocky-csrf"] ?? null,
    body:
      request.postData() === null ? null : (JSON.parse(request.postData() ?? "null") as unknown),
  };
  if (entry.method !== "GET") sent.push(entry);
  return entry;
};

/** Answers the session as a signed-in token-mode user. */
export const mockTokenSession = async (page: Page): Promise<void> => {
  await page.route("**/api/session", (route) => route.fulfill({ json: session }));
};

/** Opens `/connection` with the connection API answered from `initial`. */
export const openConnection = async (
  page: Page,
  initial: ConnectionResponse = CONNECTION,
): Promise<ConnectionMock> => {
  let state: ConnectionResponse = initial;
  const sent: Sent[] = [];
  const overrides = new Map<string, Answer>();
  await mockTokenSession(page);
  await page.route(
    (url) => url.pathname.startsWith("/api/connection"),
    async (route) => {
      const { method, path } = record(sent, route);
      const key = `${method} ${path.replace(/[0-9a-f-]{36}$/, ":id")}`;
      const override = overrides.get(key);
      if (override !== undefined) return route.fulfill(override);
      switch (key) {
        case "GET /api/connection":
          return route.fulfill({ json: state });
        case "PUT /api/connection/token":
          state = {
            ...state,
            token: { ...FINE_GRAINED_TOKEN, savedAt: FIXTURE_NOW.toISOString() },
          };
          return route.fulfill({ json: { token: state.token } });
        case "DELETE /api/connection/token":
          state = { ...state, token: null };
          return route.fulfill({ status: 204 });
        case "GET /api/connection/available":
          return route.fulfill({ json: AVAILABLE });
        case "POST /api/connection/repositories":
          state = { ...state, repositories: [...state.repositories, ADDED_REPOSITORY.repository] };
          return route.fulfill({ json: ADDED_REPOSITORY });
        case "DELETE /api/connection/repositories/:id": {
          const id = path.split("/").at(-1);
          state = { ...state, repositories: state.repositories.filter((r) => r.id !== id) };
          return route.fulfill({ status: 204 });
        }
        case "POST /api/connection/sync":
          return route.fulfill({ json: SYNCED });
        default:
          return route.fulfill({ status: 404, json: { error: "not_found", retryAt: null } });
      }
    },
  );
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/connection");
  await page.locator("#token-title").waitFor();
  return {
    sent,
    answer: (key, answer) => {
      if (answer === null) overrides.delete(key);
      else overrides.set(key, answer);
    },
  };
};

export interface TokenInboxMock {
  readonly sent: Sent[];
  /** How many times the page loaded the inbox. */
  readonly loads: () => number;
  /** What the next loads carry as `sync`. */
  setSync(sync: InboxSync): void;
}

/** Opens the inbox in token mode: each load carries `sync`; Sync answers `syncAnswer`. */
export const openTokenInbox = async (
  page: Page,
  initial: InboxSync,
  syncAnswer: SyncResponse = SYNCED,
): Promise<TokenInboxMock> => {
  const sent: Sent[] = [];
  let loads = 0;
  let sync = initial;
  await mockTokenSession(page);
  await page.route("**/api/inbox", (route) => {
    loads += 1;
    return route.fulfill({ json: { ...INBOX_FIXTURE, sync } });
  });
  await page.route("**/api/connection/sync", (route) => {
    record(sent, route);
    return route.fulfill({ json: syncAnswer });
  });
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/inbox");
  await page.locator("#inbox-title").waitFor();
  return {
    sent,
    loads: () => loads,
    setSync: (next) => {
      sync = next;
    },
  };
};

/**
 * Answers the wizard's `POST /api/setup/token` (before `openSetup`): `answer` for each request;
 * on a 200 the wizard's next status is `after`.
 */
export const mockSetupToken = async (
  page: Page,
  answer: () => Answer,
  onSaved: () => void = () => undefined,
): Promise<Sent[]> => {
  const sent: Sent[] = [];
  await page.route("**/api/setup/token", (route) => {
    record(sent, route);
    const a = answer();
    if (a.status === 200) onSaved();
    return route.fulfill(a);
  });
  return sent;
};

export const TOKEN_SAVED: Answer = {
  status: 200,
  json: { token: (SETUP_FIXTURES["token-connected"] as SetupStatusResponse).githubApp.token },
};
