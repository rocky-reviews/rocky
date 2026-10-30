import { randomBytes } from "node:crypto";
import type { AccessDecision, RepositoryAccessRequest } from "@rocky-reviews/core";
import { generateLocalKek, LocalKeyWrapper } from "@rocky-reviews/crypto";
import { createDb, upsertLoginMember, type Db } from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  setAnalysisDocument,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import { createGitHubLogin, githubEndpoints } from "@rocky-reviews/forge-github";
import { createLogger } from "@rocky-reviews/log";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { csrfTokenFor, CSRF_HEADER, randomToken, sha256 } from "../auth/cookies.js";

/**
 * P6-4 (ADR 0027): the drafts API on a real Postgres, as the browser calls it (session cookie,
 * Origin and CSRF token). "Refresh keeps state": every transition is read back by a new app
 * instance, as a reload would. Who may call it (the route-permission matrix) is in
 * `auth/policy.db.test.ts`.
 */

const PUBLIC = new URL("https://rocky.example.com/");
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);
const PRIVATE_BODY = "Zebra-quartz-7731 my private note";

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let app: FastifyInstance;
let lines: string[] = [];
let accessAnswer: AccessDecision;
let accessAsked: RepositoryAccessRequest[] = [];
const members: Record<string, string> = {};

const build = (options: { withoutAccessCheck?: boolean } = {}) => {
  const log = createLogger("drafts-test", {
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
        clientId: "Iv23liDraftsTest01",
        clientSecret: "test-only-client-secret-drafts-0123456789",
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

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 81 }));
  await setAnalysisDocument(db, A.orgId, A.analysisId, pr847);
  for (const [name, forgeUserId] of [
    ["dana", 4001],
    ["sam", 4002],
  ] as const) {
    members[name] = await db.withOrg(A.orgId, async (tx) => {
      const row = await upsertLoginMember(tx, { forgeUserId, login: name });
      return row!.memberId;
    });
  }
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

beforeEach(async () => {
  lines = [];
  accessAsked = [];
  accessAnswer = { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
  await db.withOrg(A.orgId, async (tx) => {
    await tx.query("delete from comments_pending where analysis_id is not null");
    await tx.query("delete from findings_state where member_id <> $1", [A.memberId]);
  });
  await app?.close();
  app = build();
  await app.ready();
});

const sessionFor = async (name: "dana" | "sam"): Promise<string> => {
  const forgeUserId = name === "dana" ? 4001 : 4002;
  const now = new Date();
  const { userId } = await db.sessions.upsertUser("github", forgeUserId, now);
  const token = randomToken();
  await db.sessions.createSession({
    tokenSha256: sha256(token),
    userId,
    orgs: [{ orgId: A.orgId, memberId: members[name]! }],
    activeOrgId: A.orgId,
    now,
    idleTimeoutSeconds: 3600,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return token;
};

const call = (
  token: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  options: { csrf?: boolean; on?: FastifyInstance } = {},
) =>
  (options.on ?? app).inject({
    method,
    url,
    headers: {
      cookie: `${SESSION}=${token}`,
      origin: PUBLIC.origin,
      ...(options.csrf === false ? {} : { [CSRF_HEADER]: csrfTokenFor(SECRET, token) }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

const base = () => `/api/analyses/${A.analysisId}`;
const act = (token: string, findingId: string, body: unknown) =>
  call(token, "POST", `${base()}/drafts/${findingId}`, body);

/** A brand-new app instance on the same database: what a page reload sees. */
const reloadAs = async (token: string) => {
  const fresh = build();
  await fresh.ready();
  try {
    const res = await call(token, "GET", `${base()}/review`, undefined, { on: fresh });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      analysisId: string;
      drafts: {
        findingId: string;
        state: string;
        reason: string | null;
        edited: boolean;
        body: string | null;
        agentPromptCopiedAt: string | null;
      }[];
      comments: { id: string; path: string; line: number; body: string }[];
    };
  } finally {
    await fresh.close();
  }
};

const F1 = pr847.findings.find((f) => f.id === "F1")!;

describe("drafts API: every transition, then a reload (P6-4 acceptance criterion)", () => {
  it("starts with nothing decided", async () => {
    const dana = await sessionFor("dana");
    expect(await reloadAs(dana)).toEqual({ analysisId: A.analysisId, drafts: [], comments: [] });
  });

  it("accept → reload shows it accepted with the finding's body → undo → reload shows a draft", async () => {
    const dana = await sessionFor("dana");
    const accepted = await act(dana, "F1", { action: "accept" });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      draft: { findingId: "F1", state: "accepted", edited: false, body: F1.body },
    });
    expect((await reloadAs(dana)).drafts).toEqual([
      expect.objectContaining({ findingId: "F1", state: "accepted", body: F1.body }),
    ]);
    expect((await act(dana, "F1", { action: "undo" })).json()).toMatchObject({
      draft: { state: "draft" },
    });
    expect((await reloadAs(dana)).drafts).toEqual([]);
  });

  it("edit → reload shows the reviewer's text, marked edited", async () => {
    const dana = await sessionFor("dana");
    const res = await act(dana, "F2", { action: "edit", body: "Needs `requireOrgRole`." });
    expect(res.statusCode).toBe(200);
    expect((await reloadAs(dana)).drafts).toEqual([
      expect.objectContaining({
        findingId: "F2",
        state: "accepted",
        edited: true,
        body: "Needs `requireOrgRole`.",
      }),
    ]);
  });

  it("dismiss with a reason → reload shows it dismissed with that reason → undo", async () => {
    const dana = await sessionFor("dana");
    expect(
      (await act(dana, "F3", { action: "dismiss", reason: "handled_elsewhere" })).statusCode,
    ).toBe(200);
    expect((await reloadAs(dana)).drafts).toEqual([
      expect.objectContaining({ findingId: "F3", state: "dismissed", reason: "handled_elsewhere" }),
    ]);
    await act(dana, "F3", { action: "undo" });
    expect((await reloadAs(dana)).drafts).toEqual([]);
  });

  it("send to agent → reload shows when, the draft still undecided", async () => {
    const dana = await sessionFor("dana");
    expect((await act(dana, "F4", { action: "send_to_agent" })).statusCode).toBe(200);
    const [draft] = (await reloadAs(dana)).drafts;
    expect(draft).toMatchObject({ findingId: "F4", state: "draft" });
    expect(Date.parse(draft!.agentPromptCopiedAt!)).not.toBeNaN();
  });

  it("own comments: add → reload lists it → delete → reload has none", async () => {
    const dana = await sessionFor("dana");
    const created = await call(dana, "POST", `${base()}/comments`, {
      path: "src/api/index.ts",
      line: 21,
      body: "Mount order matters here.",
    });
    expect(created.statusCode).toBe(201);
    const { comment } = created.json() as { comment: { id: string } };
    expect((await reloadAs(dana)).comments).toEqual([
      expect.objectContaining({ id: comment.id, path: "src/api/index.ts", line: 21 }),
    ]);
    expect((await call(dana, "DELETE", `${base()}/comments/${comment.id}`)).statusCode).toBe(204);
    expect((await reloadAs(dana)).comments).toEqual([]);
  });

  it("a stale tab: a refused transition answers 409 with the current state, nothing changes", async () => {
    const dana = await sessionFor("dana");
    await act(dana, "F1", { action: "dismiss", reason: "intentional" });
    const stale = await act(dana, "F1", { action: "accept" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: "invalid_transition",
      draft: { findingId: "F1", state: "dismissed", reason: "intentional" },
    });
  });

  it("each reviewer sees only their own decisions", async () => {
    const dana = await sessionFor("dana");
    const sam = await sessionFor("sam");
    await act(dana, "F1", { action: "accept" });
    expect((await reloadAs(sam)).drafts).toEqual([]);
    const theirs = await call(dana, "POST", `${base()}/comments`, {
      path: "src/api/index.ts",
      line: 21,
      body: "x",
    });
    const id = (theirs.json() as { comment: { id: string } }).comment.id;
    expect((await call(sam, "DELETE", `${base()}/comments/${id}`)).statusCode).toBe(404);
  });
});

describe("drafts API: refusals", () => {
  it("malformed requests: 400 with a fixed code, nothing written", async () => {
    const dana = await sessionFor("dana");
    const cases: [string, unknown, string][] = [
      [`${base()}/drafts/F1`, { action: "approve" }, "invalid_action"],
      [`${base()}/drafts/F1`, { action: "dismiss", reason: "free text" }, "invalid_action"],
      [`${base()}/drafts/F1`, { action: "edit", body: "  " }, "invalid_body"],
      [`${base()}/drafts/F1`, ["accept"], "invalid_action"],
      [`${base()}/drafts/-F1`, { action: "accept" }, "invalid_finding"],
      [`${base()}/drafts/F1%20x`, { action: "accept" }, "invalid_finding"],
      [`/api/analyses/not-a-uuid/drafts/F1`, { action: "accept" }, "invalid_analysis"],
      [`${base()}/comments`, { path: "nope.ts", line: 1, body: "x" }, "invalid_location"],
      [
        `${base()}/comments`,
        { path: "src/api/index.ts", line: "21", body: "x" },
        "invalid_location",
      ],
      [`${base()}/comments`, { path: "src/api/index.ts", line: 21, body: "" }, "invalid_body"],
    ];
    for (const [url, body, error] of cases) {
      const res = await call(dana, "POST", url, body);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toEqual({ error });
    }
    expect((await reloadAs(dana)).drafts).toEqual([]);
  });

  it("a finding the analysis does not have, or an unknown analysis: 404", async () => {
    const dana = await sessionFor("dana");
    expect((await act(dana, "F99", { action: "accept" })).statusCode).toBe(404);
    const other = `/api/analyses/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/review`;
    expect((await call(dana, "GET", other)).json()).toEqual({ error: "not_found" });
  });

  it("GitHub access still applies: no read access is a 404 and nothing is written", async () => {
    const dana = await sessionFor("dana");
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    expect((await act(dana, "F1", { action: "accept" })).statusCode).toBe(404);
    expect((await call(dana, "GET", `${base()}/review`)).statusCode).toBe(404);
    expect(accessAsked).toContainEqual({
      orgId: A.orgId,
      memberId: members["dana"],
      repositoryId: 2001,
    });
    accessAnswer = { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
    expect((await reloadAs(dana)).drafts).toEqual([]);
  });

  it("without the repository access check every drafts route fails closed (503)", async () => {
    const prev = app;
    app = build({ withoutAccessCheck: true });
    try {
      const dana = await sessionFor("dana");
      expect((await call(dana, "GET", `${base()}/review`)).statusCode).toBe(503);
      expect((await act(dana, "F1", { action: "accept" })).statusCode).toBe(503);
    } finally {
      await app.close();
      app = prev;
    }
  });

  it("a state change without the CSRF token is refused before anything runs", async () => {
    const dana = await sessionFor("dana");
    const res = await call(
      dana,
      "POST",
      `${base()}/drafts/F1`,
      { action: "accept" },
      {
        csrf: false,
      },
    );
    expect(res.statusCode).toBe(403);
    expect(accessAsked).toEqual([]);
  });

  it("logs carry the action, outcome and ids, never a body or the reviewer's text", async () => {
    const dana = await sessionFor("dana");
    await act(dana, "F1", { action: "edit", body: PRIVATE_BODY });
    await call(dana, "POST", `${base()}/comments`, {
      path: "src/api/index.ts",
      line: 21,
      body: PRIVATE_BODY,
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("Zebra-quartz");
    expect(joined).not.toContain(F1.body.slice(0, 20));
    const draftLines = lines
      .map((l) => JSON.parse(l) as { drafts?: unknown })
      .filter((l) => l.drafts);
    expect(draftLines).toContainEqual(
      expect.objectContaining({
        drafts: { action: "edit", outcome: "ok", orgId: A.orgId, analysisId: A.analysisId },
      }),
    );
  });
});
