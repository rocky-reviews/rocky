import { randomBytes } from "node:crypto";
import {
  type AccessDecision,
  type ForgePullRequest,
  InboxResponse,
  type PullRequestApprover,
  type RepositoryAccessRequest,
} from "@rocky-reviews/core";
import { generateLocalKek, LocalKeyWrapper } from "@rocky-reviews/crypto";
import {
  createDb,
  recordRevision,
  upsertLoginMember,
  upsertPullRequest,
  upsertRepository,
  type Db,
  type TenantTx,
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
import tinyJson from "@rocky-reviews/schema/fixtures/tiny.json" with { type: "json" };
import pr847Json from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { csrfTokenFor, CSRF_HEADER, randomToken, sha256 } from "../auth/cookies.js";
import { APPROVALS_PATH, INBOX_PATH } from "./routes.js";

/**
 * P6-7 (ADR 0029): the inbox API. Lists only pull requests of repositories the member can read
 * on GitHub (the P3-6 check, asked once per repository), sorted by risk, and approves a batch
 * only on a CSRF-checked request from the signed-in member, after re-checking every pull request
 * against the stored rows: still open, still at the commit the person saw, still offered. A batch
 * with any pull request that fails a check approves nothing.
 */

const PUBLIC = new URL("https://rocky.example.com/");
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);
const VIEWER = { forgeUserId: 5001, login: "sam-r" };

const sha = (c: string) => c.repeat(40);
const REPOS = { web: 1101, api: 1102, hidden: 1103 } as const;

let pgs: TestPostgres;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;
let memberId: string;
let app: FastifyInstance;
let lines: string[] = [];
let accessAsked: RepositoryAccessRequest[] = [];
let approvals: Parameters<PullRequestApprover["approve"]>[0][] = [];
let approveAnswer: (pullRequestId: string) => Promise<"approved" | "failed"> = async () =>
  "approved";
/** Pull request ids by name. */
const prs: Record<string, string> = {};

/** tiny.json (a low-risk README fix) re-addressed to a PR. */
const lowDocument = (repo: string, number: number, head: string) => {
  const doc = structuredClone(tinyJson) as typeof tinyJson & Record<string, unknown>;
  doc.provenance.repo = { owner: "acme", name: repo };
  doc.provenance.pullRequest = { number };
  doc.provenance.head = { sha: head, ref: "fix/typo" };
  return doc;
};
const criticalDocument = (head: string) => {
  const doc = structuredClone(pr847Json);
  doc.provenance.repo = { owner: "acme", name: "api" };
  doc.provenance.pullRequest = { number: 847 };
  doc.provenance.head = { ...doc.provenance.head, sha: head };
  return doc;
};

const forgePr = (
  repositoryId: number,
  number: number,
  overrides: Partial<ForgePullRequest> = {},
): ForgePullRequest => ({
  ref: { installationId: 1, repositoryId, number },
  title: `Secret title ${number}`,
  authorLogin: "dana-k",
  state: "open",
  headSha: sha("a"),
  baseSha: sha("b"),
  openedAt: new Date("2026-10-20T09:00:00Z"),
  closedAt: null,
  updatedAt: new Date(Date.UTC(2026, 9, 25, 10, number % 60)),
  changedFiles: 1,
  additions: 1,
  deletions: 1,
  ...overrides,
});

const addPr = async (
  tx: TenantTx,
  repo: { id: string; forgeId: number; name: string },
  number: number,
  options: { document?: unknown; overrides?: Partial<ForgePullRequest> } = {},
): Promise<string> => {
  const pr = forgePr(repo.forgeId, number, options.overrides);
  const { id } = await upsertPullRequest(tx, repo.id, pr);
  await recordRevision(tx, id, pr, { bytes: 10, sha256: "0".repeat(64), truncation: null });
  if (options.document !== undefined) {
    await tx.query(
      `insert into analyses (revision_id, status, document, completed_at)
       select v.id, 'done', $3::jsonb, now() from pr_revisions v
        where v.pull_request_id = $1 and v.head_sha = $2`,
      [id, pr.headSha, JSON.stringify(options.document)],
    );
  }
  return id;
};

const build = (
  options: { withoutAccessCheck?: boolean; withoutApprover?: boolean; denied?: number[] } = {},
) => {
  lines = [];
  const log = createLogger("inbox-test", {
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
        clientId: "Iv23liInboxTest001",
        clientSecret: "test-only-client-secret-inbox-0123456789",
        fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
      }),
      db,
      keys: new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]),
    },
    ...(options.withoutAccessCheck === true
      ? {}
      : {
          repositoryAccess: {
            check: async (request: RepositoryAccessRequest): Promise<AccessDecision> => {
              accessAsked.push(request);
              return (options.denied ?? [REPOS.hidden]).includes(request.repositoryId)
                ? { allowed: false, reason: "not_found", cached: false }
                : { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
            },
          },
        }),
    ...(options.withoutApprover === true
      ? {}
      : {
          pullRequestApprover: {
            approve: async (request) => {
              approvals.push(request);
              return approveAnswer(request.pullRequestId);
            },
          },
        }),
  });
};

const sessionFor = async (o: SeededOrg, forMember: string, forgeUserId: number) => {
  const now = new Date();
  const { userId } = await db.sessions.upsertUser("github", forgeUserId, now);
  const token = randomToken();
  await db.sessions.createSession({
    tokenSha256: sha256(token),
    userId,
    orgs: [{ orgId: o.orgId, memberId: forMember }],
    activeOrgId: o.orgId,
    now,
    idleTimeoutSeconds: 3600,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return token;
};

const headers = (token: string, csrf = true): Record<string, string> => ({
  cookie: `${SESSION}=${token}`,
  origin: PUBLIC.origin,
  "content-type": "application/json",
  ...(csrf ? { [CSRF_HEADER]: csrfTokenFor(SECRET, token) } : {}),
});

const getInbox = async (token: string) =>
  app.inject({ method: "GET", url: INBOX_PATH, headers: headers(token) });

const approve = async (token: string, body: unknown, csrf = true) =>
  app.inject({
    method: "POST",
    url: APPROVALS_PATH,
    headers: headers(token, csrf),
    payload: JSON.stringify(body),
  });

let token: string;

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 191 }),
    await seedOrg(w, newOrgId(), { installationId: 192 }),
  ]);
  // The seeded repository and PR (an unreadable "test" document) stay: they list as unknown.
  memberId = await db.withOrg(A.orgId, async (tx) => {
    const row = await upsertLoginMember(tx, VIEWER);
    return row!.memberId;
  });
  await asWorker(pgs.workerUrl, (w) =>
    w.withOrg(A.orgId, async (tx) => {
      const repo = async (forgeId: number, name: string) => ({
        id: await upsertRepository(tx, {
          id: forgeId,
          fullName: `acme/${name}`,
          private: true,
          defaultBranch: "main",
        }),
        forgeId,
        name,
      });
      const web = await repo(REPOS.web, "web");
      const api = await repo(REPOS.api, "api");
      const hidden = await repo(REPOS.hidden, "hidden");
      prs.safe1 = await addPr(tx, web, 205, { document: lowDocument("web", 205, sha("a")) });
      prs.safe2 = await addPr(tx, web, 206, { document: lowDocument("web", 206, sha("a")) });
      prs.critical = await addPr(tx, api, 847, {
        document: criticalDocument(sha("a")),
        overrides: { additions: 215, deletions: 3 },
      });
      prs.own = await addPr(tx, web, 207, {
        document: lowDocument("web", 207, sha("a")),
        overrides: { authorLogin: "Sam-R" },
      });
      prs.mismatch = await addPr(tx, web, 208, { document: lowDocument("web", 999, sha("a")) });
      prs.hidden = await addPr(tx, hidden, 1, { document: lowDocument("hidden", 1, sha("a")) });
      prs.closed = await addPr(tx, web, 209, {
        document: lowDocument("web", 209, sha("a")),
        overrides: { state: "closed", closedAt: new Date() },
      });
    }),
  );
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pgs?.stop();
});

beforeEach(async () => {
  accessAsked = [];
  approvals = [];
  approveAnswer = async () => "approved";
  await app?.close();
  app = build();
  await app.ready();
  token = await sessionFor(A, memberId, VIEWER.forgeUserId);
});

describe("GET /api/inbox", () => {
  it("lists the open PRs the member can read on GitHub, sorted by risk, in the wire format", async () => {
    const res = await getInbox(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = InboxResponse.parse(res.json());
    const byId = new Map(body.items.map((i) => [i.id, i]));

    // The hidden repository's PR is not listed; the closed one neither.
    expect(byId.has(prs.hidden!)).toBe(false);
    expect(byId.has(prs.closed!)).toBe(false);
    // Critical first, unknowns next, low last.
    expect(body.items[0]?.id).toBe(prs.critical);
    expect(body.items.map((i) => i.risk)).toEqual(
      body.items.map((i) => i.risk).toSorted((a, b) => order(a) - order(b)),
    );

    expect(byId.get(prs.safe1!)).toMatchObject({
      repo: { owner: "acme", name: "web" },
      number: 205,
      title: "Secret title 205",
      author: "dana-k",
      headSha: sha("a"),
      size: { additions: 1, deletions: 1, files: 1 },
      risk: "low",
      analysis: "done",
      bulkApproval: { eligible: true, blockers: [] },
    });
    expect(byId.get(prs.critical!)?.bulkApproval.blockers).toContain("findings");
    expect(byId.get(prs.own!)?.bulkApproval.blockers).toEqual(["own_pull_request"]);
    // A document about another PR is not used.
    expect(byId.get(prs.mismatch!)).toMatchObject({ risk: "unknown", analysis: "failed" });
    // The seeded fixture PR's document is not a valid analysis document.
    expect(byId.get(A.pullRequestId)).toMatchObject({ risk: "unknown", analysis: "failed" });
  });

  it("asks the access check once per repository, as the member, in the member's org", async () => {
    await getInbox(token);
    const repos = accessAsked.map((r) => r.repositoryId).toSorted();
    expect(repos).toEqual([2001, REPOS.web, REPOS.api, REPOS.hidden].toSorted());
    for (const asked of accessAsked) {
      expect(asked).toMatchObject({ orgId: A.orgId, memberId });
    }
  });

  it("fails closed (503) without the access check", async () => {
    await app.close();
    app = build({ withoutAccessCheck: true });
    await app.ready();
    const res = await getInbox(token);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "access_check_unavailable" });
  });

  it("shows another org nothing of this one", async () => {
    const other = await db.withOrg(B.orgId, async (tx) => {
      const row = await upsertLoginMember(tx, { forgeUserId: 6001, login: "eve" });
      return row!.memberId;
    });
    const res = await getInbox(await sessionFor(B, other, 6001));
    const body = InboxResponse.parse(res.json());
    expect(body.items.map((i) => i.id)).toEqual([B.pullRequestId]);
  });

  it("logs counts, never titles or logins", async () => {
    await getInbox(token);
    const text = lines.join("\n");
    expect(text).toContain('"inbox"');
    expect(text).not.toContain("Secret title");
    expect(text).not.toContain("dana-k");
    expect(text).not.toContain("sam-r");
  });
});

const order = (risk: string) => ["critical", "high", "medium", "unknown", "low"].indexOf(risk);

describe("POST /api/inbox/approvals", () => {
  const batch = (...names: string[]) => ({
    pullRequests: names.map((n) => ({ id: prs[n]!, headSha: sha("a") })),
  });

  it("approves a confirmed batch through the approver, as the member, at the commits seen", async () => {
    const res = await approve(token, batch("safe1", "safe2"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { id: prs.safe1, outcome: "approved" },
        { id: prs.safe2, outcome: "approved" },
      ],
    });
    expect(approvals).toEqual([
      { orgId: A.orgId, memberId, pullRequestId: prs.safe1, headSha: sha("a") },
      { orgId: A.orgId, memberId, pullRequestId: prs.safe2, headSha: sha("a") },
    ]);
  });

  it("is refused by the CSRF guard without the token, and approves nothing", async () => {
    const res = await approve(token, batch("safe1"), false);
    expect(res.statusCode).toBe(403);
    expect(approvals).toEqual([]);
  });

  it("refuses the whole batch when one PR moved past the commit the person saw", async () => {
    const res = await approve(token, {
      pullRequests: [
        { id: prs.safe1, headSha: sha("a") },
        { id: prs.safe2, headSha: sha("c") },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "batch_refused",
      refusals: [{ id: prs.safe2, reason: "head_moved" }],
    });
    expect(approvals).toEqual([]);
  });

  it("refuses the whole batch when one PR is not offered (critical, own, closed, unreadable doc)", async () => {
    for (const name of ["critical", "own", "closed", "mismatch"]) {
      const res = await approve(token, batch("safe1", name));
      expect(res.statusCode, name).toBe(409);
      expect(res.json(), name).toEqual({
        error: "batch_refused",
        refusals: [{ id: prs[name], reason: "not_eligible" }],
      });
    }
    expect(approvals).toEqual([]);
  });

  it("answers 404 for a PR the member cannot read, another org's PR, or an unknown id", async () => {
    for (const id of [prs.hidden!, B.pullRequestId, "00000000-0000-4000-8000-000000000000"]) {
      const res = await approve(token, {
        pullRequests: [
          { id: prs.safe1, headSha: sha("a") },
          { id, headSha: sha("a") },
        ],
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    expect(approvals).toEqual([]);
  });

  it("refuses malformed batches (400) before reading anything", async () => {
    for (const body of [
      {},
      { pullRequests: [] },
      { pullRequests: [{ id: "x", headSha: sha("a") }] },
      { pullRequests: [{ id: prs.safe1, headSha: sha("a") }], orgId: B.orgId },
      { pullRequests: [{ id: prs.safe1, headSha: sha("a"), memberId: "x" }] },
      batch("safe1", "safe1"),
    ]) {
      const res = await approve(token, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_batch" });
    }
    expect(accessAsked).toEqual([]);
    expect(approvals).toEqual([]);
  });

  it("fails closed (503) without an approver (P3-5) or without the access check", async () => {
    for (const options of [{ withoutApprover: true }, { withoutAccessCheck: true }]) {
      await app.close();
      app = build(options);
      await app.ready();
      const res = await approve(token, batch("safe1"));
      expect(res.statusCode).toBe(503);
    }
    expect(approvals).toEqual([]);
  });

  it("reports a PR the forge did not approve as failed and goes on with the rest", async () => {
    approveAnswer = async (id) => {
      if (id === prs.safe1) throw new Error("forge said no");
      return "approved";
    };
    const res = await approve(token, batch("safe1", "safe2"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { id: prs.safe1, outcome: "failed" },
        { id: prs.safe2, outcome: "approved" },
      ],
    });
  });

  it("refuses a second batch from the same member while one is in flight (double submit)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    approveAnswer = async () => {
      await gate;
      return "approved";
    };
    const first = approve(token, batch("safe1"));
    // Wait until the first batch reached the approver.
    while (approvals.length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await approve(token, batch("safe1"));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "batch_in_progress" });
    release();
    expect((await first).statusCode).toBe(200);
    expect(approvals).toHaveLength(1);
  });

  it("logs ids and outcomes, never titles", async () => {
    await approve(token, batch("safe1"));
    const text = lines.join("\n");
    expect(text).toContain('"bulk_approve"');
    expect(text).not.toContain("Secret title");
  });
});
