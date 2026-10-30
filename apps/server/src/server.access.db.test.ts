import { generateLocalKek } from "@rocky-reviews/crypto";
import { createDb, type Db } from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  setAnalysisDocument,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import {
  fakeGitHubApi,
  fakeGitHubOAuth,
  FIXTURE_APP_ID,
  testAppKeys,
  type FakeGitHubApi,
  type FakeGitHubOAuth,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "./auth/cookies.js";
import { startServer, type RunningServer } from "./server.js";

/**
 * H4-1 (ADR 0033): the repository access check (P3-6) wired by `startServer` itself, on a real
 * Postgres as the application role, with the member's own stored token (P7-1 login) and the
 * app's private key for the membership step, against a fake GitHub reached through the global
 * `fetch`. The routes that needed the check (drafts, posting, inbox, "Analyze anyway") answer
 * 200/404 per GitHub access instead of 503; every deny is a 404; an outage is a deny; the cache
 * is invalidated on role change, sign-out and re-login; a removal is refused before the cache;
 * and a boot without the key keeps every such route at 503.
 */

const PUBLIC = "https://rocky.example.com";
const SESSION = "__Host-rocky_session";
const LOGIN = "__Host-rocky_login";
const CLIENT_ID = "Iv23liAccessTest01";
const CLIENT_SECRET = "test-only-client-secret-access-0123456789";
const ALICE = { id: 1001, login: "alice" }; // seedOrg's member, an org admin on GitHub
const BOB = { id: 1002, login: "bob" };
const REPO = 2001; // seedOrg's repository (forge id) in every org
const appKeys = testAppKeys();
const KEK = generateLocalKek();

let pgs: TestPostgres;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;
let github: FakeGitHubApi;
let oauth: FakeGitHubOAuth;
let server: RunningServer | undefined;
let lines: Record<string, unknown>[] = [];
/** Session cookies, signed in once; sessions live in the database across server boots. */
let alice: string;
let bob: string;
let bobMemberId: string;

const env = (extra: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: pgs.appUrl,
  HOST: "127.0.0.1",
  PORT: "0",
  ROCKY_PUBLIC_URL: PUBLIC,
  ROCKY_SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
  ROCKY_KEK_KEYS: `v1=${KEK}`,
  GITHUB_APP_CLIENT_ID: CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
  GITHUB_APP_ID: String(FIXTURE_APP_ID),
  GITHUB_APP_PRIVATE_KEY: appKeys.privateKeyPem,
  ...extra,
});

const boot = async (extra: Record<string, string | undefined> = {}): Promise<RunningServer> => {
  lines = [];
  const log = createLogger("access-boot-test", {
    level: "debug",
    destination: {
      write: (c: string) => void lines.push(JSON.parse(c) as Record<string, unknown>),
    },
  });
  server = await startServer(env(extra), log);
  return server;
};

const app = () => server!.app;

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

/** A full login through the running server: start, approve on the fake GitHub, come back. */
const signIn = async (user: { id: number; login: string }): Promise<string> => {
  const begun = await app().inject({ method: "GET", url: "/auth/github/login" });
  expect(begun.statusCode).toBe(302);
  const callback = oauth.approve(String(begun.headers.location), user);
  const res = await app().inject({
    method: "GET",
    url: `${callback.pathname}${callback.search}`,
    headers: { cookie: `${LOGIN}=${cookieValue(begun, LOGIN)}` },
  });
  expect(res.statusCode).toBe(303);
  const token = cookieValue(res, SESSION);
  expect(token).toBeDefined();
  return token!;
};

const session = async (token: string) =>
  (
    await app().inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: `${SESSION}=${token}` },
    })
  ).json() as { csrfToken: string; orgs: { id: string; memberId: string; role: string }[] };

const headersFor = async (token: string, csrf = false): Promise<Record<string, string>> => ({
  cookie: `${SESSION}=${token}`,
  origin: PUBLIC,
  "sec-fetch-site": "same-origin",
  ...(csrf ? { [CSRF_HEADER]: (await session(token)).csrfToken } : {}),
});

const get = async (token: string, url: string) =>
  app().inject({ method: "GET", url, headers: await headersFor(token) });

const send = async (
  token: string,
  method: "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) =>
  app().inject({
    method,
    url,
    headers: {
      ...(await headersFor(token, true)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

const activate = async (token: string, orgId: string) => {
  const res = await send(token, "POST", "/api/session/active-org", { orgId });
  expect(res.statusCode).toBe(200);
};

/** The three routes that needed the check, as one answer each. */
const drafts = (token: string, org: SeededOrg) =>
  get(token, `/api/analyses/${org.analysisId}/review`);
const posting = (token: string, org: SeededOrg) =>
  get(token, `/api/pull-requests/${org.pullRequestId}/review`);
const inboxLists = async (token: string, org: SeededOrg): Promise<boolean> => {
  const res = await get(token, "/api/inbox");
  expect(res.statusCode).toBe(200);
  const { items } = res.json() as { items: { id: string }[] };
  return items.some((i) => i.id === org.pullRequestId);
};

const accessEvents = () =>
  lines
    .filter((l) => l["event"] === "repository_access")
    .map((l) => ({
      memberId: l["memberId"],
      allowed: l["allowed"],
      reason: l["reason"],
      cached: l["cached"],
    }));

const githubCalls = (path: RegExp) =>
  github.requests.filter((r) => path.test(r.path.replace(/^\//, ""))).length;

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 4 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 81 }),
    await seedOrg(w, newOrgId(), { installationId: 82 }),
  ]);
  for (const org of [A, B]) await setAnalysisDocument(db, org.orgId, org.analysisId, pr847);

  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: appKeys.publicKey });
  oauth = fakeGitHubOAuth({ api: github, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  // The server builds its GitHub clients on the global fetch: the fake serves both hosts.
  vi.stubGlobal("fetch", oauth.fetch);
  for (const id of [81, 82]) {
    github.install(id, { id: 1_000_000 + id, login: `org-${id}`, type: "Organization" });
    github.grantInstallation(ALICE.id, id);
    // An org admin on GitHub: the first owner (P7-2), so alice can change roles and remove.
    github.setOrgMembership(1_000_000 + id, ALICE.id, "active", "admin");
  }
  github.grantInstallation(BOB.id, 81);
  github.setOrgMembership(1_000_081, BOB.id, "active");
  // GitHub knows repository 2001 as org A's (ids are global on GitHub); org B's mirror row
  // names it `org-82/api`, which GitHub does not have.
  github.addRepository(81, { id: REPO, fullName: "org-81/api" });
  github.setPermission(ALICE.id, REPO, "write");

  await boot();
  alice = await signIn(ALICE);
  bob = await signIn(BOB);
  const bobSession = await session(bob);
  bobMemberId = bobSession.orgs[0]!.memberId;
  expect(bobSession.orgs[0]!.role).toBe("member");
  await activate(alice, A.orgId);
  expect((await session(alice)).orgs.find((o) => o.id === A.orgId)?.role).toBe("owner");
  await server!.close();
  server = undefined;
}, CONTAINER_TIMEOUT_MS);

afterEach(async () => {
  await server?.close();
  server = undefined;
  github.setVisibility(REPO, "private");
  github.setPermission(ALICE.id, REPO, "write");
  github.setPermission(BOB.id, REPO, null);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db?.close();
  await pgs?.stop();
});

describe("a running server with the check wired (H4-1)", () => {
  it("answers 200 for a member GitHub lets read the repository, asking GitHub as that member once", async () => {
    await boot();
    expect(server!.repositoryAccess).toBe(true);
    const userCalls = githubCalls(/^user$/);
    expect((await drafts(alice, A)).statusCode).toBe(200);
    expect((await posting(alice, A)).statusCode).toBe(200);
    expect(await inboxLists(alice, A)).toBe(true);
    // One GitHub question (identity + repository), then the cache answers.
    expect(githubCalls(/^user$/)).toBe(userCalls + 1);
    expect(accessEvents()).toEqual([
      { memberId: A.memberId, allowed: true, reason: null, cached: false },
      { memberId: A.memberId, allowed: true, reason: null, cached: true },
      { memberId: A.memberId, allowed: true, reason: null, cached: true },
    ]);
  });

  it("answers 404 for a member GitHub does not let read it: the same as an unknown id, and no data", async () => {
    await boot();
    const denied = await drafts(bob, A);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: "not_found" });
    const unknown = await get(bob, `/api/analyses/${A.orgId}/review`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(denied.json());
    expect((await posting(bob, A)).statusCode).toBe(404);
    expect(await inboxLists(bob, A)).toBe(false);
    expect(accessEvents()[0]).toEqual({
      memberId: bobMemberId,
      allowed: false,
      reason: "not_found",
      cached: false,
    });
  });

  it("a GitHub outage is a deny (404), never an allow", async () => {
    await boot();
    github.failRoute("repository", 500, 1);
    expect((await drafts(alice, A)).statusCode).toBe(404);
    // The transient deny is cached (5 s): the next routes do not ask again, and never allow.
    expect((await posting(alice, A)).statusCode).toBe(404);
    expect(await inboxLists(alice, A)).toBe(false);
    expect(accessEvents().map((e) => [e.allowed, e.reason, e.cached])).toEqual([
      [false, "forge_unavailable", false],
      [false, "forge_unavailable", true],
      [false, "forge_unavailable", true],
    ]);
  });

  it("a public repository: membership is asked on an installation token the server mints with its key", async () => {
    await boot();
    github.setVisibility(REPO, "public");
    github.setPermission(BOB.id, REPO, null);
    const mints = github.tokens.mints.length;
    const revoked = github.tokens.revoked;
    expect((await drafts(alice, A)).statusCode).toBe(200);
    // Everyone can `pull` a public repository; a non-collaborator is still denied (ADR 0011 A15).
    expect((await drafts(bob, A)).statusCode).toBe(404);
    expect(github.tokens.mints.length).toBe(mints + 2);
    expect(github.tokens.mints.at(-1)?.body).toEqual({
      repository_ids: [REPO],
      permissions: { metadata: "read" },
    });
    expect(github.tokens.revoked).toBe(revoked + 2);
    expect(accessEvents().map((e) => [e.allowed, e.reason])).toEqual([
      [true, null],
      [false, "not_collaborator"],
    ]);
  });

  it("an allow cached in org A does not answer for org B (same member, same repository id)", async () => {
    await boot();
    expect((await drafts(alice, A)).statusCode).toBe(200);
    await activate(alice, B.orgId);
    try {
      expect((await drafts(alice, B)).statusCode).toBe(404);
      expect((await posting(alice, B)).statusCode).toBe(404);
      // Org B asked GitHub itself (a fresh deny), then served its own cached deny.
      expect(
        accessEvents()
          .slice(1)
          .map((e) => [e.allowed, e.cached]),
      ).toEqual([
        [false, false],
        [false, true],
      ]);
    } finally {
      await activate(alice, A.orgId);
    }
  });

  it("a role change drops the target's cached allow: the next request asks GitHub again", async () => {
    await boot();
    github.setPermission(BOB.id, REPO, "read");
    expect((await drafts(bob, A)).statusCode).toBe(200);
    // Removed on GitHub: the allow is still cached (the 5-minute bound, ADR 0011).
    github.setPermission(BOB.id, REPO, null);
    expect((await drafts(bob, A)).statusCode).toBe(200);
    const changed = await send(alice, "PATCH", `/api/org/members/${bobMemberId}`, {
      role: "admin",
    });
    expect(changed.statusCode).toBe(200);
    try {
      expect((await drafts(bob, A)).statusCode).toBe(404);
      expect(accessEvents().map((e) => [e.allowed, e.cached])).toEqual([
        [true, false],
        [true, true],
        [false, false],
      ]);
    } finally {
      expect(
        (await send(alice, "PATCH", `/api/org/members/${bobMemberId}`, { role: "member" }))
          .statusCode,
      ).toBe(200);
    }
  });

  it("a removal in Rocky is refused before the cache (403), and a restore drops the cached allow", async () => {
    await boot();
    github.setPermission(BOB.id, REPO, "read");
    expect((await drafts(bob, A)).statusCode).toBe(200);
    github.setPermission(BOB.id, REPO, null);
    expect((await send(alice, "DELETE", `/api/org/members/${bobMemberId}`)).statusCode).toBe(204);
    // The removal cut the org from bob's sessions, and the policy resolves the member on every
    // request (ADR 0024 §4): no route reaches the cache. (A removal that left the link in place
    // would be 403 `not_a_member` from the member row's `removed_at`.)
    const removed = await drafts(bob, A);
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toEqual({ error: "no_active_org" });
    expect(accessEvents()).toHaveLength(1);
    expect((await send(alice, "POST", `/api/org/members/${bobMemberId}/restore`)).statusCode).toBe(
      200,
    );
    // Restored, but their sessions were cut at removal (P7-2): bob signs in again, and the
    // allow cached before the removal is gone (restore and login both invalidate).
    bob = await signIn(BOB);
    expect((await drafts(bob, A)).statusCode).toBe(404);
    expect(accessEvents().at(-1)).toMatchObject({ allowed: false, cached: false });
  });

  it("sign-out and a new sign-in drop the cached allow (token cleared, token stored)", async () => {
    await boot();
    github.setPermission(BOB.id, REPO, "read");
    expect((await drafts(bob, A)).statusCode).toBe(200);
    github.setPermission(BOB.id, REPO, null);
    expect((await drafts(bob, A)).statusCode).toBe(200);
    expect((await send(bob, "POST", "/auth/logout")).statusCode).toBe(204);
    bob = await signIn(BOB);
    expect((await drafts(bob, A)).statusCode).toBe(404);
    expect(accessEvents().map((e) => [e.allowed, e.cached])).toEqual([
      [true, false],
      [true, true],
      [false, false],
    ]);
  });

  it("logs carry ids and fixed reasons only: no user token, installation token, ciphertext or key", async () => {
    await boot();
    github.setVisibility(REPO, "public");
    expect((await drafts(alice, A)).statusCode).toBe(200);
    expect((await drafts(bob, A)).statusCode).toBe(404);
    const text = JSON.stringify(lines);
    for (const secret of [...oauth.issued, ...github.tokens.issued, ...github.userTokens]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("rk1:");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(appKeys.privateKeyPem.split("\n")[1]);
    expect(text).not.toContain(KEK);
    const events = lines.filter((l) => l["event"] === "repository_access");
    expect(events.length).toBeGreaterThanOrEqual(2);
    const base = new Set(["level", "time", "pid", "hostname", "name", "msg"]);
    for (const event of events) {
      const fields = Object.keys(event)
        .filter((k) => !base.has(k))
        .sort();
      expect(fields).toEqual(
        [
          "allowed",
          "cached",
          "event",
          "joined",
          "memberId",
          "orgId",
          "reason",
          "repositoryId",
        ].sort(),
      );
    }
  });
});

describe("a server booted without the app's key (fail closed)", () => {
  it("keeps every route that needs the check at 503 and says so once at boot", async () => {
    await boot({ GITHUB_APP_PRIVATE_KEY: undefined });
    expect(server!.repositoryAccess).toBe(false);
    expect(lines.map((l) => l["msg"])).toContain(
      "GITHUB_APP_PRIVATE_KEY is not set: repository access check disabled; routes that read a repository's data answer 503 (development only)",
    );
    const d = await drafts(alice, A);
    expect(d.statusCode).toBe(503);
    expect(d.json()).toEqual({ error: "access_check_unavailable" });
    const p = await posting(alice, A);
    expect(p.statusCode).toBe(503);
    expect(p.json()).toEqual({ error: "posting_unavailable" });
    const i = await get(alice, "/api/inbox");
    expect(i.statusCode).toBe(503);
    expect(i.json()).toEqual({ error: "access_check_unavailable" });
    const a = await send(alice, "POST", `/api/analyses/${A.analysisId}/approve-over-limit`);
    expect(a.statusCode).toBe(503);
    // Nothing asked GitHub about a repository, and nothing was allowed.
    expect(accessEvents()).toEqual([]);
  });

  it("bulk approval stays 503 even with the check: the approver (P6-7 follow-up) is not wired", async () => {
    await boot();
    const res = await send(alice, "POST", "/api/inbox/approvals", {
      pullRequests: [{ id: A.pullRequestId, headSha: "a".repeat(40) }],
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "approve_unavailable" });
  });
});
