import { randomBytes } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import {
  decodeWrappedDataKey,
  generateLocalKek,
  LocalKeyWrapper,
  OrgKeyring,
} from "@rocky-reviews/crypto";
import {
  createDb,
  loadForgeToken,
  loadOrgDataKey,
  markMemberRemoved,
  scheduleOrgDeletion,
  type Db,
} from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import { createGitHubLogin, githubEndpoints } from "@rocky-reviews/forge-github";
import {
  fakeGitHubApi,
  fakeGitHubOAuth,
  FIXTURE_APP_ID,
  testAppKeys,
  type FakeGitHubApi,
  type FakeGitHubOAuth,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { MEMBER_TOKEN_PURPOSE } from "../repository-access.js";
import { CSRF_HEADER } from "./cookies.js";
import { LOGIN_TTL_MS, SESSION_IDLE_SECONDS } from "./routes.js";
import { OPEN_REDIRECT_VECTORS } from "./test-support.js";

/**
 * P7-1 end to end (ADR 0020): the server's login routes on a real Postgres as the application
 * role, the org keyring, and a fake GitHub (web flow + API) serving documentation-shaped
 * fixtures, with an injected clock. Acceptance criteria: session fixation, CSRF and open-redirect
 * tests pass; plus the threat model's other rows (state, PKCE, expiry, logout, tenancy, logs).
 */

const PUBLIC = new URL("https://rocky.example.com/");
const ORIGIN = PUBLIC.origin;
const CLIENT_ID = "Iv23liTestClient01";
const CLIENT_SECRET = "test-only-client-secret-0123456789abcdef";
const ALICE = { id: 1001, login: "alice" }; // seedOrg's member in every org
const MALLORY = { id: 6666, login: "mallory" };
const T0 = Date.parse("2026-10-27T10:00:00Z");
const HOUR = 3_600_000;
const SESSION = "__Host-rocky_session";
const LOGIN = "__Host-rocky_login";

let pgs: TestPostgres;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;
let C: SeededOrg; // scheduled for deletion
let D: SeededOrg; // installed on a User account (installation 84)
const keys = new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]);
const appKeys = testAppKeys();

let clock = T0;
let github: FakeGitHubApi;
let oauth: FakeGitHubOAuth;
let app: FastifyInstance;
let lines: string[];
let changed: string[];

const build = (
  extra: {
    cookieSecure?: boolean;
    publicUrl?: URL;
    requireTokenExpiry?: boolean;
    db?: Db;
  } = {},
) => {
  lines = [];
  changed = [];
  const log = createLogger("auth-test", {
    level: "debug",
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const built = buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    auth: {
      publicUrl: extra.publicUrl ?? PUBLIC,
      cookieSecure: extra.cookieSecure ?? true,
      secret: randomBytes(32),
      login: createGitHubLogin({
        endpoints: githubEndpoints({}),
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        appId: FIXTURE_APP_ID,
        fetch: oauth.fetch,
        now: () => clock,
      }),
      db: extra.db ?? db,
      keys,
      now: () => clock,
      ...(extra.requireTokenExpiry === undefined
        ? {}
        : { requireTokenExpiry: extra.requireTokenExpiry }),
      onMemberTokenChanged: (orgId, memberId) => changed.push(`${orgId}:${memberId}`),
    },
  });
  return built;
};

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 4 });
  [A, B, C, D] = await asWorker(pgs.workerUrl, async (w) => {
    const a = await seedOrg(w, newOrgId(), { installationId: 81 });
    const b = await seedOrg(w, newOrgId(), { installationId: 82 });
    const c = await seedOrg(w, newOrgId(), { installationId: 83 });
    await w.withOrg(c.orgId, (tx) => scheduleOrgDeletion(tx, 83));
    const d = await seedOrg(w, newOrgId(), { installationId: 84 });
    return [a, b, c, d];
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pgs?.stop();
});

beforeEach(async () => {
  clock = T0;
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: appKeys.publicKey, now: () => clock });
  oauth = fakeGitHubOAuth({
    api: github,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    now: () => clock,
  });
  for (const id of [81, 82, 83]) {
    github.install(id, { id: 1_000_000 + id, login: `org-${id}`, type: "Organization" });
  }
  github.install(84, { id: 1_000_084, login: "owner-84", type: "User" });
  for (const id of [81, 82, 83]) member(ALICE, id);
  await app?.close();
  app = build();
});

// --- helpers -----------------------------------------------------------------------------------

/** An active member of the organization behind installation `id` (and it is visible to them). */
const member = (user: { id: number }, id: number) => {
  github.grantInstallation(user.id, id);
  github.setOrgMembership(1_000_000 + id, user.id, "active");
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
const pathOf = (url: URL) => `${url.pathname}${url.search}`;

/** Starts a login in a browser holding `jar`; returns the GitHub URL and the login cookie. */
const start = async (returnTo?: string, jar = "") => {
  const res = await app.inject({
    method: "GET",
    url:
      returnTo === undefined
        ? "/auth/github/login"
        : `/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`,
    headers: jar === "" ? {} : { cookie: jar },
  });
  expect(res.statusCode).toBe(302);
  return { res, authorize: String(res.headers.location), loginCookie: cookieValue(res, LOGIN) };
};

/** A full login: start, approve on GitHub as `user`, come back with the login cookie. */
const login = async (
  options: { user?: { id: number; login: string }; returnTo?: string; jar?: string } = {},
) => {
  const begun = await start(options.returnTo, options.jar ?? "");
  const callback = oauth.approve(begun.authorize, options.user ?? ALICE);
  const jar = [options.jar ?? "", `${LOGIN}=${begun.loginCookie}`].filter(Boolean).join("; ");
  const res = await app.inject({ method: "GET", url: pathOf(callback), headers: { cookie: jar } });
  return { res, callback, begun, session: cookieValue(res, SESSION) };
};

const sessionOf = async (token: string | undefined) =>
  app.inject({
    method: "GET",
    url: "/api/session",
    headers: token === undefined ? {} : { cookie: `${SESSION}=${token}` },
  });

const csrfOf = async (token: string): Promise<string> =>
  ((await sessionOf(token)).json() as { csrfToken: string }).csrfToken;

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      ...headers,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

const sameOrigin = async (token: string) => ({
  cookie: `${SESSION}=${token}`,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  [CSRF_HEADER]: await csrfOf(token),
});

const auditActions = async (orgId: OrgId) =>
  db.withOrg(
    orgId,
    async (tx) =>
      (
        await tx.query<{ action: string; target_id: string; metadata: Record<string, unknown> }>(
          "select action, target_id, metadata from audit_events where action like 'auth.%' order by id",
        )
      ).rows,
  );

// --- the flow ----------------------------------------------------------------------------------

describe("login with GitHub (PKCE, state, sessions in the database)", () => {
  it("logs in: S256 PKCE, server-side exchange, numeric identity, orgs from GitHub, __Host- cookie", async () => {
    const begun = await start("/inbox");
    const authorize = new URL(begun.authorize);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const loginSetCookie = setCookies(begun.res)[0] ?? "";
    expect(loginSetCookie).toMatch(
      new RegExp(
        `^${LOGIN}=v1\\.[^;]+; Path=/; Max-Age=${LOGIN_TTL_MS / 1000}; HttpOnly; SameSite=Lax; Secure$`,
      ),
    );
    // The verifier is in the cookie only, never in the URL GitHub sees.
    const verifier = begun.loginCookie?.split(".")[2] ?? "";
    expect(begun.authorize).not.toContain(verifier);

    const callback = oauth.approve(begun.authorize, ALICE);
    const res = await app.inject({
      method: "GET",
      url: pathOf(callback),
      headers: { cookie: `${LOGIN}=${begun.loginCookie}` },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${ORIGIN}/inbox`);
    expect(oauth.exchanges).toEqual([{ clientOk: true, verifierOk: true, outcome: "issued" }]);
    const cookies = setCookies(res);
    expect(cookies).toContain(`${LOGIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION}=`)) ?? "";
    // Secure, HttpOnly, SameSite=Lax, Path=/, no Domain; lives until the token's 8 h expiry.
    expect(sessionCookie).toMatch(
      new RegExp(
        `^${SESSION}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=28800; HttpOnly; SameSite=Lax; Secure$`,
      ),
    );
    expect(sessionCookie).not.toMatch(/Domain=/i);

    const token = cookieValue(res, SESSION);
    const me = await sessionOf(token);
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    const body = me.json() as {
      user: { forgeUserId: number };
      orgs: { id: string; memberId: string; role: string }[];
      activeOrgId: string | null;
      csrfToken: string;
      expiresAt: string;
    };
    expect(body.user.forgeUserId).toBe(ALICE.id);
    // Installation 83's org is scheduled for deletion: not offered.
    expect(body.orgs.map((o) => o.id).sort()).toEqual([A.orgId, B.orgId].sort());
    expect(body.orgs.find((o) => o.id === A.orgId)?.memberId).toBe(A.memberId);
    // Two orgs: the person chooses.
    expect(body.activeOrgId).toBeNull();
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(new Date(T0 + 8 * HOUR).toISOString());
    expect(await auditActions(A.orgId)).toEqual([
      expect.objectContaining({ action: "auth.login" }),
    ]);
    expect(changed.sort()).toEqual([`${A.orgId}:${A.memberId}`, `${B.orgId}:${B.memberId}`].sort());
  });

  it("stores the user token envelope-encrypted per org, bound to the member; only hashes of cookie and state", async () => {
    const { session, begun } = await login();
    const issued = oauth.issued.at(-1) ?? "";
    for (const org of [A, B]) {
      const stored = await db.withOrg(org.orgId, (tx) => loadForgeToken(tx, org.memberId));
      expect(stored?.ciphertext).toMatch(/^rk1:/);
      const dataKey = await db.withOrg(org.orgId, (tx) => loadOrgDataKey(tx));
      const ring = await OrgKeyring.open(keys, org.orgId, [
        decodeWrappedDataKey(dataKey?.ciphertext ?? ""),
      ]);
      try {
        expect(
          ring.decryptToString(stored?.ciphertext ?? "", {
            purpose: MEMBER_TOKEN_PURPOSE,
            recordId: org.memberId,
          }),
        ).toBe(issued);
        // Bound to the member: it does not decrypt for any other record id.
        expect(() =>
          ring.decryptToString(stored?.ciphertext ?? "", {
            purpose: MEMBER_TOKEN_PURPOSE,
            recordId: randomBytes(16)
              .toString("hex")
              .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"),
          }),
        ).toThrow();
      } finally {
        ring.destroy();
      }
      const [row] = await db.withOrg(
        org.orgId,
        async (tx) =>
          (
            await tx.query<{ expires: Date | null }>(
              "select forge_access_expires_at as expires from members where id = $1",
              [org.memberId],
            )
          ).rows,
      );
      expect(row?.expires?.toISOString()).toBe(new Date(T0 + 8 * HOUR).toISOString());
    }
    const dump = await pgs.dump();
    expect(dump).not.toContain(issued);
    expect(dump).not.toContain(session ?? "missing");
    expect(dump).not.toContain(begun.loginCookie?.split(".")[1] ?? "missing");
    expect(dump).not.toMatch(/test-refresh-token-/);
  });

  it("a user who can access one installation gets that org only, active at once; nobody else's", async () => {
    github.grantInstallation(ALICE.id, 82, false);
    const { session } = await login();
    const body = (await sessionOf(session)).json() as {
      orgs: { id: string }[];
      activeOrgId: string;
    };
    expect(body.orgs.map((o) => o.id)).toEqual([A.orgId]);
    expect(body.activeOrgId).toBe(A.orgId);
    // Mallory has access to nothing: the fixed "no org" page, no session, no member row.
    const m = await login({ user: MALLORY });
    expect(m.res.statusCode).toBe(403);
    expect(m.res.body).toContain("No Rocky organization");
    expect(m.session).toBeUndefined();
    const rows = await db.withOrg(
      A.orgId,
      async (tx) =>
        (await tx.query("select id from members where forge_user_id = $1", [MALLORY.id])).rows,
    );
    expect(rows).toEqual([]);
  });

  it("identity is the numeric GitHub id: a renamed login is the same member, a reused login is not", async () => {
    await login({ user: { id: ALICE.id, login: "alice-renamed" } });
    const renamed = await db.withOrg(
      A.orgId,
      async (tx) =>
        (await tx.query("select id, login from members where forge_user_id = $1", [ALICE.id])).rows,
    );
    expect(renamed).toEqual([{ id: A.memberId, login: "alice-renamed" }]);
    // Someone else now called "alice" (another id) gets their own member row, never Alice's.
    member({ id: 4242 }, 81);
    const other = await login({ user: { id: 4242, login: "alice" } });
    const view = (await sessionOf(other.session)).json() as { orgs: { memberId: string }[] };
    expect(view.orgs[0]?.memberId).not.toBe(A.memberId);
  });

  it("switching the active org: only to an org of the session, re-checked; CSRF-protected", async () => {
    const { session } = await login();
    const headers = await sameOrigin(session ?? "");
    expect((await post("/api/session/active-org", headers, { orgId: C.orgId })).statusCode).toBe(
      404,
    );
    expect((await post("/api/session/active-org", headers, { orgId: "nope" })).statusCode).toBe(
      400,
    );
    const ok = await post("/api/session/active-org", headers, { orgId: B.orgId });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { activeOrgId: string }).activeOrgId).toBe(B.orgId);
    const noToken = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== CSRF_HEADER));
    expect((await post("/api/session/active-org", noToken, { orgId: A.orgId })).statusCode).toBe(
      403,
    );
  });

  it("removing the member in Rocky ends that org for the session at once (no mixing up orgs)", async () => {
    const extra = { id: 7070, login: "grace" };
    member(extra, 81);
    member(extra, 82);
    const { session } = await login({ user: extra });
    const before = (await sessionOf(session)).json() as {
      orgs: { id: string; memberId: string }[];
    };
    expect(before.orgs).toHaveLength(2);
    const inA = before.orgs.find((o) => o.id === A.orgId)?.memberId ?? "";
    await db.withOrg(A.orgId, (tx) => tx.query("delete from members where id = $1", [inA]));
    const after = (await sessionOf(session)).json() as { orgs: { id: string }[] };
    expect(after.orgs.map((o) => o.id)).toEqual([B.orgId]);
    // The active org can no longer be A.
    const headers = await sameOrigin(session ?? "");
    expect((await post("/api/session/active-org", headers, { orgId: A.orgId })).statusCode).toBe(
      404,
    );
  });

  it("activeMember resolves ids from the session only, after a membership check in withOrg", async () => {
    github.grantInstallation(ALICE.id, 82, false);
    const { session } = await login();
    const request = { headers: { cookie: `${SESSION}=${session}` } } as never;
    expect(await app.sessionAuth?.activeMember(request)).toMatchObject({
      orgId: A.orgId,
      memberId: A.memberId,
      role: "admin",
    });
    expect(await app.sessionAuth?.activeMember({ headers: {} } as never)).toBeNull();
  });
});

describe("session fixation (acceptance criterion)", () => {
  it("a session id planted in the browser before login is never the session after login", async () => {
    // Mallory (a member of org B) logs in, then plants her session cookie in Alice's browser.
    member(MALLORY, 82);
    const mallory = await login({ user: MALLORY });
    const planted = mallory.session ?? "";
    const malloryMember =
      ((await sessionOf(planted)).json() as { orgs: { memberId: string }[] }).orgs[0]?.memberId ??
      "";
    expect(await db.withOrg(B.orgId, (tx) => loadForgeToken(tx, malloryMember))).not.toBeNull();
    const alice = await login({ jar: `${SESSION}=${planted}` });
    expect(alice.res.statusCode).toBe(303);
    expect(alice.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(alice.session).not.toBe(planted);
    // The planted id is revoked; nobody is logged in through it, as Alice or as Mallory.
    expect((await sessionOf(planted)).statusCode).toBe(401);
    const view = (await sessionOf(alice.session)).json() as { user: { forgeUserId: number } };
    expect(view.user.forgeUserId).toBe(ALICE.id);
    // That was Mallory's last session: her stored token went with it, as at logout.
    expect(await db.withOrg(B.orgId, (tx) => loadForgeToken(tx, malloryMember))).toBeNull();
    expect(changed).toContain(`${B.orgId}:${malloryMember}`);
  });

  it("superseding another user's session keeps their token while they have another live session", async () => {
    const judy = { id: 9090, login: "judy" };
    member(judy, 82);
    const kept = await login({ user: judy });
    const planted = await login({ user: judy });
    const judyMember =
      ((await sessionOf(kept.session)).json() as { orgs: { memberId: string }[] }).orgs[0]
        ?.memberId ?? "";
    await login({ jar: `${SESSION}=${planted.session}` });
    expect((await sessionOf(planted.session)).statusCode).toBe(401);
    expect((await sessionOf(kept.session)).statusCode).toBe(200);
    expect(await db.withOrg(B.orgId, (tx) => loadForgeToken(tx, judyMember))).not.toBeNull();
  });

  it("an attacker-chosen value that is not a session is ignored, and the new id is fresh every login", async () => {
    const chosen = "A".repeat(43);
    const first = await login({ jar: `${SESSION}=${chosen}` });
    expect(first.session).not.toBe(chosen);
    expect((await sessionOf(chosen)).statusCode).toBe(401);
    const second = await login({ jar: `${SESSION}=${first.session}` });
    expect(second.session).not.toBe(first.session);
    expect((await sessionOf(first.session)).statusCode).toBe(401);
    expect((await sessionOf(second.session)).statusCode).toBe(200);
  });

  it("re-login revokes the previous session and audits it", async () => {
    github.grantInstallation(ALICE.id, 82, false);
    const first = await login();
    const firstRecord = (await auditActions(A.orgId)).at(-1)?.target_id;
    await login({ jar: `${SESSION}=${first.session}` });
    const actions = await auditActions(A.orgId);
    expect(actions).toContainEqual({
      action: "auth.session_revoked",
      target_id: firstRecord,
      metadata: { reason: "superseded" },
    });
  });
});

describe("CSRF (acceptance criterion)", () => {
  it("a cross-site POST with the victim's cookie is refused and changes nothing", async () => {
    const { session } = await login();
    const token = session ?? "";
    const csrf = await csrfOf(token);
    const cookie = `${SESSION}=${token}`;
    const attempts: Record<string, string>[] = [
      // A form on evil.com: no custom header, foreign origin.
      { cookie, origin: "https://evil.com", "sec-fetch-site": "cross-site" },
      // Even with a guessed or stolen-elsewhere token header, a foreign origin is refused.
      { cookie, origin: "https://evil.com", [CSRF_HEADER]: csrf },
      // A sibling subdomain is another site for Rocky.
      {
        cookie,
        origin: "https://evil.rocky.example.com",
        "sec-fetch-site": "same-site",
        [CSRF_HEADER]: csrf,
      },
      { cookie, origin: ORIGIN, "sec-fetch-site": "same-site", [CSRF_HEADER]: csrf },
      { cookie, origin: "null", [CSRF_HEADER]: csrf },
      // No Origin and no Referer: fail closed.
      { cookie, [CSRF_HEADER]: csrf },
      { cookie, referer: "https://evil.com/page", [CSRF_HEADER]: csrf },
      // Same origin but no token, a wrong token, another session's token.
      { cookie, origin: ORIGIN },
      { cookie, origin: ORIGIN, [CSRF_HEADER]: "x".repeat(43) },
      {
        cookie,
        origin: ORIGIN,
        [CSRF_HEADER]: await csrfOf(
          (member(MALLORY, 82), await login({ user: MALLORY })).session ?? "",
        ),
      },
    ];
    for (const headers of attempts) {
      const res = await post("/auth/logout", headers);
      expect(res.statusCode, JSON.stringify({ ...headers, cookie: "…" })).toBe(403);
      expect(res.json()).toEqual({ error: "csrf" });
    }
    expect((await sessionOf(token)).statusCode).toBe(200);
    // Same origin with the session's token passes (Referer when Origin is absent works too).
    const ok = await post("/auth/logout", {
      cookie,
      referer: `${ORIGIN}/inbox`,
      [CSRF_HEADER]: csrf,
    });
    expect(ok.statusCode).toBe(204);
    expect((await sessionOf(token)).statusCode).toBe(401);
  });

  it("every state-changing route is guarded by default, including routes added later", async () => {
    await app.close();
    app = build();
    let reached = false;
    app.post("/api/later", async () => {
      reached = true;
      return { ok: true };
    });
    app.delete("/api/later", async () => ({ ok: true }));
    const { session } = await login();
    for (const method of ["POST", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/api/later",
        headers: { cookie: `${SESSION}=${session}`, origin: "https://evil.com" },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(reached).toBe(false);
    const ok = await app.inject({
      method: "POST",
      url: "/api/later",
      headers: await sameOrigin(session ?? ""),
    });
    expect(ok.statusCode).toBe(200);
  });

  it("without login configured, every non-exempt state-changing route is refused", async () => {
    const bare = buildApp({ checkDatabase: () => Promise.resolve(true) });
    bare.post("/api/x", async () => ({ ok: true }));
    const res = await bare.inject({ method: "POST", url: "/api/x", headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(403);
    await bare.close();
  });
});

describe("open redirect (acceptance criterion)", () => {
  it("returnTo accepts only same-origin relative paths: every hostile value lands on /", async () => {
    for (const vector of OPEN_REDIRECT_VECTORS) {
      clock += 1000;
      const { res } = await login({ returnTo: vector });
      expect(res.statusCode, JSON.stringify(vector)).toBe(303);
      expect(res.headers.location, JSON.stringify(vector)).toBe(`${ORIGIN}/`);
    }
    const { res } = await login({ returnTo: "/acme/api/pull/847?tab=files#L12" });
    expect(res.headers.location).toBe(`${ORIGIN}/acme/api/pull/847?tab=files#L12`);
  }, 60_000);

  it("a repeated or non-string returnTo is refused too, and the stored value is re-checked at use", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/github/login?returnTo=/a&returnTo=//evil.com",
    });
    expect(res.statusCode).toBe(302);
    const callback = oauth.approve(String(res.headers.location), ALICE);
    const back = await app.inject({
      method: "GET",
      url: pathOf(callback),
      headers: { cookie: `${LOGIN}=${cookieValue(res, LOGIN)}` },
    });
    expect(back.headers.location).toBe(`${ORIGIN}/`);
    // The database refuses a hostile value outright, so a stored one cannot exist (CHECK).
    await expect(
      db.sessions.createLoginAttempt({
        stateSha256: randomBytes(32),
        returnTo: "//evil.com",
        now: new Date(clock),
        ttlMs: 60_000,
      }),
    ).rejects.toThrow();
  });
});

describe("state: login CSRF and replay", () => {
  it("a callback without this browser's login cookie is refused (attacker's code in the victim's browser)", async () => {
    // Mallory starts a login and gets a callback URL for her own account...
    const mallory = await start();
    const callback = oauth.approve(mallory.authorize, MALLORY);
    // ...and makes Alice's browser (with Alice's own pending login, or none) open it.
    const alicePending = await start();
    for (const cookie of ["", `${LOGIN}=${alicePending.loginCookie}`]) {
      const res = await app.inject({
        method: "GET",
        url: pathOf(callback),
        headers: cookie === "" ? {} : { cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(cookieValue(res, SESSION)).toBeUndefined();
    }
    // GitHub was never asked to exchange the code.
    expect(oauth.exchanges).toEqual([]);
  });

  it("a state works once: replaying the callback URL is refused", async () => {
    const { callback, begun, res } = await login();
    expect(res.statusCode).toBe(303);
    const replay = await app.inject({
      method: "GET",
      url: pathOf(callback),
      headers: { cookie: `${LOGIN}=${begun.loginCookie}` },
    });
    expect(replay.statusCode).toBe(403);
    expect(cookieValue(replay, SESSION)).toBeUndefined();
  });

  it("a forged or expired login cookie is refused", async () => {
    const begun = await start();
    const callback = oauth.approve(begun.authorize, ALICE);
    const parts = (begun.loginCookie ?? "").split(".");
    const forgedVerifier = [parts[0], parts[1], "v".repeat(43), parts[3], parts[4]].join(".");
    const longer = [parts[0], parts[1], parts[2], String(Number(parts[3]) + 3600), parts[4]].join(
      ".",
    );
    for (const value of [forgedVerifier, longer, "garbage"]) {
      const res = await app.inject({
        method: "GET",
        url: pathOf(callback),
        headers: { cookie: `${LOGIN}=${value}` },
      });
      expect(res.statusCode).toBe(403);
    }
    clock += LOGIN_TTL_MS;
    const late = await app.inject({
      method: "GET",
      url: pathOf(callback),
      headers: { cookie: `${LOGIN}=${begun.loginCookie}` },
    });
    expect(late.statusCode).toBe(403);
    expect(oauth.exchanges).toEqual([]);
  });

  it("only the __Host- cookie counts: an unprefixed cookie (planted by a subdomain) is ignored", async () => {
    const begun = await start();
    const callback = oauth.approve(begun.authorize, ALICE);
    const res = await app.inject({
      method: "GET",
      url: pathOf(callback),
      headers: { cookie: `rocky_login=${begun.loginCookie}` },
    });
    expect(res.statusCode).toBe(403);
    const { session } = await login();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie: `rocky_session=${session}` },
        })
      ).statusCode,
    ).toBe(401);
    // A duplicated cookie name is ambiguous and ignored.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie: `${SESSION}=${session}; ${SESSION}=${"B".repeat(43)}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("GitHub refusing the code, cancelling, or failing: no session", async () => {
    oauth.failExchange("bad_verification_code");
    const bad = await login();
    expect(bad.res.statusCode).toBe(400);
    expect(bad.session).toBeUndefined();
    oauth.failExchange(500);
    const down = await login();
    expect(down.res.statusCode).toBe(502);
    expect(down.session).toBeUndefined();
    github.failRoute("installations", 403);
    const sso = await login();
    expect(sso.res.statusCode).toBe(502);
    const cancelled = await app.inject({
      method: "GET",
      url: "/auth/github/callback?error=access_denied&state=x",
    });
    expect(cancelled.statusCode).toBe(400);
    expect(cancelled.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("idle and absolute expiry (server-side)", () => {
  it("idle: unused for 8 hours ends the session; use keeps it alive until the absolute expiry", async () => {
    oauth = fakeGitHubOAuth({
      api: github,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      now: () => clock,
      expiresInSeconds: null, // a non-expiring token: the 24 h cap applies
    });
    await app.close();
    app = build();
    const idle = await login();
    clock = T0 + SESSION_IDLE_SECONDS * 1000 - 1000;
    expect((await sessionOf(idle.session)).statusCode).toBe(200);
    clock = T0 + 2 * SESSION_IDLE_SECONDS * 1000;
    expect((await sessionOf(idle.session)).statusCode).toBe(401);

    clock = T0;
    const busy = await login();
    for (let h = 1; h < 24; h++) {
      clock = T0 + h * HOUR;
      expect((await sessionOf(busy.session)).statusCode, `hour ${h}`).toBe(200);
    }
    clock = T0 + 24 * HOUR;
    expect((await sessionOf(busy.session)).statusCode).toBe(401);
  });

  it("reports the real idle expiry: last_seen_at + idle timeout, capped by the absolute expiry", async () => {
    oauth = fakeGitHubOAuth({
      api: github,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      now: () => clock,
      expiresInSeconds: null,
    });
    await app.close();
    app = build();
    const { session } = await login();
    const idleOf = async () =>
      ((await sessionOf(session)).json() as { idleExpiresAt: string }).idleExpiresAt;
    clock = T0 + 2 * HOUR;
    expect(await idleOf()).toBe(
      new Date(T0 + 2 * HOUR + SESSION_IDLE_SECONDS * 1000).toISOString(),
    );
    // Within the touch throttle the stored last_seen_at is unchanged, and so is the answer.
    clock = T0 + 2 * HOUR + 30_000;
    expect(await idleOf()).toBe(
      new Date(T0 + 2 * HOUR + SESSION_IDLE_SECONDS * 1000).toISOString(),
    );
    // Near the 24 h cap the absolute expiry wins.
    for (let h = 9; h <= 23; h += 7) {
      clock = T0 + h * HOUR;
      await sessionOf(session);
    }
    expect(await idleOf()).toBe(new Date(T0 + 24 * HOUR).toISOString());
  });

  it("absolute: a session never outlives the GitHub token it was created with (8 h)", async () => {
    const { session } = await login();
    clock = T0 + 4 * HOUR;
    expect((await sessionOf(session)).statusCode).toBe(200);
    clock = T0 + 8 * HOUR - 1000;
    expect((await sessionOf(session)).statusCode).toBe(200);
    clock = T0 + 8 * HOUR;
    expect((await sessionOf(session)).statusCode).toBe(401);
  });
});

describe("logout", () => {
  it("is POST-only: GET does nothing", async () => {
    const { session } = await login();
    const res = await app.inject({
      method: "GET",
      url: "/auth/logout",
      headers: { cookie: `${SESSION}=${session}` },
    });
    expect(res.statusCode).toBe(404);
    expect((await sessionOf(session)).statusCode).toBe(200);
  });

  it("revokes the session server-side, clears the cookie, audits, and drops the token with the last session", async () => {
    const heidi = { id: 8080, login: "heidi" };
    member(heidi, 81);
    const one = await login({ user: heidi });
    const two = await login({ user: heidi });
    const memberId =
      ((await sessionOf(one.session)).json() as { orgs: { memberId: string }[] }).orgs[0]
        ?.memberId ?? "";
    const stored = () => db.withOrg(A.orgId, (tx) => loadForgeToken(tx, memberId));
    changed = [];
    const first = await post("/auth/logout", await sameOrigin(one.session ?? ""));
    expect(first.statusCode).toBe(204);
    expect(setCookies(first)).toContain(
      `${SESSION}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );
    // Replaying the old cookie after logout gets nothing.
    expect((await sessionOf(one.session)).statusCode).toBe(401);
    // Another live session of the same user keeps the stored token.
    expect(await stored()).not.toBeNull();
    expect(changed).toEqual([]);
    const twoHeaders = await sameOrigin(two.session ?? "");
    const second = await post("/auth/logout", twoHeaders);
    expect(second.statusCode).toBe(204);
    expect(await stored()).toBeNull();
    expect(changed).toEqual([`${A.orgId}:${memberId}`]);
    const logouts = (await auditActions(A.orgId)).filter((a) => a.action === "auth.logout");
    expect(logouts.length).toBeGreaterThanOrEqual(2);
    // Logging out again (the session is gone) is a no-op that still clears the cookie.
    const again = await post("/auth/logout", twoHeaders);
    expect(again.statusCode).toBe(204);
  });
});

describe("cookie scope in development (documented exception)", () => {
  it("http on loopback: no __Host- prefix and no Secure, otherwise the same flags", async () => {
    await app.close();
    app = build({ cookieSecure: false, publicUrl: new URL("http://127.0.0.1:4310/") });
    const begun = await start();
    expect(setCookies(begun.res)[0]).toMatch(
      /^rocky_login=v1\.[^;]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/,
    );
  });
});

describe("logs (no codes, tokens, cookies, state values, emails or logins)", () => {
  it("carry outcomes and ids only", async () => {
    const { session, callback, begun } = await login({ returnTo: "/inbox" });
    await post("/auth/logout", { cookie: `${SESSION}=${session}`, origin: "https://evil.com" });
    await post("/auth/logout", await sameOrigin(session ?? ""));
    const text = lines.join("\n");
    expect(text).toContain('"outcome":"login"');
    expect(text).toContain('"reason":"origin"');
    for (const secret of [
      callback.searchParams.get("code") ?? "missing",
      callback.searchParams.get("state") ?? "missing",
      begun.loginCookie ?? "missing",
      ...(begun.loginCookie ?? "x.y.z").split(".").slice(1, 3),
      session ?? "missing",
      ...oauth.issued,
      CLIENT_SECRET,
      '"alice"',
      "alice",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("only real members count (review round 1)", () => {
  it("an outside collaborator who can see the installation gets no member row and no session", async () => {
    const outsider = { id: 5150, login: "outsider" };
    github.grantInstallation(outsider.id, 81); // visible to them, but not an org member
    const res = await login({ user: outsider });
    expect(res.res.statusCode).toBe(403);
    expect(res.res.body).toContain("No Rocky organization");
    expect(res.session).toBeUndefined();
    github.setOrgMembership(1_000_081, outsider.id, "pending"); // an invitation is not membership
    expect((await login({ user: outsider })).res.statusCode).toBe(403);
    const rows = await db.withOrg(
      A.orgId,
      async (tx) =>
        (await tx.query("select id from members where forge_user_id = $1", [outsider.id])).rows,
    );
    expect(rows).toEqual([]);
    // The user row is written only after a membership is confirmed (review round 2).
    const superuser = new pg.Client({ connectionString: pgs.superUrl });
    await superuser.connect();
    try {
      const users = await superuser.query("select 1 from app.users where forge_user_id = $1", [
        outsider.id,
      ]);
      expect(users.rowCount).toBe(0);
    } finally {
      await superuser.end();
    }
    expect(lines.join("\n")).toContain('"outcome":"not_a_member"');
  });

  it("an active org member is accepted", async () => {
    const newcomer = { id: 5151, login: "newcomer" };
    member(newcomer, 81);
    const { res, session } = await login({ user: newcomer });
    expect(res.statusCode).toBe(303);
    const view = (await sessionOf(session)).json() as {
      orgs: { id: string; role: string }[];
      activeOrgId: string;
    };
    expect(view.orgs).toEqual([expect.objectContaining({ id: A.orgId, role: "member" })]);
    expect(view.activeOrgId).toBe(A.orgId);
  });

  it("a failing membership check leaves that org out (fail closed); none left is the no-org page", async () => {
    github.failRoute("org_membership", 500);
    const one = await login();
    expect(one.res.statusCode).toBe(303);
    const view = (await sessionOf(one.session)).json() as { orgs: unknown[] };
    expect(view.orgs).toHaveLength(1);
    expect(lines.join("\n")).toContain('"outcome":"membership_check_failed"');
    github.failRoute("org_membership", 403, 2);
    const none = await login();
    expect(none.res.statusCode).toBe(403);
    expect(none.session).toBeUndefined();
  });

  it("a member removed in Rocky stays removed after signing in again", async () => {
    const ivan = { id: 5152, login: "ivan" };
    member(ivan, 81);
    const first = await login({ user: ivan });
    const memberId =
      ((await sessionOf(first.session)).json() as { orgs: { memberId: string }[] }).orgs[0]
        ?.memberId ?? "";
    expect(await db.withOrg(A.orgId, (tx) => markMemberRemoved(tx, memberId))).toBe(true);
    // The session loses the org at once, and signing in again does not bring the member back.
    expect(((await sessionOf(first.session)).json() as { orgs: unknown[] }).orgs).toEqual([]);
    const again = await login({ user: ivan });
    expect(again.res.statusCode).toBe(403);
    expect(again.session).toBeUndefined();
    const [row] = await db.withOrg(
      A.orgId,
      async (tx) =>
        (
          await tx.query<{ removed: Date | null; token: Buffer | null }>(
            "select removed_at as removed, forge_token_ciphertext as token from members where id = $1",
            [memberId],
          )
        ).rows,
    );
    expect(row?.removed).not.toBeNull();
    expect(row?.token).toBeNull();
    expect(lines.join("\n")).toContain('"outcome":"member_removed"');
  });

  it("on a User-account installation only the account owner counts", async () => {
    const owner = { id: 1_000_084, login: "owner-84" };
    const collaborator = { id: 5153, login: "collab" };
    github.grantInstallation(owner.id, 84);
    github.grantInstallation(collaborator.id, 84);
    const refused = await login({ user: collaborator });
    expect(refused.res.statusCode).toBe(403);
    const ok = await login({ user: owner });
    expect(ok.res.statusCode).toBe(303);
    const view = (await sessionOf(ok.session)).json() as { orgs: { id: string }[] };
    expect(view.orgs.map((o) => o.id)).toEqual([D.orgId]);
    // No org-membership call is made for a User account.
    expect(lines.join("\n")).not.toContain('"outcome":"membership_check_failed"');
  });
});

describe("token expiry required in production (review round 1)", () => {
  it("a GitHub token without an expiry is refused with a fixed page, and no session", async () => {
    oauth = fakeGitHubOAuth({
      api: github,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      now: () => clock,
      expiresInSeconds: null,
    });
    await app.close();
    app = build({ requireTokenExpiry: true });
    const { res, session } = await login();
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("Token expiry must be enabled in the GitHub App");
    expect(session).toBeUndefined();
    expect(lines.join("\n")).toContain('"outcome":"token_without_expiry"');
    // An expiring token is fine in production.
    oauth = fakeGitHubOAuth({
      api: github,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      now: () => clock,
    });
    await app.close();
    app = build({ requireTokenExpiry: true });
    expect((await login()).res.statusCode).toBe(303);
  });
});

describe("errors in the auth routes (review round 1)", () => {
  const failing = (message: string) =>
    Promise.reject(Object.assign(new Error(message), { code: "57P01" }));

  it("a database failure is a fixed 500: JSON under /api/, HTML otherwise; no message anywhere", async () => {
    const detail = "relation secret_detail_xyz does not exist";
    const broken: Db = {
      ...db,
      sessions: {
        ...db.sessions,
        findSession: () => failing(detail),
        upsertUser: () => failing(detail),
      },
    };
    await app.close();
    app = build({ db: broken });
    const api = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: `${SESSION}=${"A".repeat(43)}` },
    });
    expect(api.statusCode).toBe(500);
    expect(api.json()).toEqual({ error: "internal" });
    expect(api.headers["cache-control"]).toBe("no-store");
    const { res } = await login();
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(cookieValue(res, SESSION)).toBeUndefined();
    for (const body of [api.body, res.body]) {
      expect(body).not.toContain("secret_detail_xyz");
      expect(body).not.toContain("57P01");
    }
    const text = lines.join("\n");
    expect(text).not.toContain("secret_detail_xyz");
    expect(text).toContain('"outcome":"request_failed"');
    expect(text).toContain('"errorCode":"57P01"');
  });

  it("a failing withOrg in the callback (token storage) leaves that org out, never half a session", async () => {
    const broken: Db = { ...db, withOrg: () => failing("org secret_detail_xyz") };
    await app.close();
    app = build({ db: broken });
    const { res, session } = await login();
    expect([403, 500]).toContain(res.statusCode);
    expect(session).toBeUndefined();
    expect(res.body).not.toContain("secret_detail_xyz");
    expect(lines.join("\n")).not.toContain("secret_detail_xyz");
  });
});
