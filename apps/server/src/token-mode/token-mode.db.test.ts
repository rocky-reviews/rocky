import { randomBytes } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import { generateLocalKek, localKeyWrapperFromEnv } from "@rocky-reviews/crypto";
import { createDb, type Db } from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import { findPlaintextLeaks } from "@rocky-reviews/crypto/testing";
import { createGitHubTokenClient, githubEndpoints } from "@rocky-reviews/forge-github";
import {
  fakeGitHubApi,
  FIXTURE_APP_ID,
  testAppKeys,
  type FakeGitHubApi,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import type { LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../auth/cookies.js";
import { ConfigError } from "../config.js";
import { startServer, type RunningServer } from "../server.js";
import { createTokenConnectionService } from "./connection.js";

/**
 * P10-4 (ADR 0045) through `startServer` itself, on a real Postgres as the application role,
 * against a fake GitHub reached through the global `fetch` (no live call): the wizard's token
 * step, the one-time sign-in link, the connection API, the sync on open, and the threats of the
 * task's threat model: the token is encrypted at rest and never in an answer or a log line,
 * the token org is a tenant like any other (RLS), an App instance never gains a token org, the
 * sign-in link is single use, and every write is CSRF-checked.
 */

const PUBLIC = "http://127.0.0.1:4310";
const SESSION = "rocky_session";
const SETUP = "rocky_setup";
const OWNER = { id: 7_001, login: "solo-dev" };
const OTHER = { id: 7_002, login: "someone-else" };
const REPO = { id: 3_001, fullName: "solo-dev/notes" };
const SECOND = { id: 3_002, fullName: "solo-dev/site" };
const HIDDEN = { id: 3_003, fullName: "acme/secret" };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const KEK = generateLocalKek();
const appKeys = testAppKeys();

/** Token-shaped values are assembled at runtime: no literal in the source (gitleaks). */
const fineGrained = () =>
  [
    "github",
    "pat",
    `11${randomBytes(11).toString("hex").toUpperCase()}_${randomBytes(30).toString("hex")}`,
  ].join("_");
const classic = () => `${["g", "h", "p"].join("")}_${randomBytes(18).toString("hex")}`;

let pgs: TestPostgres;
let superuser: pg.Pool;
let db: Db;
let github: FakeGitHubApi;
let server: RunningServer | undefined;
const lines: string[] = [];
let announced: string[] = [];
let ownerToken: string;
/** Every token value any test handed to Rocky: none may appear in an answer or a log. */
const tokens: string[] = [];
const answers: string[] = [];

const env = (extra: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: pgs.appUrl,
  HOST: "127.0.0.1",
  PORT: "0",
  ROCKY_GITHUB_CONNECTION: "token",
  ROCKY_PUBLIC_URL: PUBLIC,
  ROCKY_SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
  ROCKY_KEK_KEYS: `v1=${KEK}`,
  ROCKY_SETUP: "true",
  ROCKY_ANALYSIS_AUTO: "on",
  ...extra,
});

const boot = async (extra: Record<string, string | undefined> = {}): Promise<RunningServer> => {
  await server?.close();
  announced = [];
  const log = createLogger("token-mode-test", {
    level: "debug",
    destination: { write: (c: string) => void lines.push(c) },
  });
  server = await startServer(env(extra), log, { announce: (text) => announced.push(text) });
  return server;
};

const app = () => server!.app;

const linkOf = (path: string): string => {
  const line = announced
    .join("\n")
    .split("\n")
    .find((l) => l.includes(path));
  if (line === undefined) throw new Error(`no ${path} link announced`);
  const url = new URL(line.trim());
  return `${url.pathname}${url.search}`;
};

const setCookies = (res: LightMyRequestResponse): string[] => {
  const header = res.headers["set-cookie"];
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
};
const cookieValue = (res: LightMyRequestResponse, name: string): string | undefined => {
  for (const c of setCookies(res)) {
    const [pair] = c.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair !== undefined && pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
};

const record = (res: LightMyRequestResponse): LightMyRequestResponse => {
  answers.push(res.body, JSON.stringify(res.headers));
  return res;
};

/** The wizard: redeem the setup link, then its status (with the CSRF token). */
const setupSession = async (): Promise<{ cookie: string; csrf: string }> => {
  const start = record(await app().inject({ method: "GET", url: linkOf("/setup/start") }));
  expect(start.statusCode).toBe(303);
  const cookie = cookieValue(start, SETUP)!;
  const status = record(
    await app().inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { cookie: `${SETUP}=${cookie}` },
    }),
  );
  expect(status.statusCode).toBe(200);
  return { cookie, csrf: (status.json() as { csrfToken: string }).csrfToken };
};

const saveInWizard = async (setup: { cookie: string; csrf: string }, token: string) => {
  tokens.push(token);
  return record(
    await app().inject({
      method: "POST",
      url: "/api/setup/token",
      headers: {
        cookie: `${SETUP}=${setup.cookie}`,
        origin: PUBLIC,
        "sec-fetch-site": "same-origin",
        [CSRF_HEADER]: setup.csrf,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ token }),
    }),
  );
};

const session = async (cookie: string) =>
  record(
    await app().inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: `${SESSION}=${cookie}` },
    }),
  );

const call = async (
  cookie: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  options: { csrf?: boolean } = {},
) => {
  const csrf =
    method === "GET" || options.csrf === false
      ? {}
      : { [CSRF_HEADER]: ((await session(cookie)).json() as { csrfToken: string }).csrfToken };
  return record(
    await app().inject({
      method,
      url,
      headers: {
        cookie: `${SESSION}=${cookie}`,
        origin: PUBLIC,
        "sec-fetch-site": "same-origin",
        ...csrf,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    }),
  );
};

let owner: string;
let orgId: string;

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: appKeys.publicKey });
  vi.stubGlobal("fetch", github.fetch);
  // The fake keeps repositories under an installation; the token sees them through the owner's
  // role on each, as GitHub does for a personal token.
  github.install(91, { id: OWNER.id, login: OWNER.login, type: "User" });
  github.install(92, { id: 9_100, login: "acme", type: "Organization" });
  github.addRepository(91, REPO);
  github.addRepository(91, SECOND);
  github.addRepository(92, HIDDEN);
  github.setPermission(OWNER.id, REPO.id, "write");
  github.setPermission(OWNER.id, SECOND.id, "read");
  github.putPullRequest(REPO.id, { number: 12, headSha: HEAD, baseSha: BASE, title: "Add notes" });
  github.putPullRequest(REPO.id, {
    number: 11,
    headSha: "c".repeat(40),
    baseSha: BASE,
    state: "closed",
  });
  ownerToken = github.addUser(OWNER, {
    token: fineGrained(),
    tokenExpiresAt: "2027-01-01 00:00:00 UTC",
  });
  tokens.push(ownerToken);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("configuration (Rocky Cloud refusal, one connection)", () => {
  it("refuses token mode on Fly.io, where Rocky Cloud runs, before opening anything", async () => {
    await expect(
      startServer(env({ FLY_APP_NAME: "rocky-cloud-prod" }), createLogger("x")),
    ).rejects.toThrow(/refused on Fly\.io/);
  });

  it("refuses token mode next to any GitHub App variable", async () => {
    for (const name of ["GITHUB_APP_ID", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_ID"]) {
      await expect(startServer(env({ [name]: "123" }), createLogger("x"))).rejects.toThrow(
        new RegExp(`${name} must be unset`),
      );
    }
  });

  it("needs the KEK (the token is stored encrypted) and refuses a non-loopback http URL", async () => {
    await expect(
      startServer(env({ ROCKY_KEK_KEYS: undefined }), createLogger("x")),
    ).rejects.toThrow(/ROCKY_KEK_KEYS/);
    await expect(
      startServer(env({ ROCKY_PUBLIC_URL: "http://rocky.example.com" }), createLogger("x")),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("before a token is saved", () => {
  it("boots in full in production on loopback http, prints both links to the terminal only", async () => {
    await boot({ NODE_ENV: "production", ROCKY_TRUST_PROXY: "none" });
    expect(server!.connection).toBe("token");
    expect(server!.setupMode).toBe(false);
    expect(server!.webhooks).toBe(false);
    expect(server!.githubAppSetup).toBe(false);
    expect(linkOf("/setup/start")).toMatch(/^\/setup\/start\?token=[A-Za-z0-9_-]{43}$/);
    expect(linkOf("/auth/token/start")).toMatch(/^\/auth\/token\/start\?token=[A-Za-z0-9_-]{43}$/);
    // The links are credentials: never in a log line.
    const joined = lines.join("\n");
    expect(joined).not.toContain(linkOf("/setup/start").split("=")[1]);
    expect(joined).not.toContain(linkOf("/auth/token/start").split("=")[1]);
    // No GitHub login, no webhook receiver, no manifest flow.
    expect((await app().inject({ method: "GET", url: "/auth/github/login" })).statusCode).toBe(404);
    expect(
      (await app().inject({ method: "POST", url: "/webhooks/github", payload: "{}" })).statusCode,
    ).toBe(404);
  });

  it("warns at boot when the sign-in link cannot work (no token, no wizard) or http leaves the loopback", async () => {
    lines.length = 0;
    await boot({ ROCKY_SETUP: undefined });
    expect(lines.some((l) => l.includes('"warning":"no_token_connected"'))).toBe(true);
    expect(lines.some((l) => l.includes('"warning":"plain_http_beyond_loopback"'))).toBe(false);
    lines.length = 0;
    await boot({ HOST: "0.0.0.0" });
    expect(lines.some((l) => l.includes('"warning":"plain_http_beyond_loopback"'))).toBe(true);
    // With the wizard open there is a way to connect a token: no warning about that.
    expect(lines.some((l) => l.includes('"warning":"no_token_connected"'))).toBe(false);
    await boot();
  });

  it("a signed-out browser is told to use the boot link, and the wizard asks for a token", async () => {
    const res = await app().inject({ method: "GET", url: "/api/session" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthenticated",
      authenticated: false,
      signIn: "token_link",
    });
    const setup = await setupSession();
    const status = (
      await app().inject({
        method: "GET",
        url: "/api/setup/status",
        headers: { cookie: `${SETUP}=${setup.cookie}` },
      })
    ).json() as Record<string, Record<string, unknown>>;
    expect(status["connection"]).toBe("token");
    expect(status["githubApp"]).toMatchObject({
      state: "token_required",
      token: null,
      createPath: null,
    });
    expect(status["repositories"]).toMatchObject({ state: "waiting_for_token" });
    // The sign-in link before any token: refused, and still usable once one is saved.
    for (let i = 0; i < 2; i++) {
      const early = await app().inject({ method: "GET", url: linkOf("/auth/token/start") });
      expect(early.statusCode).toBe(404);
      expect(cookieValue(early, SESSION)).toBeUndefined();
    }
  });
});

describe("saving the token in the wizard", () => {
  let setup: { cookie: string; csrf: string };

  it("needs the setup session and its CSRF token", async () => {
    await boot();
    setup = await setupSession();
    const token = fineGrained();
    const anonymous = await app().inject({
      method: "POST",
      url: "/api/setup/token",
      headers: { origin: PUBLIC, "content-type": "application/json" },
      payload: JSON.stringify({ token }),
    });
    expect(anonymous.statusCode).toBe(403);
    const forged = await app().inject({
      method: "POST",
      url: "/api/setup/token",
      headers: {
        cookie: `${SETUP}=${setup.cookie}`,
        origin: "https://evil.example",
        [CSRF_HEADER]: setup.csrf,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ token }),
    });
    expect(forged.statusCode).toBe(403);
    expect(await db.tokenOrg("github")).toBeNull();
  });

  it("refuses what is not a usable personal token, by fixed code, never echoing it", async () => {
    const before = github.requests.length;
    const gho = `gh${"o"}_${randomBytes(18).toString("hex")}`;
    const notPersonal = await saveInWizard(setup, gho);
    expect(notPersonal.statusCode).toBe(422);
    expect(notPersonal.json()).toEqual({ error: "not_a_personal_token", retryAt: null });
    // Refused by shape: GitHub was not even asked.
    expect(github.requests.length).toBe(before);

    const unknown = await saveInWizard(setup, fineGrained());
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toEqual({ error: "token_rejected", retryAt: null });

    const noScope = github.addUser(OWNER, { token: classic(), scopes: "read:user, gist" });
    const scopeless = await saveInWizard(setup, noScope);
    expect(scopeless.json()).toEqual({ error: "missing_permissions", retryAt: null });

    const reset = Date.parse("2026-11-11T12:00:00Z");
    github.exhaustRateLimit(reset);
    try {
      const limited = await saveInWizard(setup, ownerToken);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({
        error: "rate_limited",
        retryAt: new Date(reset).toISOString(),
      });
    } finally {
      github.restoreRateLimit();
    }
    expect(await db.tokenOrg("github")).toBeNull();
  });

  it("validates with GitHub, creates the org, stores the token encrypted and signs the operator in", async () => {
    const saved = await saveInWizard(setup, ownerToken);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      token: {
        login: OWNER.login,
        forgeUserId: OWNER.id,
        kind: "fine_grained",
        expiresAt: "2027-01-01T00:00:00.000Z",
        savedAt: expect.any(String),
        warnings: [],
      },
    });
    owner = cookieValue(saved, SESSION)!;
    expect(owner).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = (await session(owner)).json() as {
      connection: string;
      orgs: { id: string; role: string; login: string }[];
      activeOrgId: string;
    };
    expect(me.connection).toBe("token");
    expect(me.orgs).toEqual([expect.objectContaining({ role: "owner", login: OWNER.login })]);
    orgId = me.activeOrgId;
    expect((await db.tokenOrg("github"))?.orgId).toBe(orgId);
    // At rest: only the envelope ciphertext; the database dump never holds the token.
    const { rows } = await superuser.query<{ c: Buffer | null }>(
      "select forge_token_ciphertext as c from members where org_id = $1",
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.c!.toString("utf8").startsWith("rk1:")).toBe(true);
    expect(findPlaintextLeaks(await pgs.dump(), [ownerToken])).toEqual([]);
    const status = (
      await app().inject({
        method: "GET",
        url: "/api/setup/status",
        headers: { cookie: `${SETUP}=${setup.cookie}` },
      })
    ).json() as Record<string, Record<string, unknown>>;
    expect(status["githubApp"]).toMatchObject({ state: "token_connected" });
    expect(status["repositories"]).toMatchObject({ state: "installed" });
    // The boot link the early visits did not burn now signs the owner in.
    const late = await app().inject({ method: "GET", url: linkOf("/auth/token/start") });
    expect(late.statusCode).toBe(303);
    expect(cookieValue(late, SESSION)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses another person's token for this instance", async () => {
    const other = github.addUser(OTHER, { token: fineGrained() });
    const res = await saveInWizard(setup, other);
    expect(res.json()).toEqual({ error: "token_user_mismatch", retryAt: null });
  });
});

describe("the one-time sign-in link", () => {
  it("signs the token's owner in once; a second use or a wrong token is refused", async () => {
    await boot();
    const link = linkOf("/auth/token/start");
    const wrong = await app().inject({
      method: "GET",
      url: `/auth/token/start?token=${"x".repeat(43)}`,
    });
    expect(wrong.statusCode).toBe(403);
    expect(cookieValue(wrong, SESSION)).toBeUndefined();
    const first = await app().inject({ method: "GET", url: link });
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe(`${PUBLIC}/inbox`);
    const cookie = cookieValue(first, SESSION)!;
    expect(((await session(cookie)).json() as { activeOrgId: string }).activeOrgId).toBe(orgId);
    const again = await app().inject({ method: "GET", url: link });
    expect(again.statusCode).toBe(403);
    expect(cookieValue(again, SESSION)).toBeUndefined();
    owner = cookie;
  });
});

describe("the connection API", () => {
  it("describes the token without its value, and only to the signed-in owner", async () => {
    const res = await call(owner, "GET", "/api/connection");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      connection: "token",
      token: { login: OWNER.login, kind: "fine_grained" },
      repositories: [],
      lastSyncedAt: null,
      analysisAuto: true,
    });
    expect((await app().inject({ method: "GET", url: "/api/connection" })).statusCode).toBe(401);
  });

  it("lists what the token can see (never another account's private repository)", async () => {
    const res = await call(owner, "GET", "/api/connection/available");
    expect(res.statusCode).toBe(200);
    const { repositories } = res.json() as {
      repositories: { forgeRepoId: number; added: boolean }[];
    };
    expect(repositories.map((r) => r.forgeRepoId).sort()).toEqual([REPO.id, SECOND.id]);
    expect(repositories.every((r) => !r.added)).toBe(true);
  });

  it("refuses a write without the CSRF token", async () => {
    const res = await call(
      owner,
      "POST",
      "/api/connection/repositories",
      { forgeRepoId: REPO.id },
      { csrf: false },
    );
    expect(res.statusCode).toBe(403);
    expect(await db.withOrg(orgId as never, (tx) => tx.query("select 1 from repos"))).toMatchObject(
      { rowCount: 0 },
    );
  });

  it("adds a repository and syncs it: open pull requests listed, analysis queued, closed ones never read", async () => {
    const reads = github.requests.length;
    const res = await call(owner, "POST", "/api/connection/repositories", { forgeRepoId: REPO.id });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      repository: {
        owner: string;
        name: string;
        openPullRequests: number;
        lastSyncedAt: string | null;
      };
      sync: {
        outcome: string;
        repositories: { listed: number; mirrored: number; analysesQueued: number }[];
      };
    };
    expect(body.repository).toMatchObject({
      owner: "solo-dev",
      name: "notes",
      openPullRequests: 1,
    });
    expect(body.repository.lastSyncedAt).not.toBeNull();
    expect(body.sync.outcome).toBe("synced");
    expect(body.sync.repositories).toEqual([
      expect.objectContaining({ listed: 1, mirrored: 1, analysesQueued: 1, problem: null }),
    ]);
    // Closed pull request #11 was never read: one listing of open ones, the PR, its diff.
    const paths = github.requests.slice(reads).map((r) => r.path);
    expect(paths.some((p) => p.includes("/pulls/11"))).toBe(false);
    const { rows } = await superuser.query<{ status: string }>(
      "select status from analyses where org_id = $1",
      [orgId],
    );
    expect(rows).toEqual([{ status: "queued" }]);
  });

  it("refuses a repository the token cannot see, by fixed code", async () => {
    const res = await call(owner, "POST", "/api/connection/repositories", {
      forgeRepoId: HIDDEN.id,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "repository_not_found", retryAt: null });
    const bad = await call(owner, "POST", "/api/connection/repositories", {
      forgeRepoId: "1; drop",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("the inbox lists the pull request; opening it again within a minute does not sync again", async () => {
    const res = await call(owner, "GET", "/api/inbox");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { number: number }[];
      sync: { state: string; lastSyncedAt: string };
    };
    expect(body.items.map((i) => i.number)).toEqual([12]);
    expect(body.sync).toMatchObject({ state: "skipped", problem: null });
    expect(body.sync.lastSyncedAt).not.toBeNull();
  });

  it("Sync reads GitHub again: a merge shows; a rate limit stops it with GitHub's reset time", async () => {
    // Wait out the explicit-sync throttle (5 s) by forcing through the service's guard: a new boot.
    await boot();
    owner = await (async () => {
      const first = await app().inject({ method: "GET", url: linkOf("/auth/token/start") });
      return cookieValue(first, SESSION)!;
    })();
    github.putPullRequest(REPO.id, {
      number: 12,
      headSha: HEAD,
      baseSha: BASE,
      state: "closed",
      merged: true,
      updatedAt: "2026-11-11T09:00:00Z",
    });
    const synced = await call(owner, "POST", "/api/connection/sync", {});
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({ outcome: "synced" });
    const inbox = (await call(owner, "GET", "/api/inbox")).json() as { items: unknown[] };
    expect(inbox.items).toEqual([]);

    await boot();
    owner = cookieValue(
      await app().inject({ method: "GET", url: linkOf("/auth/token/start") }),
      SESSION,
    )!;
    const reset = Date.parse("2026-11-11T13:00:00Z");
    github.exhaustRateLimit(reset);
    try {
      const limited = await call(owner, "POST", "/api/connection/sync", {});
      expect(limited.statusCode).toBe(200);
      expect(limited.json()).toMatchObject({
        outcome: "rate_limited",
        retryAt: new Date(reset).toISOString(),
      });
    } finally {
      github.restoreRateLimit();
    }
  });

  it("stops following a repository: the inbox no longer lists it; another org's id is not found", async () => {
    const { repositories } = (await call(owner, "GET", "/api/connection")).json() as {
      repositories: { id: string }[];
    };
    const id = repositories[0]!.id;
    const foreign = await call(owner, "DELETE", `/api/connection/repositories/${newOrgId()}`);
    expect(foreign.statusCode).toBe(404);
    expect((await call(owner, "DELETE", `/api/connection/repositories/${id}`)).statusCode).toBe(
      204,
    );
    expect(
      ((await call(owner, "GET", "/api/connection")).json() as { repositories: unknown[] })
        .repositories,
    ).toEqual([]);
  });

  it("replaces the token (same owner only) and removes it: Rocky then reads nothing", async () => {
    const next = github.addUser(OWNER, { token: classic(), scopes: "repo, read:org" });
    tokens.push(next);
    const replaced = await call(owner, "PUT", "/api/connection/token", { token: next });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      token: { kind: "classic", warnings: ["classic_token", "no_expiry"] },
    });
    const other = github.addUser(OTHER, { token: fineGrained() });
    tokens.push(other);
    expect((await call(owner, "PUT", "/api/connection/token", { token: other })).json()).toEqual({
      error: "token_user_mismatch",
      retryAt: null,
    });
    expect((await call(owner, "DELETE", "/api/connection/token")).statusCode).toBe(204);
    const { rows } = await superuser.query<{ c: Buffer | null }>(
      "select forge_token_ciphertext as c from members where org_id = $1",
      [orgId],
    );
    expect(rows[0]!.c).toBeNull();
    const available = await call(owner, "GET", "/api/connection/available");
    expect(available.statusCode).toBe(409);
    expect(available.json()).toEqual({ error: "no_token", retryAt: null });
    // Saved again for the tests after this one.
    expect(
      (await call(owner, "PUT", "/api/connection/token", { token: ownerToken })).statusCode,
    ).toBe(200);
  });

  it("a replacement bound to another org is refused before GitHub is asked or anything is written", async () => {
    const service = createTokenConnectionService({
      db,
      keys: localKeyWrapperFromEnv({ ROCKY_KEK_KEYS: `v1=${KEK}` }),
      client: createGitHubTokenClient({ api: githubEndpoints({}).api, fetch: github.fetch }),
      log: { info: () => undefined, warn: () => undefined },
      forge: "github",
      analysisAuto: false,
    });
    const state = async () =>
      (
        await superuser.query<{ c: string; n: string }>(
          `select (select encode(forge_token_ciphertext, 'escape') from members where org_id = $1) as c,
                  (select count(*)::text from audit_events where org_id = $1) as n`,
          [orgId],
        )
      ).rows[0];
    const before = await state();
    const requests = github.requests.length;
    const elsewhere = "00000000-0000-4000-8000-000000000001" as OrgId;
    expect(await service.saveToken(ownerToken, { orgId: elsewhere })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(github.requests.length).toBe(requests);
    expect(await state()).toEqual(before);
    // The caller's own org: saved as usual.
    expect((await service.saveToken(ownerToken, { orgId: orgId as OrgId })).ok).toBe(true);
  });
});

describe("opening the inbox while a long sync runs", () => {
  it("answers `running` after a short wait, lets the sync finish, and never runs two at once", async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let listings = 0;
    const slow: typeof fetch = async (input, init) => {
      if (String(input).includes("/pulls?")) {
        listings++;
        await pause(300);
      }
      return github.fetch(input, init);
    };
    const service = createTokenConnectionService({
      db,
      keys: localKeyWrapperFromEnv({ ROCKY_KEK_KEYS: `v1=${KEK}` }),
      client: createGitHubTokenClient({ api: githubEndpoints({}).api, fetch: slow }),
      log: { info: () => undefined, warn: () => undefined },
      forge: "github",
      analysisAuto: false,
      syncOnOpenWaitMs: 20,
      syncOnOpenIntervalMs: 0,
    });
    const added = await service.addRepository(orgId as OrgId, REPO.id);
    expect(added.ok).toBe(true);
    const before = listings;
    const first = await service.syncOnOpen(orgId as OrgId);
    expect(first).toMatchObject({ state: "running", problem: null });
    // A second opening while it runs starts nothing new.
    expect(await service.syncOnOpen(orgId as OrgId)).toMatchObject({ state: "running" });
    await pause(700);
    expect(listings).toBe(before + 1);
    const synced = await db.withOrg(orgId as OrgId, (tx) =>
      tx.query<{ at: Date }>("select max(synced_at) as at from repos where enabled"),
    );
    expect(synced.rows[0]!.at.getTime()).toBeGreaterThan(Date.parse(first.lastSyncedAt!));
  });
});

describe("tenancy", () => {
  it("an App org on the same database sees nothing of the token org, and the reverse", async () => {
    const appOrg = await asWorker(pgs.workerUrl, (w) =>
      seedOrg(w, newOrgId(), { installationId: 81 }),
    );
    const fromApp = await db.withOrg(appOrg.orgId, async (tx) => ({
      members: (await tx.query("select id from members where forge_user_id = $1", [OWNER.id]))
        .rowCount,
      repos: (await tx.query("select id from repos where forge_repo_id = $1", [REPO.id])).rowCount,
      orgs: (await tx.query("select id from orgs")).rows,
    }));
    expect(fromApp).toEqual({ members: 0, repos: 0, orgs: [{ id: appOrg.orgId }] });
    const fromToken = await db.withOrg(orgId as never, async (tx) => ({
      pulls: (await tx.query("select id from pull_requests where id = $1", [appOrg.pullRequestId]))
        .rowCount,
      analyses: (await tx.query("select id from analyses where id = $1", [appOrg.analysisId]))
        .rowCount,
    }));
    expect(fromToken).toEqual({ pulls: 0, analyses: 0 });
  });
});

describe("the token never leaves", () => {
  it("is in no answer, header or log line of this whole file", () => {
    const everything = [...answers, ...lines, ...announced].join("\n");
    for (const token of tokens) expect(everything).not.toContain(token);
    // And GitHub only ever saw it as a bearer header on the API host (the fake checks the host).
    expect(github.requests.every((r) => !r.path.includes("github_pat_"))).toBe(true);
  });
});
