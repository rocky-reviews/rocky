import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AccessDecision,
  ForgePullRequest,
  RepositoryAccessRequest,
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
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseShellData } from "../../../web/src/data/shell-data.js";
import { buildApp } from "../app.js";
import { randomToken, sha256 } from "../auth/cookies.js";

/**
 * H4-2: the PR page's data on a real Postgres, as the browser asks for it (session cookie). Each
 * analysis state the page renders, myReview, the 404/401/503 answers, GitHub access, RLS and
 * the logs. Every 200 answer goes through the web app's own `parseShellData` (the contract).
 * Who may call it (the route-permission matrix) is in `auth/policy.db.test.ts`.
 */

const PUBLIC = new URL("https://rocky.example.com/");
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);
const HEAD = pr847.provenance.head.sha;
const FORGE_REPO = 5001;

let pgs: TestPostgres;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;
let app: FastifyInstance;
let lines: string[] = [];
let accessAnswer: AccessDecision;
let accessAsked: RepositoryAccessRequest[] = [];
let dana: string;
let danaB: string;
let repoA: string;

const build = (options: { withoutAccessCheck?: boolean } = {}) => {
  const log = createLogger("pull-page-test", {
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
        clientId: "Iv23liPullPageTest01",
        clientSecret: "test-only-client-secret-pullpage-012345",
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

const forgePr = (number: number, overrides: Partial<ForgePullRequest> = {}): ForgePullRequest => ({
  ref: { installationId: 1, repositoryId: FORGE_REPO, number },
  title: "Team invitations with expiring links",
  authorLogin: "dana-k",
  state: "open",
  headSha: HEAD,
  baseSha: pr847.provenance.base.sha,
  openedAt: new Date("2026-10-20T09:00:00Z"),
  closedAt: null,
  updatedAt: new Date("2026-10-25T12:00:00Z"),
  changedFiles: 9,
  additions: 215,
  deletions: 3,
  ...overrides,
});

const DIFF = {
  bytes: 10,
  sha256: createHash("sha256").update("d").digest("hex"),
  truncation: null,
};

/** A document for PR `number` of acme/rocky-app at `head` (pr-847's, renumbered). */
const documentFor = (number: number, head = HEAD) => ({
  ...pr847,
  provenance: {
    ...pr847.provenance,
    pullRequest: { number },
    head: { ...pr847.provenance.head, sha: head },
  },
});

type Run = {
  status: "queued" | "running" | "awaiting_approval" | "done" | "failed";
  document?: unknown;
  errorCode?: string;
  head?: string;
};

/** Mirrors PR `number` (head recorded) with these analysis rows, oldest first. */
const pullWith = async (
  number: number,
  runs: Run[],
  pr: Partial<ForgePullRequest> = {},
): Promise<{ pullRequestId: string; analyses: string[] }> =>
  db.withOrg(A.orgId, async (tx) => {
    const forge = forgePr(number, pr);
    const created = await upsertPullRequest(tx, repoA, forge);
    await recordRevision(tx, created.id, forge, DIFF);
    const analyses: string[] = [];
    let at = Date.parse("2026-10-25T10:00:00Z");
    for (const run of runs) {
      const revision = await revisionOf(tx, created.id, run.head ?? forge.headSha);
      at += 60_000;
      const { rows } = await tx.query<{ id: string }>(
        `insert into analyses
           (revision_id, status, document, error_code, created_at, completed_at,
            estimated_tokens, limit_tokens, lease_id, lease_until, claimed_at)
         values ($1, $2, $3::jsonb, $4, $5::timestamptz,
                 case when $2 in ('done', 'failed') then $5::timestamptz end,
                 case when $2 = 'awaiting_approval' then 210000 end,
                 case when $2 = 'awaiting_approval' then 150000 end,
                 case when $2 = 'running' then gen_random_uuid() end,
                 case when $2 = 'running' then now() + interval '1 hour' end,
                 case when $2 = 'running' then now() end)
         returning id`,
        [
          revision,
          run.status,
          run.status === "done" ? JSON.stringify(run.document ?? documentFor(number)) : null,
          run.errorCode ?? null,
          new Date(at),
        ],
      );
      analyses.push(rows[0]!.id);
    }
    return { pullRequestId: created.id, analyses };
  });

const revisionOf = async (tx: TenantTx, pullRequestId: string, headSha: string) => {
  const { rows } = await tx.query<{ id: string }>(
    `insert into pr_revisions (pull_request_id, head_sha, base_sha) values ($1, $2, $3)
     on conflict (org_id, pull_request_id, head_sha) do update set base_sha = excluded.base_sha
     returning id`,
    [pullRequestId, headSha, pr847.provenance.base.sha],
  );
  return rows[0]!.id;
};

const sessionIn = async (org: SeededOrg, forgeUserId: number, login: string) => {
  const memberId = await db.withOrg(org.orgId, async (tx) => {
    const row = await upsertLoginMember(tx, { forgeUserId, login });
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
  return { token, memberId };
};

let danaMember: string;

const get = (token: string | null, url: string, on: FastifyInstance = app) =>
  on.inject({
    method: "GET",
    url,
    headers: token === null ? {} : { cookie: `${SESSION}=${token}` },
  });

const page = (number: number, owner = "acme", repo = "rocky-app") =>
  `/api/repos/${owner}/${repo}/pulls/${number}`;

type Answer = {
  pullRequestId: string;
  pull: Record<string, unknown>;
  myReview: string | null;
  analysis: { provenance: { head: { sha: string } } } | null;
  analysisId: string | null;
  analysisRun: Record<string, unknown>;
};

/** A 200 answer, checked with the web app's own parser. */
const served = async (number: number, token = dana): Promise<Answer> => {
  const res = await get(token, page(number));
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  const body = res.json() as Answer;
  expect(() => parseShellData(body)).not.toThrow();
  return body;
};

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 181 }),
    await seedOrg(w, newOrgId(), { installationId: 182 }),
  ]);
  repoA = await db.withOrg(A.orgId, (tx) =>
    upsertRepository(tx, {
      id: FORGE_REPO,
      fullName: "acme/rocky-app",
      private: true,
      defaultBranch: "main",
    }),
  );
  // Org B has a repository of the same name and a PR of the same number: never served to A.
  await db.withOrg(B.orgId, async (tx) => {
    const repo = await upsertRepository(tx, {
      id: 6001,
      fullName: "acme/rocky-app",
      private: true,
      defaultBranch: "main",
    });
    await upsertPullRequest(tx, repo, { ...forgePr(900), title: "Org B's own PR" });
  });
  ({ token: dana, memberId: danaMember } = await sessionIn(A, 4101, "dana-k"));
  ({ token: danaB } = await sessionIn(B, 4102, "bo"));
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

describe("GET /api/repos/:owner/:repo/pulls/:number: the shell's data", () => {
  it("done: GitHub's view from the mirror, the validated document and its ids", async () => {
    const { pullRequestId, analyses } = await pullWith(847, [{ status: "done" }]);
    const body = await served(847);
    expect(body).toEqual({
      pullRequestId,
      pull: {
        owner: "acme",
        repo: "rocky-app",
        number: 847,
        title: "Team invitations with expiring links",
        author: "dana-k",
        state: "open",
        headRef: null,
        baseRef: null,
        headSha: HEAD,
        additions: 215,
        deletions: 3,
        changedFiles: 9,
        updatedAt: "2026-10-25T12:00:00.000Z",
        approvers: null,
        commentCount: null,
      },
      myReview: null,
      analysis: documentFor(847),
      analysisId: analyses[0],
      analysisRun: { status: "done" },
    });
    // The member and the repository come from the session and the row; nothing from the URL.
    expect(accessAsked).toEqual([
      { orgId: A.orgId, memberId: danaMember, repositoryId: FORGE_REPO },
    ]);
  });

  it("finds the repository whatever the case in the address, and answers with GitHub's", async () => {
    await pullWith(848, [{ status: "done", document: documentFor(848) }]);
    const res = await get(dana, page(848, "ACME", "Rocky-App"));
    expect(res.statusCode).toBe(200);
    expect((res.json() as Answer).pull).toMatchObject({ owner: "acme", repo: "rocky-app" });
  });

  it("each run state of the head, with no document yet", async () => {
    const cases: [number, Run[], Record<string, unknown>][] = [
      [850, [], { status: "none" }],
      [851, [{ status: "queued" }], { status: "queued" }],
      [852, [{ status: "running" }], { status: "running" }],
      [
        853,
        [{ status: "awaiting_approval" }],
        { status: "awaiting_approval", estimatedTokens: 210_000, limitTokens: 150_000 },
      ],
      [
        854,
        [{ status: "failed", errorCode: "provider_error" }],
        { status: "failed", code: "provider_error" },
      ],
      [
        855,
        [{ status: "failed", errorCode: "superseded" }],
        { status: "failed", code: "superseded" },
      ],
    ];
    for (const [number, runs] of cases) await pullWith(number, runs);
    for (const [number, , run] of cases) {
      const body = await served(number);
      expect(body.analysisRun, `#${number}`).toEqual(run);
      expect(body.analysis, `#${number}`).toBeNull();
      expect(body.analysisId, `#${number}`).toBeNull();
    }
  });

  it("a re-run of the head shows the previous document under the newer run's state", async () => {
    const { analyses } = await pullWith(860, [
      { status: "done", document: documentFor(860) },
      { status: "failed", errorCode: "provider_error" },
    ]);
    const body = await served(860);
    expect(body.analysisId).toBe(analyses[0]);
    expect(body.analysisRun).toEqual({ status: "failed", code: "provider_error" });
  });

  it("after a push: the older push's document (shown out of date) and the head's run", async () => {
    const older = "c".repeat(40);
    const { analyses } = await pullWith(
      861,
      [
        { status: "done", head: older, document: documentFor(861, older) },
        { status: "awaiting_approval" },
      ],
      { headSha: HEAD },
    );
    const body = await served(861);
    expect(body.analysisId).toBe(analyses[0]);
    expect(body.analysis?.provenance.head.sha).toBe(older);
    expect(body.pull["headSha"]).toBe(HEAD);
    expect(body.analysisRun).toMatchObject({ status: "awaiting_approval" });
    // Nothing analysed the head yet: the older document is still the one shown.
    await pullWith(862, [{ status: "done", head: older, document: documentFor(862, older) }]);
    expect((await served(862)).analysisRun).toEqual({ status: "done" });
  });

  it("a superseded head run is shown as such, not over an older document", async () => {
    const older = "d".repeat(40);
    await pullWith(863, [
      { status: "done", head: older, document: documentFor(863, older) },
      { status: "failed", errorCode: "superseded" },
    ]);
    const body = await served(863);
    expect(body.analysis).toBeNull();
    expect(body.analysisRun).toEqual({ status: "failed", code: "superseded" });
  });

  it("a stored document that does not validate, or describes another PR, is never served", async () => {
    await pullWith(870, [{ status: "done", document: { schemaVersion: "nope" } }]);
    expect(await served(870)).toMatchObject({
      analysis: null,
      analysisId: null,
      analysisRun: { status: "failed", code: "invalid_document" },
    });
    await pullWith(871, [{ status: "done", document: documentFor(999) }]);
    expect((await served(871)).analysis).toBeNull();
  });

  it("an uncoded failure reads `unknown`; a PR without a recorded head has no size", async () => {
    await pullWith(872, [{ status: "failed", errorCode: "Not A Code" }]);
    expect((await served(872)).analysisRun).toEqual({ status: "failed", code: "unknown" });
    const id = await db.withOrg(A.orgId, async (tx) => {
      const created = await upsertPullRequest(tx, repoA, forgePr(873));
      return created.id;
    });
    const body = await served(873);
    expect(body.pullRequestId).toBe(id);
    expect(body.pull).toMatchObject({ additions: null, deletions: null, changedFiles: null });
  });

  it("myReview: the member's latest review posted from Rocky", async () => {
    const { pullRequestId } = await pullWith(880, [{ status: "done", document: documentFor(880) }]);
    await db.withOrg(A.orgId, async (tx) => {
      const revision = await revisionOf(tx, pullRequestId, HEAD);
      await tx.query(
        `insert into review_submissions
           (pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict,
            content_sha256, body_sha256, draft_count, comment_count, status, forge_review_id,
            finished_at)
         values ($1, $2, $3, $4, $5, 'request_changes', decode(repeat('00', 32), 'hex'),
                 decode(repeat('00', 32), 'hex'), 0, 0, 'posted', 12, now())`,
        [pullRequestId, revision, danaMember, randomUUID(), HEAD],
      );
    });
    expect((await served(880)).myReview).toBe("changes_requested");
  });
});

describe("GET /api/repos/:owner/:repo/pulls/:number: refusals", () => {
  it("unknown PR, unknown repository and another org's PR: the same 404", async () => {
    for (const url of [page(999_999), page(847, "acme", "elsewhere"), page(900)]) {
      const res = await get(dana, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    // Org B reads its own PR #900, never A's #847 (RLS, the same names in both orgs).
    expect((await get(danaB, page(900))).statusCode).toBe(200);
    expect((await get(danaB, page(847))).statusCode).toBe(404);
  });

  it("a disabled repository is not served", async () => {
    await pullWith(890, []);
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update repos set enabled = false where id = $1", [repoA]),
    );
    try {
      expect((await get(dana, page(890))).statusCode).toBe(404);
    } finally {
      await db.withOrg(A.orgId, (tx) =>
        tx.query("update repos set enabled = true where id = $1", [repoA]),
      );
    }
  });

  it("GitHub access still applies: no read access is the same 404", async () => {
    await pullWith(891, [{ status: "done", document: documentFor(891) }]);
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    const res = await get(dana, page(891));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(accessAsked).toHaveLength(1);
  });

  it("without the repository access check: 503, before reading anything", async () => {
    const prev = app;
    app = build({ withoutAccessCheck: true });
    try {
      const res = await get(dana, page(847));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "access_check_unavailable" });
    } finally {
      await app.close();
      app = prev;
    }
  });

  it("without a session: 401", async () => {
    const res = await get(null, page(847));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("an address that cannot name a pull request: 400, nothing asked", async () => {
    for (const url of [
      page(0),
      "/api/repos/acme/rocky-app/pulls/01",
      "/api/repos/acme/rocky-app/pulls/1e3",
      "/api/repos/acme/rocky-app/pulls/99999999999",
      page(1, "-acme"),
      page(1, "acme", "a%20b"),
    ]) {
      const res = await get(dana, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toEqual({ error: "invalid_pull_request" });
    }
    expect(accessAsked).toEqual([]);
  });

  it("logs carry ids and outcomes, never the title, names or document text", async () => {
    await pullWith(892, [{ status: "done", document: documentFor(892) }]);
    await served(892);
    await get(dana, page(999_998));
    const entries = lines
      .map((l) => JSON.parse(l) as { pull_page?: Record<string, unknown> })
      .filter((l) => l.pull_page !== undefined)
      .map((l) => l.pull_page);
    expect(entries).toContainEqual(
      expect.objectContaining({ outcome: "served", orgId: A.orgId, run: "done" }),
    );
    expect(entries).toContainEqual({ outcome: "not_found", orgId: A.orgId });
    const joined = JSON.stringify(entries);
    expect(joined).not.toContain("Team invitations");
    expect(joined).not.toContain("rocky-app");
    expect(joined).not.toContain("dana-k");
    expect(joined).not.toContain(pr847.briefing.summary.slice(0, 20));
  });
});
