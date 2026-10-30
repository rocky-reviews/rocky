import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AccessDecision, RepositoryAccessRequest } from "@rocky-reviews/core";
import { generateLocalKek, LocalKeyWrapper } from "@rocky-reviews/crypto";
import { claimFirstOwner, createDb, upsertLoginMember, type Db } from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  markMemberRemoved,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import {
  createGitHubLogin,
  createGitHubWebhookIngress,
  githubEndpoints,
} from "@rocky-reviews/forge-github";
import { TEST_WEBHOOK_SECRET } from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadWebApp } from "../web-app.js";
import { csrfTokenFor, CSRF_HEADER, randomToken, sha256 } from "./cookies.js";
import { publicRoute, RoutePolicyError, requires, type PolicyEntry } from "./policy.js";

/**
 * P7-2 acceptance criterion (ADR 0024): the route-permission matrix. Every route the app
 * registers is enumerated from Fastify itself (the policy's `onRoute` registry, cross-checked
 * against `printRoutes`), never from a hand-written list, and called as each persona:
 *
 *   anonymous, member, admin, owner (of org A), removed (a removed member of A),
 *   crossOrg (admin of B, plain member of A, working in A: role confusion across orgs),
 *   otherOrg (owner of B, working in B, aiming at A's ids), noActiveOrg (A and B, none chosen).
 *
 * EXPECTED below is the decision written out per route; a route that is registered without a
 * row here, or a row without a route, fails the test, and so does a route without a policy (it
 * cannot even be registered).
 */

type Persona =
  "anonymous" | "member" | "admin" | "owner" | "removed" | "crossOrg" | "otherOrg" | "noActiveOrg";
const PERSONAS: readonly Persona[] = [
  "anonymous",
  "member",
  "admin",
  "owner",
  "removed",
  "crossOrg",
  "otherOrg",
  "noActiveOrg",
];

/**
 * - allow: the policy let the request through and the handler answered without a server error
 *   (a 5xx is `server_error`, which no cell expects: a crash never counts as "allowed");
 * - not_found: allowed by the policy for the caller's own org, and the handler found nothing,
 *   because the target ids belong to another org (RLS);
 * - csrf: refused by the CSRF guard before the policy (no session cookie, so no token);
 * - unauthenticated / forbidden / not_a_member / no_active_org: refused by the policy.
 */
type Outcome =
  | "allow"
  | "server_error"
  | "not_found"
  | "csrf"
  | "unauthenticated"
  | "forbidden"
  | "not_a_member"
  | "no_active_org";
type Row = Readonly<Record<Persona, Outcome>>;

const all = (outcome: Outcome): Row =>
  Object.fromEntries(PERSONAS.map((p) => [p, outcome])) as Record<Persona, Outcome>;
const PUBLIC_GET = all("allow");
/** A public state-changing route: anyone may call it, but the CSRF guard wants a session. */
const PUBLIC_POST: Row = { ...all("allow"), anonymous: "csrf" };
const SESSION_GET: Row = { ...all("allow"), anonymous: "unauthenticated" };
const SESSION_POST: Row = { ...all("allow"), anonymous: "csrf" };
/** Org routes: the caller's org comes from the session; denials by role. */
const org = (min: "admin" | "owner", method: "GET" | "other", targetsOrgA: boolean): Row => ({
  anonymous: method === "GET" ? "unauthenticated" : "csrf",
  member: "forbidden",
  admin: min === "admin" ? "allow" : "forbidden",
  owner: "allow",
  removed: "not_a_member",
  crossOrg: "forbidden",
  otherOrg: targetsOrgA ? "not_found" : "allow",
  noActiveOrg: "no_active_org",
});

const EXPECTED: Readonly<Record<string, Row>> = {
  "GET /healthz": PUBLIC_GET,
  "HEAD /healthz": PUBLIC_GET,
  // The built web app (P7-3): the shell and its files hold no tenant data; sign-in lives there.
  "GET /": PUBLIC_GET,
  "HEAD /": PUBLIC_GET,
  "GET /index.html": PUBLIC_GET,
  "HEAD /index.html": PUBLIC_GET,
  "GET /assets/index-abc123.js": PUBLIC_GET,
  "HEAD /assets/index-abc123.js": PUBLIC_GET,
  "GET /assets/index-abc123.css": PUBLIC_GET,
  "HEAD /assets/index-abc123.css": PUBLIC_GET,
  "POST /webhooks/github": all("allow"), // HMAC, CSRF-exempt
  "GET /setup/github-app": PUBLIC_GET,
  "HEAD /setup/github-app": PUBLIC_GET,
  "GET /setup/github-app/callback": PUBLIC_GET,
  "HEAD /setup/github-app/callback": PUBLIC_GET,
  "GET /auth/github/login": PUBLIC_GET,
  "HEAD /auth/github/login": PUBLIC_GET,
  "GET /auth/github/callback": PUBLIC_GET,
  "HEAD /auth/github/callback": PUBLIC_GET,
  "POST /auth/logout": PUBLIC_POST,
  "GET /api/session": SESSION_GET,
  "HEAD /api/session": SESSION_GET,
  // Choosing org A: refused (404) for a removed member of A and for someone who is not in A.
  "POST /api/session/active-org": { ...SESSION_POST, removed: "not_found", otherOrg: "not_found" },
  "GET /api/org/members": org("admin", "GET", false),
  "HEAD /api/org/members": org("admin", "GET", false),
  "PATCH /api/org/members/:memberId": org("owner", "other", true),
  "DELETE /api/org/members/:memberId": org("admin", "other", true),
  "POST /api/org/members/:memberId/restore": org("admin", "other", true),
  "POST /api/org/ownership": org("owner", "other", true),
  "POST /api/analyses/:analysisId/approve-over-limit": org("admin", "other", true),
};

const PUBLIC = new URL("https://rocky.example.com/");
const ORIGIN = PUBLIC.origin;
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);

/** A CSP-clean build of the web app, as `ROCKY_WEB_DIR` would hold it (P7-3). */
const WEB_FILES: Readonly<Record<string, string>> = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rocky</title><script type="module" crossorigin src="/assets/index-abc123.js"></script><link rel="stylesheet" crossorigin href="/assets/index-abc123.css"></head><body><div id="app"></div></body></html>',
  "assets/index-abc123.js": "console.log(1)",
  "assets/index-abc123.css": "body{margin:0}",
};
let webRoot: string;

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;
let app: FastifyInstance;
let lines: string[] = [];
let changedMembers: string[] = [];
let accessAsked: RepositoryAccessRequest[] = [];
let accessAnswer: AccessDecision = { allowed: true, cached: false, expiresAt: new Date() };

/** Member ids per persona, by org. */
const ids: Record<string, string> = {};
const FORGE = {
  owner: 3001,
  admin: 3002,
  member: 3003,
  removed: 3004,
  crossOrg: 3005,
  otherOrg: 3006,
  noActiveOrg: 3007,
  target: 3010,
} as const;

const build = (options: { withoutAccessCheck?: boolean } = {}) => {
  lines = [];
  changedMembers = [];
  const log = createLogger("policy-test", {
    level: "debug",
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  return buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    web: loadWebApp(webRoot),
    webhooks: {
      ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
      inbox: { record: () => Promise.resolve("queued") },
    },
    githubAppSetup: {
      token: randomBytes(32).toString("base64url"),
      publicUrl: new URL("http://127.0.0.1:4310"),
      webhookUrl: new URL("https://smee.io/rockyPolicyTest"),
      appName: "Rocky Reviews",
      endpoints: githubEndpoints({}),
      credentialsFile: join(tmpdir(), `rocky-policy-${randomBytes(6).toString("hex")}.env`),
      fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
    },
    auth: {
      publicUrl: PUBLIC,
      cookieSecure: true,
      secret: SECRET,
      login: createGitHubLogin({
        endpoints: githubEndpoints({}),
        clientId: "Iv23liPolicyTest01",
        clientSecret: "test-only-client-secret-policy-0123456789",
        fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
      }),
      db,
      keys: new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]),
      onMemberTokenChanged: (_orgId, memberId) => changedMembers.push(memberId),
    },
    ...(options.withoutAccessCheck === true
      ? {}
      : {
          repositoryAccess: {
            check: async (request: RepositoryAccessRequest) => {
              accessAsked.push(request);
              return accessAnswer;
            },
          },
        }),
  });
};

const member = async (o: SeededOrg, forgeUserId: number, role: "owner" | "admin" | "member") => {
  const id = await db.withOrg(o.orgId, async (tx) => {
    const row = await upsertLoginMember(tx, { forgeUserId, login: `u${forgeUserId}` });
    if (row === null) throw new Error("member");
    if (role === "owner") expect(await claimFirstOwner(tx, row.memberId)).toBe(true);
    else await tx.query("update members set role = $2 where id = $1", [row.memberId, role]);
    return row.memberId;
  });
  ids[`${o.orgId}:${forgeUserId}`] = id;
  return id;
};
const idOf = (o: SeededOrg, forgeUserId: number) => ids[`${o.orgId}:${forgeUserId}`]!;

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "rocky-policy-web-"));
  for (const [path, body] of Object.entries(WEB_FILES)) {
    mkdirSync(join(webRoot, path, ".."), { recursive: true });
    writeFileSync(join(webRoot, path), body);
  }
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 91 }),
    await seedOrg(w, newOrgId(), { installationId: 92 }),
  ]);
  await member(A, FORGE.owner, "owner");
  await member(A, FORGE.admin, "admin");
  await member(A, FORGE.member, "member");
  await member(A, FORGE.removed, "member");
  await member(A, FORGE.crossOrg, "member");
  await member(A, FORGE.noActiveOrg, "member");
  await member(A, FORGE.target, "member");
  await member(B, FORGE.otherOrg, "owner");
  await member(B, FORGE.crossOrg, "admin");
  await member(B, FORGE.noActiveOrg, "member");
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  accessAsked = [];
  accessAnswer = { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
  await app?.close();
  app = build();
  await app.ready();
});

/** A fresh live session for the persona (a request may log out or switch orgs). */
const sessionOf = async (persona: Persona): Promise<string | null> => {
  if (persona === "anonymous") return null;
  const forgeUserId = FORGE[persona];
  const links =
    persona === "otherOrg"
      ? [B]
      : persona === "crossOrg" || persona === "noActiveOrg"
        ? [A, B]
        : [A];
  const active = persona === "noActiveOrg" ? null : persona === "otherOrg" ? B.orgId : A.orgId;
  const now = new Date();
  const { userId } = await db.sessions.upsertUser("github", forgeUserId, now);
  const token = randomToken();
  await db.sessions.createSession({
    tokenSha256: sha256(token),
    userId,
    orgs: links.map((o) => ({ orgId: o.orgId, memberId: idOf(o, forgeUserId) })),
    activeOrgId: active,
    now,
    idleTimeoutSeconds: 3600,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return token;
};

/** Puts every role back (a request may promote, remove or transfer). */
const reset = async () => {
  await db.withOrg(A.orgId, async (tx) => {
    await tx.query("update members set role = 'owner' where id = $1", [idOf(A, FORGE.owner)]);
    await tx.query("update members set role = 'admin', removed_at = null where id = $1", [
      idOf(A, FORGE.admin),
    ]);
    for (const f of [FORGE.member, FORGE.crossOrg, FORGE.noActiveOrg, FORGE.target]) {
      await tx.query("update members set role = 'member', removed_at = null where id = $1", [
        idOf(A, f),
      ]);
    }
    await tx.query(
      "update members set role = 'member', removed_at = null where id = $1 and removed_at is null",
      [idOf(A, FORGE.removed)],
    );
  });
  await db.withOrg(A.orgId, (tx) => markMemberRemoved(tx, idOf(A, FORGE.removed)));
};

const requestFor = (key: string) => {
  const [method, path] = key.split(" ") as [string, string];
  const url = path.replace(":memberId", idOf(A, FORGE.target)).replace(":analysisId", A.analysisId);
  const body =
    path === "/api/org/members/:memberId" && method === "PATCH"
      ? { role: "admin" }
      : path === "/api/org/ownership"
        ? { memberId: idOf(A, FORGE.target) }
        : path === "/api/session/active-org"
          ? { orgId: A.orgId }
          : path === "/webhooks/github"
            ? { zen: "x" }
            : undefined;
  return { method, url, body };
};

const outcomeOf = (res: LightMyRequestResponse, from: number): Outcome => {
  const denial = lines
    .slice(from)
    .map((l) => JSON.parse(l) as { access?: { outcome: string; reason: Outcome } })
    .find((l) => l.access?.outcome === "denied");
  if (denial?.access !== undefined) return denial.access.reason;
  if (res.statusCode >= 500) return "server_error";
  if (res.statusCode === 403 && res.body.includes('"error":"csrf"')) return "csrf";
  if (res.statusCode === 404 && res.body.includes('"error":"not_found"')) return "not_found";
  return "allow";
};

const call = async (key: string, persona: Persona) => {
  const token = await sessionOf(persona);
  const { method, url, body } = requestFor(key);
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers["cookie"] = `${SESSION}=${token}`;
    headers["origin"] = ORIGIN;
    headers[CSRF_HEADER] = csrfTokenFor(SECRET, token);
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const from = lines.length;
  const res = await app.inject({
    method: method as "GET",
    url,
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { res, outcome: outcomeOf(res, from) };
};

const keyOf = (e: PolicyEntry) => `${e.method} ${e.url}`;

/** Fastify's own view: how many (method, path) pairs `printRoutes` lists. */
const printedRouteCount = (instance: FastifyInstance): number =>
  [...instance.printRoutes({ commonPrefix: false }).matchAll(/\(([A-Z, ]+)\)/g)]
    .map((m) => m[1]!.split(",").filter((s) => s.trim() !== "").length)
    .reduce((a, b) => a + b, 0);

describe("route-permission matrix (P7-2 acceptance criterion)", () => {
  it("enumerates every registered route, and every route has a row in the matrix", () => {
    const registered = app.routePolicies();
    expect(registered.length).toBeGreaterThan(10);
    // Cross-check the registry against Fastify's own route table.
    expect(registered.length).toBe(printedRouteCount(app));
    for (const e of registered) {
      expect(app.hasRoute({ method: e.method as "GET", url: e.url }), keyOf(e)).toBe(true);
    }
    expect(registered.map(keyOf).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  it("declares the expected kind of policy per route (public, session or a permission)", () => {
    const kinds = Object.fromEntries(
      app
        .routePolicies()
        .map((e) => [
          keyOf(e),
          e.policy.kind === "permission" ? e.policy.permission : e.policy.kind,
        ]),
    );
    expect(kinds).toMatchObject({
      "GET /": "public",
      "GET /assets/index-abc123.js": "public",
      "GET /api/session": "session",
      "GET /api/org/members": "members.read",
      "PATCH /api/org/members/:memberId": "roles.manage",
      "DELETE /api/org/members/:memberId": "members.manage",
      "POST /api/org/members/:memberId/restore": "members.manage",
      "POST /api/org/ownership": "ownership.transfer",
      "POST /api/analyses/:analysisId/approve-over-limit": "analysis.approve_over_limit",
      "POST /webhooks/github": "public",
    });
  });

  for (const [key, row] of Object.entries(EXPECTED)) {
    it(`${key}: ${PERSONAS.map((p) => `${p}=${row[p]}`).join(" ")}`, async () => {
      for (const persona of PERSONAS) {
        await reset();
        const { res, outcome } = await call(key, persona);
        expect(outcome, `${key} as ${persona} (status ${res.statusCode})`).toBe(row[persona]);
        const expectedStatus: Partial<Record<Outcome, number>> = {
          unauthenticated: 401,
          forbidden: 403,
          not_a_member: 403,
          no_active_org: 409,
          csrf: 403,
          not_found: 404,
        };
        const status = expectedStatus[outcome];
        if (status !== undefined) expect(res.statusCode, `${key} as ${persona}`).toBe(status);
        if (outcome === "allow") expect(res.statusCode, `${key} as ${persona}`).toBeLessThan(500);
        // Every cell, denials included, carries the security headers (P7-3): the policy answers
        // from a hook, before any handler, and the header hook still runs.
        expect(res.headers["content-security-policy"], `${key} as ${persona}`).toMatch(
          /frame-ancestors 'none'/,
        );
        expect(res.headers["x-frame-options"], `${key} as ${persona}`).toBe("DENY");
        expect(res.headers["x-content-type-options"], `${key} as ${persona}`).toBe("nosniff");
        if (outcome !== "allow") {
          expect(res.headers["cache-control"], `${key} as ${persona}`).toBe("no-store");
        }
      }
    }, 60_000);
  }
});

describe("a route cannot skip the policy", () => {
  it("a route without a policy fails to register, at the root and inside a plugin", async () => {
    const bare = build();
    expect(() => bare.get("/api/forgot", async () => ({ ok: true }))).toThrow(RoutePolicyError);
    void bare.register(async (scope) => {
      scope.post("/api/forgot-too", async () => ({ ok: true }));
    });
    await expect(bare.ready()).rejects.toBeInstanceOf(RoutePolicyError);
    await bare.close().catch(() => undefined);
  });

  it("a malformed policy (unknown permission, empty reason, a bare string) fails to register", async () => {
    const bare = build();
    for (const policy of [
      { kind: "permission", permission: "everything" },
      { kind: "public", reason: "" },
      "public",
      { kind: "admin" },
    ]) {
      expect(() =>
        bare.get(
          `/api/bad-${Math.random().toString(36).slice(2)}`,
          { config: { policy: policy as never } },
          async () => ({}),
        ),
      ).toThrow(RoutePolicyError);
    }
    await bare.close();
  });

  it("a route added later with a permission is enforced like the others", async () => {
    const later = build();
    let reached = 0;
    later.get("/api/later", { config: { policy: requires("billing.manage") } }, async () => {
      reached++;
      return { ok: true };
    });
    later.get("/api/open", { config: { policy: publicRoute("test") } }, async () => ({ ok: true }));
    await later.ready();
    const prev = app;
    app = later;
    try {
      await reset();
      for (const persona of ["admin", "member"] as const) {
        expect((await call("GET /api/later", persona)).res.statusCode).toBe(403);
      }
      expect((await call("GET /api/later", "owner")).res.statusCode).toBe(200);
      expect(reached).toBe(1);
    } finally {
      app = prev;
      await later.close();
    }
  });

  it("the matrix never counts a server error as allowed (a 5xx is its own outcome)", async () => {
    const crashing = build();
    crashing.get("/api/crash", { config: { policy: requires("members.read") } }, async () => {
      throw new Error("boom");
    });
    await crashing.ready();
    const prev = app;
    app = crashing;
    try {
      await reset();
      const { res, outcome } = await call("GET /api/crash", "owner");
      expect(res.statusCode).toBe(500);
      expect(outcome).toBe("server_error");
      // A policy denial is still reported as the denial, not as an error.
      expect((await call("GET /api/crash", "member")).outcome).toBe("forbidden");
    } finally {
      app = prev;
      await crashing.close();
    }
  });
});

describe("roles in practice (threat model R1–R9)", () => {
  const patch = async (persona: Persona, target: string, role: unknown) => {
    const token = (await sessionOf(persona))!;
    return app.inject({
      method: "PATCH",
      url: `/api/org/members/${target}`,
      headers: {
        cookie: `${SESSION}=${token}`,
        origin: ORIGIN,
        [CSRF_HEADER]: csrfTokenFor(SECRET, token),
        "content-type": "application/json",
      },
      payload: JSON.stringify({ role }),
    });
  };
  const send = async (
    token: string,
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: `${SESSION}=${token}`,
        origin: ORIGIN,
        [CSRF_HEADER]: csrfTokenFor(SECRET, token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  beforeEach(reset);

  it("R1: a member cannot promote themselves, an admin cannot promote anyone (owner only)", async () => {
    expect((await patch("member", idOf(A, FORGE.member), "admin")).statusCode).toBe(403);
    expect((await patch("admin", idOf(A, FORGE.admin), "owner")).statusCode).toBe(403);
    expect((await patch("admin", idOf(A, FORGE.target), "admin")).statusCode).toBe(403);
    const roles = await db.withOrg(A.orgId, (tx) =>
      tx.query<{ role: string }>(
        "select role from members where id = any($1::uuid[]) order by role",
        [[idOf(A, FORGE.member), idOf(A, FORGE.admin), idOf(A, FORGE.target)]],
      ),
    );
    expect(roles.rows.map((r) => r.role)).toEqual(["admin", "member", "member"]);
  });

  it("R2: nobody makes an owner by role change; the last owner cannot demote themselves", async () => {
    expect((await patch("owner", idOf(A, FORGE.target), "owner")).json()).toEqual({
      error: "invalid_role",
    });
    const self = await patch("owner", idOf(A, FORGE.owner), "admin");
    expect(self.statusCode).toBe(409);
    expect(self.json()).toEqual({ error: "target_is_owner" });
    // Nor can an admin remove the owner.
    const token = (await sessionOf("admin"))!;
    const removed = await send(token, "DELETE", `/api/org/members/${idOf(A, FORGE.owner)}`);
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toEqual({ error: "target_is_owner" });
  });

  it("R3: an owner promotes and demotes admins; it is audited and applies to the target's very next request (no stale role)", async () => {
    const targetToken = (await sessionOf("member"))!;
    expect((await send(targetToken, "GET", "/api/org/members")).statusCode).toBe(403);
    expect((await patch("owner", idOf(A, FORGE.member), "admin")).json()).toEqual({
      memberId: idOf(A, FORGE.member),
      role: "admin",
    });
    // The same session, no re-login: the role is read from the member row on every request.
    expect((await send(targetToken, "GET", "/api/org/members")).statusCode).toBe(200);
    await patch("owner", idOf(A, FORGE.member), "member");
    expect((await send(targetToken, "GET", "/api/org/members")).statusCode).toBe(403);
    const audit = await superuser.query(
      "select actor_id, target_id, metadata from audit_events where org_id = $1 and action = 'member.role_changed' order by id desc limit 2",
      [A.orgId],
    );
    expect(audit.rows.map((r) => (r.metadata as { to: string }).to)).toEqual(["member", "admin"]);
    expect(audit.rows[0].actor_id).toBe(idOf(A, FORGE.owner));
    expect(changedMembers).toContain(idOf(A, FORGE.member));
  });

  it("R4: removing a member ends their access at once (the same session is 403), re-adding brings back a plain member", async () => {
    const targetToken = (await sessionOf("member"))!;
    expect((await send(targetToken, "GET", "/api/session")).statusCode).toBe(200);
    const admin = (await sessionOf("admin"))!;
    expect(
      (await send(admin, "DELETE", `/api/org/members/${idOf(A, FORGE.member)}`)).statusCode,
    ).toBe(204);
    // The org is cut from the target's session: no active org any more.
    const after = await send(targetToken, "POST", "/api/session/active-org", { orgId: A.orgId });
    expect(after.statusCode).toBe(404);
    expect(changedMembers).toContain(idOf(A, FORGE.member));
    const restored = await send(admin, "POST", `/api/org/members/${idOf(A, FORGE.member)}/restore`);
    expect(restored.json()).toEqual({ memberId: idOf(A, FORGE.member), role: "member" });
    const actions = await superuser.query(
      "select action from audit_events where org_id = $1 and target_id = $2 order by id",
      [A.orgId, idOf(A, FORGE.member)],
    );
    expect(actions.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["member.removed", "member.restored"]),
    );
  });

  it("R5: ownership transfer makes the target the owner and the old owner an admin, audited", async () => {
    const owner = (await sessionOf("owner"))!;
    const res = await send(owner, "POST", "/api/org/ownership", {
      memberId: idOf(A, FORGE.target),
    });
    expect(res.json()).toEqual({ ownerMemberId: idOf(A, FORGE.target) });
    // The old owner's same session can no longer transfer (it is an admin now).
    const again = await send(owner, "POST", "/api/org/ownership", {
      memberId: idOf(A, FORGE.owner),
    });
    expect(again.statusCode).toBe(403);
    const audit = await superuser.query(
      "select 1 from audit_events where org_id = $1 and action = 'org.ownership_transferred'",
      [A.orgId],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("R6: cross-org: an owner of B cannot reach A's members or analyses; an admin of B is a member in A", async () => {
    const other = (await sessionOf("otherOrg"))!;
    const list = (await send(other, "GET", "/api/org/members")).json() as {
      members: { memberId: string }[];
    };
    expect(list.members.map((m) => m.memberId)).not.toContain(idOf(A, FORGE.owner));
    expect(list.members.map((m) => m.memberId)).toContain(idOf(B, FORGE.otherOrg));
    expect(
      (await send(other, "DELETE", `/api/org/members/${idOf(A, FORGE.target)}`)).statusCode,
    ).toBe(404);
    const cross = (await sessionOf("crossOrg"))!;
    expect((await send(cross, "GET", "/api/org/members")).statusCode).toBe(403);
    const state = await db.withOrg(A.orgId, (tx) =>
      tx.query("select removed_at from members where id = $1", [idOf(A, FORGE.target)]),
    );
    expect(state.rows[0]?.removed_at).toBeNull();
  });

  it("R7: ids in the path are validated; a body cannot choose the actor or the org", async () => {
    const owner = (await sessionOf("owner"))!;
    expect((await send(owner, "DELETE", "/api/org/members/not-a-uuid")).json()).toEqual({
      error: "invalid_member",
    });
    expect(
      (
        await send(owner, "POST", "/api/org/ownership", {
          memberId: "x' or 1=1 --",
        })
      ).json(),
    ).toEqual({ error: "invalid_member" });
    // orgId / actor fields in a body are ignored: the session decides.
    const res = await send(owner, "POST", `/api/org/members/${idOf(B, FORGE.otherOrg)}/restore`, {
      orgId: B.orgId,
      actorMemberId: idOf(B, FORGE.otherOrg),
    });
    expect(res.statusCode).toBe(404);
  });

  it("R8: approving an analysis over the limit is admin-only and still needs GitHub read access", async () => {
    const admin = (await sessionOf("admin"))!;
    const url = `/api/analyses/${A.analysisId}/approve-over-limit`;
    // The seeded analysis is done, so a permitted approval finds nothing waiting.
    expect((await send(admin, "POST", url)).json()).toEqual({ error: "not_waiting" });
    expect(accessAsked).toEqual([
      { orgId: A.orgId, memberId: idOf(A, FORGE.admin), repositoryId: 2001 },
    ]);
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    expect((await send(admin, "POST", url)).json()).toEqual({ error: "not_found" });
    const member = (await sessionOf("member"))!;
    accessAsked = [];
    expect((await send(member, "POST", url)).statusCode).toBe(403);
    expect(accessAsked).toEqual([]);
  });

  it("R8b: without the repository access check the approval route fails closed (503)", async () => {
    const prev = app;
    app = build({ withoutAccessCheck: true });
    try {
      const admin = (await sessionOf("admin"))!;
      const res = await send(admin, "POST", `/api/analyses/${A.analysisId}/approve-over-limit`);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "access_check_unavailable" });
    } finally {
      await app.close();
      app = prev;
    }
  });

  it("R9: denials are logged with a reason and a permission only: no cookie, token or login", async () => {
    await call("GET /api/org/members", "member");
    const denied = lines.filter((l) => l.includes('"access denied"'));
    expect(denied.length).toBeGreaterThan(0);
    for (const line of denied) {
      expect(line).not.toMatch(/rocky_session|x-rocky-csrf|u3003/);
      expect(JSON.parse(line).access).toEqual({
        outcome: "denied",
        reason: "forbidden",
        permission: "members.read",
      });
    }
  });
});
