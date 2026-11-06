import { randomBytes } from "node:crypto";
import {
  MemoryListResponse,
  parseMemoryContext,
  type AccessDecision,
  type RepositoryAccessRequest,
} from "@rocky-reviews/core";
import { generateLocalKek, LocalKeyWrapper } from "@rocky-reviews/crypto";
import {
  createDb,
  createMemoryEntry,
  removeMember,
  upsertLoginMember,
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
import { createLogger } from "@rocky-reviews/log";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { CSRF_HEADER, csrfTokenFor, randomToken, sha256 } from "../auth/cookies.js";
import { MEMORY_EXPORT_DISPOSITION } from "./routes.js";

/**
 * P8-3 (ADR 0038): the memory page's API on a real Postgres, as the browser calls it (session
 * cookie, CSRF token on changes). Members read and export; admins edit, delete and switch; the
 * P3-6 check, RLS and "an entry of another repository is not found"; the export is a download
 * that round-trips; logs carry no entry text, path or login. Who may call each route (the
 * route-permission matrix) is in `auth/policy.db.test.ts`.
 */

const PUBLIC = new URL("https://rocky.example.com/");
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);
const SHA = "f".repeat(40);
const SECRET_TEXT = "Dismissed as intentional: the nightly swallow pattern";

let pgs: TestPostgres;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;
let app: FastifyInstance;
let lines: string[] = [];
let accessAnswer: AccessDecision;
let accessAsked: RepositoryAccessRequest[] = [];
let admin: string;
let member: string;
let adminB: string;
let otherRepo: string;

const build = (options: { withoutAccessCheck?: boolean } = {}) => {
  const log = createLogger("memory-routes-test", {
    level: "debug",
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  return buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    auth: {
      publicUrl: PUBLIC,
      cookieSecure: true,
      secret: SECRET,
      login: createGitHubLogin({
        endpoints: githubEndpoints({}),
        clientId: "Iv23liMemoryTest0001",
        clientSecret: "test-only-client-secret-memory-0123456",
        fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
      }),
      db,
      keys: new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]),
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

const sessionIn = async (
  org: SeededOrg,
  forgeUserId: number,
  login: string,
  role: "member" | "admin",
) => {
  const memberId = await db.withOrg(org.orgId, async (tx) => {
    const row = await upsertLoginMember(tx, { forgeUserId, login });
    await tx.query("update members set role = $2 where id = $1", [row!.memberId, role]);
    return row!.memberId;
  });
  const now = new Date();
  const { userId } = await db.sessions.upsertUser("github", forgeUserId, now);
  const token = randomToken();
  await db.sessions.createSession({
    tokenSha256: sha256(token),
    userId,
    orgs: [{ orgId: org.orgId, memberId }],
    activeOrgId: org.orgId,
    now,
    idleTimeoutSeconds: 3600,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return token;
};

const send = (token: string | null, method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    headers: {
      ...(token === null
        ? {}
        : {
            cookie: `${SESSION}=${token}`,
            origin: PUBLIC.origin,
            [CSRF_HEADER]: csrfTokenFor(SECRET, token),
          }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

const base = (org: SeededOrg) => `/api/repos/org-${org === A ? 191 : 192}/api/memory`;

const entry = async (
  org: SeededOrg,
  patch: Record<string, unknown> = {},
  repoId = org.repoId,
): Promise<string> => {
  const result = await db.withOrg(org.orgId, (tx) =>
    createMemoryEntry(tx, {
      authorMemberId: org.memberId,
      repoId,
      origin: "learned",
      entry: {
        kind: "dismissal",
        reason: "intentional",
        text: SECRET_TEXT,
        evidence: {
          path: "src/jobs/nightly_bill.ts",
          sha: SHA,
          range: { start: 3, end: 7 },
          pullRequestNumber: 847,
        },
        confidence: 80,
        ...patch,
      },
    }),
  );
  if (result.outcome !== "created") throw new Error(result.outcome);
  return result.entry.id;
};

const list = async (token: string) => {
  const res = await send(token, "GET", base(A));
  expect(res.statusCode, res.body).toBe(200);
  // The web app's own contract.
  return MemoryListResponse.parse(res.json());
};

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 191 }),
    await seedOrg(w, newOrgId(), { installationId: 192 }),
  ]);
  admin = await sessionIn(A, 9101, "ana-admin", "admin");
  member = await sessionIn(A, 9102, "mo-member", "member");
  adminB = await sessionIn(B, 9103, "bea-admin", "admin");
  otherRepo = await db.withOrg(A.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into repos (forge_repo_id, full_name) values (2999, 'org-191/secret') returning id",
    );
    return rows[0]!.id;
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pgs?.stop();
});

beforeEach(async () => {
  lines = [];
  accessAsked = [];
  accessAnswer = { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
  await app?.close();
  app = build();
  await app.ready();
});

describe("GET /api/repos/:owner/:repo/memory", () => {
  it("lists the repository's entries with evidence, author and state for any member who may read it", async () => {
    const id = await entry(A);
    const view = await list(member);
    expect(view.repository).toEqual({ owner: "org-191", name: "api", memoryEnabled: true });
    expect(view.canEdit).toBe(false);
    expect(view.truncated).toBe(false);
    expect(view.entries.find((e) => e.id === id)).toEqual({
      id,
      kind: "dismissal",
      origin: "learned",
      text: SECRET_TEXT,
      reason: "intentional",
      severity: null,
      evidence: {
        path: "src/jobs/nightly_bill.ts",
        sha: SHA,
        range: { start: 3, end: 7 },
        pullRequestNumber: 847,
      },
      confidence: 80,
      author: { kind: "member", login: "alice" },
      createdAt: expect.any(String),
      lastUsedAt: null,
      supersededBy: null,
      disabledAt: null,
    });
    expect((await list(admin)).canEdit).toBe(true);
    expect(accessAsked.at(-1)).toMatchObject({ orgId: A.orgId, repositoryId: 2001 });
  });

  it("shows a removed author as a former member", async () => {
    const leaver = await db.withOrg(A.orgId, async (tx) => {
      const row = await upsertLoginMember(tx, { forgeUserId: 9150, login: "leaving-lee" });
      await tx.query("update members set role = 'admin' where id = $1", [row!.memberId]);
      return row!.memberId;
    });
    const result = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, {
        authorMemberId: leaver,
        repoId: A.repoId,
        origin: "member",
        entry: {
          kind: "decision",
          text: "Keep the v1 endpoint until Q2.",
          evidence: {
            path: "src/v1.ts",
            sha: SHA,
            range: { start: 1, end: 1 },
            pullRequestNumber: 9,
          },
          confidence: 100,
        },
      }),
    );
    if (result.outcome !== "created") throw new Error(result.outcome);
    await db.withOrg(A.orgId, (tx) =>
      removeMember(tx, { actorMemberId: A.memberId, targetMemberId: leaver }),
    );
    const shown = (await list(member)).entries.find((e) => e.id === result.entry.id);
    expect(shown?.author).toEqual({ kind: "former_member" });
    const res = await send(member, "GET", base(A));
    expect(res.body).not.toContain("leaving-lee");
  });

  it("answers 404 for a repository GitHub does not let the caller read, an unknown one and another org's", async () => {
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    expect((await send(member, "GET", base(A))).statusCode).toBe(404);
    accessAnswer = { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
    expect((await send(member, "GET", "/api/repos/org-191/nope/memory")).statusCode).toBe(404);
    // Org B's admin names org A's repository: it does not exist for them (RLS).
    expect((await send(adminB, "GET", base(A))).statusCode).toBe(404);
    expect((await send(member, "GET", "/api/repos/-org/api/memory")).statusCode).toBe(400);
  });

  it("answers 503 without the repository access check", async () => {
    await app.close();
    app = build({ withoutAccessCheck: true });
    await app.ready();
    expect((await send(member, "GET", base(A))).statusCode).toBe(503);
  });
});

describe("GET /api/repos/:owner/:repo/memory/export", () => {
  it("is a context.md download that reads back to the repository's current entries, with no author", async () => {
    const tricky = await entry(A, {
      kind: "convention",
      reason: undefined,
      text: "# Not a heading <b>x</b> | `code` [link] - 1. item",
    });
    const res = await send(member, "GET", `${base(A)}/export`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="context.md"');
    expect(res.headers["content-disposition"]).toBe(MEMORY_EXPORT_DISPOSITION);
    expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");

    const parsed = parseMemoryContext(res.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.repository).toBe("org-191/api");
    const current = (await list(member)).entries.filter((e) => e.supersededBy === null);
    expect(parsed.entries).toHaveLength(current.length);
    expect(
      parsed.entries.find((e) => e.text === "# Not a heading <b>x</b> | `code` [link] - 1. item"),
    ).toMatchObject({ kind: "convention", origin: "learned", disabled: false });
    expect(current.some((e) => e.id === tricky)).toBe(true);
    // No login, member id or entry id goes into a file meant for git.
    for (const word of ["alice", "ana-admin", A.memberId, tricky])
      expect(res.body).not.toContain(word);
  });
});

describe("changing memory (memory.edit)", () => {
  it("an admin edits an entry: a new member entry replaces it, history kept", async () => {
    const id = await entry(A);
    const res = await send(admin, "POST", `${base(A)}/entries/${id}/edit`, {
      kind: "dismissal",
      reason: "not_an_issue",
      text: "Swallowed errors in nightly jobs are retried.",
    });
    expect(res.statusCode, res.body).toBe(200);
    const edited = (res.json() as { entry: { id: string; origin: string; author: unknown } }).entry;
    expect(edited).toMatchObject({
      origin: "member",
      author: { kind: "member", login: "ana-admin" },
    });
    const all = (await list(member)).entries;
    expect(all.find((e) => e.id === id)?.supersededBy).toBe(edited.id);
    // Editing the old version again is a conflict.
    expect(
      (
        await send(admin, "POST", `${base(A)}/entries/${id}/edit`, {
          kind: "convention",
          text: "x",
        })
      ).statusCode,
    ).toBe(409);
  });

  it("an admin switches an entry off and on, and the repository's memory off and on", async () => {
    const id = await entry(A);
    const off = await send(admin, "PUT", `${base(A)}/entries/${id}/disabled`, { disabled: true });
    expect(off.statusCode, off.body).toBe(200);
    expect(
      (off.json() as { entry: { disabledAt: string | null } }).entry.disabledAt,
    ).not.toBeNull();
    const on = await send(admin, "PUT", `${base(A)}/entries/${id}/disabled`, { disabled: false });
    expect((on.json() as { entry: { disabledAt: string | null } }).entry.disabledAt).toBeNull();

    const repoOff = await send(admin, "PUT", `${base(A)}/enabled`, { enabled: false });
    expect(repoOff.statusCode).toBe(200);
    expect((await list(member)).repository.memoryEnabled).toBe(false);
    await send(admin, "PUT", `${base(A)}/enabled`, { enabled: true });
    expect((await list(member)).repository.memoryEnabled).toBe(true);
  });

  it("an admin deletes an entry with its older versions", async () => {
    const id = await entry(A);
    const edited = await send(admin, "POST", `${base(A)}/entries/${id}/edit`, {
      kind: "convention",
      text: "Log swallowed errors.",
    });
    const newId = (edited.json() as { entry: { id: string } }).entry.id;
    const res = await send(admin, "DELETE", `${base(A)}/entries/${newId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    const ids = (await list(member)).entries.map((e) => e.id);
    expect(ids).not.toContain(id);
    expect(ids).not.toContain(newId);
  });

  it("a member cannot change memory; the server refuses before anything happens", async () => {
    const id = await entry(A);
    for (const [method, url, body] of [
      ["POST", `${base(A)}/entries/${id}/edit`, { kind: "convention", text: "x" }],
      ["PUT", `${base(A)}/entries/${id}/disabled`, { disabled: true }],
      ["DELETE", `${base(A)}/entries/${id}`, undefined],
      ["PUT", `${base(A)}/enabled`, { enabled: false }],
    ] as const) {
      const res = await send(member, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
    }
    const view = (await list(member)).entries.find((e) => e.id === id);
    expect(view).toMatchObject({ supersededBy: null, disabledAt: null });
  });

  it("an entry of another repository is not found through this repository's path, even in the same org", async () => {
    const hidden = await entry(A, {}, otherRepo);
    for (const [method, url, body] of [
      ["POST", `${base(A)}/entries/${hidden}/edit`, { kind: "convention", text: "x" }],
      ["PUT", `${base(A)}/entries/${hidden}/disabled`, { disabled: true }],
      ["DELETE", `${base(A)}/entries/${hidden}`, undefined],
    ] as const) {
      expect((await send(admin, method, url, body)).statusCode, `${method} ${url}`).toBe(404);
    }
    // Org B's admin cannot reach org A's entry through their own repository either.
    expect((await send(adminB, "DELETE", `${base(B)}/entries/${hidden}`)).statusCode).toBe(404);
  });

  it("refuses malformed requests", async () => {
    const id = await entry(A);
    for (const [method, url, body, status] of [
      ["POST", `${base(A)}/entries/${id}/edit`, { kind: "dismissal", text: "no reason" }, 400],
      [
        "POST",
        `${base(A)}/entries/${id}/edit`,
        { kind: "convention", text: "x", origin: "member" },
        400,
      ],
      ["POST", `${base(A)}/entries/not-a-uuid/edit`, { kind: "convention", text: "x" }, 400],
      ["PUT", `${base(A)}/entries/${id}/disabled`, { disabled: "yes" }, 400],
      ["PUT", `${base(A)}/enabled`, {}, 400],
      // Text the store refuses (a control character) is a 400 with a fixed problem code.
      ["POST", `${base(A)}/entries/${id}/edit`, { kind: "convention", text: "a\u0007b" }, 400],
    ] as const) {
      expect((await send(admin, method, url, body)).statusCode, JSON.stringify(body)).toBe(status);
    }
  });

  it("logs ids, outcomes and counts, never entry text, paths or logins", async () => {
    const id = await entry(A);
    await send(admin, "POST", `${base(A)}/entries/${id}/edit`, {
      kind: "convention",
      text: "A brand new convention text",
    });
    await send(member, "GET", `${base(A)}/export`);
    await send(member, "GET", base(A));
    const log = lines.join("\n");
    expect(log).toContain('"memory"');
    for (const word of [
      SECRET_TEXT,
      "brand new convention",
      "nightly_bill",
      "alice",
      "ana-admin",
    ]) {
      expect(log).not.toContain(word);
    }
  });
});
