import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalReviewPlan,
  composePostedComment,
  ForgeReadError,
  type AccessDecision,
  type OrgId,
  type RepositoryAccessRequest,
} from "@rocky-reviews/core";
import {
  encodeWrappedDataKey,
  generateLocalKek,
  generateWrappedDataKey,
  LocalKeyWrapper,
  OrgKeyring,
} from "@rocky-reviews/crypto";
import {
  clearForgeToken,
  createDb,
  decideDraft,
  reviewSha256,
  storeForgeToken,
  storeOrgDataKey,
  type Db,
} from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import {
  createGitHubLogin,
  createGitHubReviewPoster,
  githubEndpoints,
} from "@rocky-reviews/forge-github";
import {
  fakeGitHubApi,
  FIXTURE_APP_ID,
  testAppKeys,
  type FakeGitHubApi,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { csrfTokenFor, CSRF_HEADER, randomToken, sha256 } from "../auth/cookies.js";
import { MEMBER_TOKEN_PURPOSE } from "../repository-access.js";

/**
 * P3-5 acceptance criteria (ADR 0026), end to end: the app with login and the review routes on a
 * real Postgres as the application role, members' tokens envelope-encrypted, a fake GitHub that
 * records every review it is asked to create, a fake P3-6 check that records every question.
 *
 * - Never posts without an explicit user action: only a CSRF-checked POST by a session's member
 *   reaches the poster; the attempt row names that member; the worker has no path to it.
 * - Posted content equals what the user saw: what the fake GitHub receives is exactly the
 *   preview, and a list that changed in between is refused.
 */

const DOCUMENT = JSON.parse(
  readFileSync(
    new URL("../../../../packages/schema/fixtures/pr-847.json", import.meta.url),
    "utf8",
  ),
) as AnalysisDocument;
const findingBy = (id: string) => {
  const finding = DOCUMENT.findings.find((f) => f.id === id);
  if (finding === undefined) throw new Error(`no finding ${id}`);
  return finding;
};
const HEAD = "a".repeat(40);
const PUBLIC = new URL("https://rocky.example.com/");
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);
const KEYS = new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]);
const REPO = 2001; // seedOrg's repository
const ALICE_GH = 1001; // seedOrg's member `alice`
const BOB_GH = 1002;
const CAROL_GH = 1003;
const { api } = githubEndpoints({});

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;
let bob: string;
let carol: string;
let github: FakeGitHubApi;
let app: FastifyInstance;
let lines: string[] = [];
let accessAsked: RepositoryAccessRequest[] = [];
let accessAnswer: AccessDecision = { allowed: true, cached: false, expiresAt: new Date() };
/**
 * How the poster behaves: pass through, reach GitHub but lose the answer, never reach it, or
 * throw a plain error before any request (a caller bug).
 */
let network: "ok" | "lose_answer" | "down" | "bug" = "ok";
const clock = { ms: Date.now() };
const tokens: Record<string, string> = {};

const dataKeys = new Map<OrgId, Awaited<ReturnType<typeof generateWrappedDataKey>>>();

/** Provisions the org's data key once (as the first login would). */
const provisionKey = async (org: SeededOrg) => {
  const wrapped = await generateWrappedDataKey(KEYS, org.orgId);
  await db.withOrg(org.orgId, (tx) =>
    storeOrgDataKey(tx, encodeWrappedDataKey(wrapped), wrapped.version),
  );
  dataKeys.set(org.orgId, wrapped);
};

/** Stores a member's GitHub token the way login does: encrypted under the org's data key. */
const storeToken = async (org: SeededOrg, memberId: string, token: string) => {
  const keyring = await OrgKeyring.open(KEYS, org.orgId, [dataKeys.get(org.orgId)!]);
  try {
    const ciphertext = keyring.encrypt(token, {
      purpose: MEMBER_TOKEN_PURPOSE,
      recordId: memberId,
    });
    await db.withOrg(org.orgId, (tx) =>
      storeForgeToken(tx, memberId, ciphertext, keyring.currentVersion, {
        expiresAt: new Date(Date.now() + 8 * 3_600_000),
      }),
    );
  } finally {
    keyring.destroy();
  }
};

const build = (options: { withoutAccessCheck?: boolean } = {}) => {
  lines = [];
  const log = createLogger("review-test", {
    level: "debug",
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const fetchThrough: typeof fetch = async (input, init) => {
    if (network === "down") throw new TypeError("fetch failed");
    const response = await github.fetch(input, init);
    if (network === "lose_answer" && init?.method === "POST") {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    return response;
  };
  return buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    auth: {
      publicUrl: PUBLIC,
      cookieSecure: true,
      secret: SECRET,
      login: createGitHubLogin({
        endpoints: githubEndpoints({}),
        clientId: "Iv23liReviewTest01",
        clientSecret: "test-only-client-secret-review-0123456789",
        fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
      }),
      db,
      keys: KEYS,
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
    reviewPosting: {
      poster: {
        ...createGitHubReviewPoster({ api, fetch: fetchThrough }),
        postReview: (...args) =>
          network === "bug"
            ? Promise.reject(new Error("reviews: invalid review (test)"))
            : createGitHubReviewPoster({ api, fetch: fetchThrough }).postReview(...args),
      },
      keys: KEYS,
      now: () => clock.ms,
      postingTimeoutMs: 60_000,
    },
  });
};

/**
 * Ages the attempt in flight past the reconciliation timeout. The age is measured by the
 * database's clock (review round 1, S3), so the row is backdated rather than the app's clock
 * advanced.
 */
const age = async (org: SeededOrg) => {
  await superuser.query(
    `update review_submissions set created_at = created_at - interval '2 minutes'
      where org_id = $1 and status = 'posting'`,
    [org.orgId],
  );
};

/** A live session for a member of `org` (ids as the login flow would store them). */
const sessionFor = async (org: SeededOrg, memberId: string, forgeUserId: number) => {
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

const headersFor = (token: string | null, options: { csrf?: boolean; origin?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers["cookie"] = `${SESSION}=${token}`;
    headers["origin"] = options.origin ?? PUBLIC.origin;
    if (options.csrf !== false) headers[CSRF_HEADER] = csrfTokenFor(SECRET, token);
  }
  return headers;
};

const preview = (token: string | null, pullRequestId: string) =>
  app.inject({
    method: "GET",
    url: `/api/pull-requests/${pullRequestId}/review`,
    headers: headersFor(token),
  });

const post = (
  token: string | null,
  pullRequestId: string,
  body: unknown,
  options: { csrf?: boolean; origin?: string } = {},
) =>
  app.inject({
    method: "POST",
    url: `/api/pull-requests/${pullRequestId}/review`,
    headers: { ...headersFor(token, options), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });

/** One reviewer action through P6-4's draft route (the accepted card's source of truth). */
const draftAction = async (
  token: string,
  org: SeededOrg,
  findingId: string,
  body: Record<string, unknown>,
) => {
  const res = await app.inject({
    method: "POST",
    url: `/api/analyses/${org.analysisId}/drafts/${findingId}`,
    headers: { ...headersFor(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { draft: { state: string; edited: boolean; body: string | null } }).draft;
};

interface Attempt {
  submissionId: string;
  status: string;
  verdict: string;
  draftCount: number;
  commentCount: number;
  reviewId: number | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface Preview {
  headSha: string;
  contentSha256: string;
  inFlight: Attempt | null;
  latestSubmission: Attempt | null;
  items: {
    kind: string;
    id: string;
    path: string;
    line: number;
    startLine: number | null;
    body: string;
  }[];
}

const click = (shown: Preview, over: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  contentSha256: shown.contentSha256,
  headSha: shown.headSha,
  verdict: "request_changes",
  body: "Please validate the invite email before sending.",
  ...over,
});

/** The seeded analysis gets the pr-847 document; alice accepts F1 and F3 and drafts a comment. */
const reset = async () => {
  for (const org of [A, B]) {
    await superuser.query("delete from review_submissions where org_id = $1", [org.orgId]);
    await db.withOrg(org.orgId, async (tx) => {
      await tx.query("update analyses set document = $2::jsonb where id = $1", [
        org.analysisId,
        JSON.stringify(DOCUMENT),
      ]);
      await tx.query("delete from findings_state where analysis_id = $1", [org.analysisId]);
      await tx.query("delete from comments_pending where pull_request_id = $1", [
        org.pullRequestId,
      ]);
      await tx.query(
        "update pull_requests set head_sha = $2, author_login = 'someone' where id = $1",
        [org.pullRequestId, HEAD],
      );
      // Accepted through P6-4's store, so both rows are what the page writes (ADR 0027).
      for (const id of ["F1", "F3"]) {
        const result = await decideDraft(tx, {
          analysisId: org.analysisId,
          memberId: org.memberId,
          findingId: id,
          action: { kind: "accept" },
        });
        if (result.outcome !== "ok") throw new Error(`decideDraft: ${result.outcome}`);
      }
      await tx.query(
        `insert into comments_pending
           (pull_request_id, revision_id, author_id, analysis_id, path, line, body)
         values ($1, $2, $3, $4, 'src/auth/invitations.ts', 31, 'Also log the inviter id here.')`,
        [org.pullRequestId, org.revisionId, org.memberId, org.analysisId],
      );
    });
  }
  await db.withOrg(A.orgId, (tx) =>
    tx.query(
      `insert into comments_pending
         (pull_request_id, revision_id, author_id, analysis_id, path, line, body)
       values ($1, $2, $3, $4, 'src/auth/invitations.ts', 40, 'bob was here')`,
      [A.pullRequestId, A.revisionId, bob, A.analysisId],
    ),
  );
  github.reviews.length = 0;
  github.requests.length = 0;
  github.putPullRequest(REPO, { number: 847, headSha: HEAD, authorLogin: "someone" });
  accessAsked = [];
  accessAnswer = { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
  network = "ok";
  clock.ms = Date.now();
};

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 8 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: testAppKeys().publicKey });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 61 }),
    await seedOrg(w, newOrgId(), { installationId: 62 }),
  ]);
  bob = await db.withOrg(A.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into members (forge_user_id, login) values ($1, 'bob') returning id",
      [BOB_GH],
    );
    return rows[0]!.id;
  });
  carol = await db.withOrg(B.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into members (forge_user_id, login) values ($1, 'carol') returning id",
      [CAROL_GH],
    );
    return rows[0]!.id;
  });
  for (const [installation, org] of [
    [61, A],
    [62, B],
  ] as const) {
    github.install(installation, {
      id: 9000 + installation,
      login: `org-${installation}`,
      type: "Organization",
    });
    github.addRepository(installation, {
      id: org === A ? REPO : 3001,
      fullName: `org-${installation}/api`,
    });
  }
  tokens["alice"] = github.addUser({ id: ALICE_GH, login: "alice" });
  tokens["bob"] = github.addUser({ id: BOB_GH, login: "bob" });
  tokens["carol"] = github.addUser({ id: CAROL_GH, login: "carol" });
  for (const id of [ALICE_GH, BOB_GH, CAROL_GH]) github.setPermission(id, REPO, "write");
  await provisionKey(A);
  await provisionKey(B);
  await storeToken(A, A.memberId, tokens["alice"]);
  await storeToken(A, bob, tokens["bob"]);
  await storeToken(B, carol, tokens["carol"]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

beforeEach(async () => {
  await app?.close();
  app = build();
  await app.ready();
  await reset();
});

const submissions = (org: SeededOrg) =>
  superuser.query<{
    submitted_by: string;
    status: string;
    forge_review_id: string | null;
    error_code: string | null;
    content_sha256: Buffer;
    draft_count: number;
    comment_count: number;
  }>(
    "select submitted_by, status, forge_review_id, error_code, content_sha256, draft_count, comment_count from review_submissions where org_id = $1 order by created_at",
    [org.orgId],
  );

describe("posted content equals what the user saw (acceptance criterion)", () => {
  it("posts exactly the previewed items, the verdict and the summary as one review with the user's token", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const shown = await preview(alice, A.pullRequestId);
    expect(shown.statusCode).toBe(200);
    const plan = shown.json() as Preview;
    expect(plan.headSha).toBe(HEAD);
    expect(plan.items.map((i) => [i.kind, i.path, i.line])).toEqual([
      ["draft", "src/auth/invitations.ts", 28],
      ["draft", "src/auth/invitations.ts", 23],
      ["comment", "src/auth/invitations.ts", 31],
    ]);
    expect(plan.contentSha256).toBe(
      reviewSha256(canonicalReviewPlan(HEAD, plan.items as never)).toString("hex"),
    );

    const posted = await post(alice, A.pullRequestId, click(plan));
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json()).toEqual({
      status: "posted",
      submissionId: expect.any(String),
      reviewId: 880011,
      repeated: false,
    });
    expect(github.reviews).toHaveLength(1);
    const review = github.reviews[0]!;
    expect(review.userId).toBe(ALICE_GH);
    expect(review.repositoryId).toBe(REPO);
    expect(review.number).toBe(847);
    expect(review.payload).toEqual({
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: "Please validate the invite email before sending.",
      comments: plan.items.map((i) => ({
        path: i.path,
        line: i.line,
        side: "RIGHT",
        ...(i.startLine === null ? {} : { start_line: i.startLine, start_side: "RIGHT" }),
        body: i.body,
      })),
    });
    // The access check ran first, for alice, on the pull request's repository.
    expect(accessAsked[0]).toEqual({ orgId: A.orgId, memberId: A.memberId, repositoryId: REPO });
    // The record names the member and the digest of what was shown; nothing else to post now.
    const { rows } = await submissions(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      submitted_by: A.memberId,
      status: "posted",
      forge_review_id: "880011",
      draft_count: 2,
      comment_count: 1,
    });
    expect(rows[0]!.content_sha256.toString("hex")).toBe(plan.contentSha256);
    expect(((await preview(alice, A.pullRequestId)).json() as Preview).items).toEqual([]);
    const audit = await superuser.query(
      "select action, actor_type, actor_id from audit_events where org_id = $1 and action like 'review.%' order by id",
      [A.orgId],
    );
    expect(audit.rows).toEqual([
      { action: "review.submission_started", actor_type: "user", actor_id: A.memberId },
      { action: "review.posted", actor_type: "user", actor_id: A.memberId },
    ]);
  });

  it("refuses a list that changed after the preview (edited comment, dismissed draft, new item) and a moved head, posting nothing", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update comments_pending set body = 'edited' where author_id = $1", [A.memberId]),
    );
    const edited = await post(alice, A.pullRequestId, click(plan));
    expect(edited.statusCode).toBe(409);
    expect(edited.json()).toEqual({ error: "stale" });
    const plan2 = (await preview(alice, A.pullRequestId)).json() as Preview;
    await draftAction(alice, A, "F1", { action: "undo" });
    await draftAction(alice, A, "F1", { action: "dismiss", reason: "not_worth_it" });
    expect((await post(alice, A.pullRequestId, click(plan2))).json()).toEqual({ error: "stale" });
    const plan3 = (await preview(alice, A.pullRequestId)).json() as Preview;
    await db.withOrg(A.orgId, (tx) =>
      tx.query(
        `insert into comments_pending
           (pull_request_id, revision_id, author_id, analysis_id, path, line, body)
         values ($1, $2, $3, $4, 'src/x.ts', 1, 'late')`,
        [A.pullRequestId, A.revisionId, A.memberId, A.analysisId],
      ),
    );
    expect((await post(alice, A.pullRequestId, click(plan3))).json()).toEqual({ error: "stale" });
    const plan4 = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(
      (await post(alice, A.pullRequestId, click(plan4, { headSha: "f".repeat(40) }))).json(),
    ).toEqual({ error: "head_moved" });
    expect(github.reviews).toHaveLength(0);
    expect(github.requests).toEqual([]);
    expect((await submissions(A)).rowCount).toBe(0);
  });

  it("an accepted draft is posted once (not again as an own comment) and an edited draft posts the edited body, as the card shows it (P6-4)", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    await draftAction(alice, A, "F1", { action: "undo" });
    const edited = await draftAction(alice, A, "F1", {
      action: "edit",
      body: "Validate it first.",
    });
    expect(edited).toMatchObject({ state: "accepted", edited: true, body: "Validate it first." });
    // What the page loads for the accepted cards: their pending bodies.
    const page = await app.inject({
      method: "GET",
      url: `/api/analyses/${A.analysisId}/review`,
      headers: headersFor(alice),
    });
    const cards = (page.json() as { drafts: { findingId: string; body: string | null }[] }).drafts;
    const cardBody = (id: string) => cards.find((d) => d.findingId === id)?.body ?? null;
    expect(cardBody("F1")).toBe("Validate it first.");
    expect(cardBody("F3")).toBe(findingBy("F3").body);

    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(plan.items.map((i) => i.kind)).toEqual(["draft", "draft", "comment"]);
    const posted = await post(alice, A.pullRequestId, click(plan));
    expect(posted.statusCode, posted.body).toBe(200);
    expect(github.reviews).toHaveLength(1);
    const comments = github.reviews[0]!.payload["comments"] as { body: string }[];
    // Three comments, not five: the drafts' pending rows are not posted again as own comments.
    expect(comments.map((c) => c.body)).toEqual([
      composePostedComment(findingBy("F1"), { body: cardBody("F1")! }),
      composePostedComment(findingBy("F3"), { body: cardBody("F3")! }),
      "Also log the inviter id here.",
    ]);
    expect(comments[0]!.body).toContain("Validate it first.");
    expect(comments[0]!.body).not.toContain(findingBy("F1").body);
    expect(comments.filter((c) => c.body.includes(findingBy("F3").title))).toHaveLength(1);
    expect((await submissions(A)).rows[0]).toMatchObject({ draft_count: 2, comment_count: 1 });
  });

  it("the preview is the member's own: bob sees his comment, not alice's drafts, and posts under his own name", async () => {
    const bobSession = await sessionFor(A, bob, BOB_GH);
    const plan = (await preview(bobSession, A.pullRequestId)).json() as Preview;
    expect(plan.items.map((i) => [i.kind, i.body])).toEqual([["comment", "bob was here"]]);
    const posted = await post(
      bobSession,
      A.pullRequestId,
      click(plan, { verdict: "comment", body: "" }),
    );
    expect(posted.statusCode).toBe(200);
    expect(github.reviews[0]?.userId).toBe(BOB_GH);
    expect(github.reviews[0]?.payload["comments"]).toEqual([
      { path: "src/auth/invitations.ts", line: 40, side: "RIGHT", body: "bob was here" },
    ]);
    expect((await submissions(A)).rows[0]?.submitted_by).toBe(bob);
  });
});

describe("never posts without an explicit user action (acceptance criterion)", () => {
  it("no session, no CSRF token or a foreign origin: refused before anything happens", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect((await preview(null, A.pullRequestId)).statusCode).toBe(401);
    expect((await post(null, A.pullRequestId, click(plan))).statusCode).toBe(403);
    const noCsrf = await post(alice, A.pullRequestId, click(plan), { csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toEqual({ error: "csrf" });
    const crossSite = await post(alice, A.pullRequestId, click(plan), {
      origin: "https://evil.example",
    });
    expect(crossSite.statusCode).toBe(403);
    expect(github.requests).toEqual([]);
    expect(github.reviews).toHaveLength(0);
    expect((await submissions(A)).rowCount).toBe(0);
    expect(accessAsked.filter((q) => q.memberId !== A.memberId)).toEqual([]);
  });

  it("the body cannot choose who posts or where: the session's member is the submitter, extra fields are ignored", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const posted = await post(alice, A.pullRequestId, {
      ...click(plan),
      submittedBy: bob,
      memberId: bob,
      orgId: B.orgId,
      pullRequestId: B.pullRequestId,
    });
    expect(posted.statusCode).toBe(200);
    expect(github.reviews[0]?.userId).toBe(ALICE_GH);
    expect((await submissions(A)).rows[0]?.submitted_by).toBe(A.memberId);
    expect((await submissions(B)).rowCount).toBe(0);
  });

  it("there is no code path from the worker, the LLM pipeline or the installation-token forge to the poster", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
        return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
      });
    const root = new URL("../../../../", import.meta.url).pathname;
    const forbidden =
      /createGitHubReviewPoster|ReviewPoster\b|postReview\b|review-posting|listOwnReviews|\/reviews\b/;
    for (const dir of ["apps/worker/src", "packages/core/src/analysis", "packages/llm/src"]) {
      for (const file of files(join(root, dir))) {
        expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
      }
    }
    // The installation-token Forge (what the worker holds) has no posting method at all.
    const forgePort = readFileSync(join(root, "packages/core/src/forge.ts"), "utf8");
    expect(forgePort).not.toMatch(/postReview|ReviewPoster/);
    const installationForge = readFileSync(
      join(root, "packages/forge-github/src/repositories.ts"),
      "utf8",
    );
    expect(installationForge).not.toMatch(/\/reviews\b|method: "POST"/);
    // Only the server's review service and routes name the poster.
    const server = files(join(root, "apps/server/src")).filter((f) =>
      /ReviewPoster|createGitHubReviewPoster/.test(readFileSync(f, "utf8")),
    );
    expect(server.map((f) => f.slice(root.length)).toSorted()).toEqual([
      "apps/server/src/app.ts",
      "apps/server/src/reviews/post-review.ts",
      "apps/server/src/server.ts",
    ]);
  });

  it("a removed member, or a member of another org, cannot post or preview", async () => {
    const carolSession = await sessionFor(B, carol, CAROL_GH);
    expect((await preview(carolSession, A.pullRequestId)).statusCode).toBe(404);
    const plan = (await preview(carolSession, B.pullRequestId)).json() as Preview;
    expect(plan.items).toEqual([]); // carol decided nothing in B
    const cross = await post(
      carolSession,
      A.pullRequestId,
      click(plan, { verdict: "approve", body: "" }),
    );
    expect(cross.statusCode).toBe(404);
    expect(github.reviews).toHaveLength(0);
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    expect((await preview(alice, B.pullRequestId)).statusCode).toBe(404);
    expect((await preview(alice, randomUUID())).statusCode).toBe(404);
    expect((await preview(alice, "not-a-uuid")).statusCode).toBe(400);
  });
});

describe("the P3-6 access check and the member's token", () => {
  it("a deny answers 404 like an unknown pull request, with nothing written and nothing posted; without the check, 503", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    expect((await preview(alice, A.pullRequestId)).statusCode).toBe(404);
    const denied = await post(alice, A.pullRequestId, click(plan));
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: "not_found" });
    expect(github.requests).toEqual([]);
    expect((await submissions(A)).rowCount).toBe(0);
    await app.close();
    app = build({ withoutAccessCheck: true });
    await app.ready();
    expect((await preview(alice, A.pullRequestId)).statusCode).toBe(503);
    const closed = await post(alice, A.pullRequestId, click(plan));
    expect(closed.statusCode).toBe(503);
    expect(closed.json()).toEqual({ error: "posting_unavailable" });
    expect(github.requests).toEqual([]);
  });

  it("GitHub's refusal fails the attempt, releases the items and tells the client; a fixed retry posts once", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    github.putPullRequest(REPO, { number: 847, headSha: HEAD, authorLogin: "alice" });
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const own = await post(alice, A.pullRequestId, click(plan, { verdict: "approve" }));
    expect(own.statusCode).toBe(502);
    expect(own.json()).toEqual({
      error: "post_failed",
      submissionId: expect.any(String),
      reason: "rejected",
    });
    expect((await submissions(A)).rows[0]).toMatchObject({
      status: "failed",
      error_code: "rejected",
    });
    // Released: the same list is offered again, and a corrected click posts exactly once.
    const again = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(again.contentSha256).toBe(plan.contentSha256);
    expect((await post(alice, A.pullRequestId, click(again))).statusCode).toBe(200);
    expect(github.reviews).toHaveLength(1);
    // A revoked token: GitHub answers 401; the attempt fails with that code.
    github.revokeUserToken(tokens["bob"]!);
    const bobSession = await sessionFor(A, bob, BOB_GH);
    const bobPlan = (await preview(bobSession, A.pullRequestId)).json() as Preview;
    const revoked = await post(
      bobSession,
      A.pullRequestId,
      click(bobPlan, { verdict: "comment", body: "x" }),
    );
    expect(revoked.statusCode).toBe(502);
    expect(revoked.json()).toMatchObject({ error: "post_failed", reason: "token_rejected" });
    tokens["bob"] = github.addUser({ id: BOB_GH, login: "bob" });
    await storeToken(A, bob, tokens["bob"]!);
  });

  it("no stored token (signed out elsewhere): refused before any attempt is recorded", async () => {
    const bobSession = await sessionFor(A, bob, BOB_GH);
    const plan = (await preview(bobSession, A.pullRequestId)).json() as Preview;
    await db.withOrg(A.orgId, (tx) => clearForgeToken(tx, bob));
    try {
      const res = await post(
        bobSession,
        A.pullRequestId,
        click(plan, { verdict: "comment", body: "x" }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "token_unavailable" });
      expect((await submissions(A)).rowCount).toBe(0);
      expect(github.requests).toEqual([]);
    } finally {
      await storeToken(A, bob, tokens["bob"]!);
    }
  });
});

describe("double-submit is impossible", () => {
  it("concurrent clicks with one key post exactly once; a second key on the same list is stale", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const one = click(plan);
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => post(alice, A.pullRequestId, one)),
    );
    const codes = answers.map((a) => a.statusCode).toSorted();
    expect(codes[0]).toBe(200);
    expect(github.reviews).toHaveLength(1);
    const reviewId = github.reviews[0]!.id;
    for (const a of answers) {
      if (a.statusCode === 200) expect(a.json()).toMatchObject({ status: "posted", reviewId });
      else expect(a.json()).toEqual({ error: "in_progress" });
    }
    // The same click again, later: the same answer, still one review.
    const later = await post(alice, A.pullRequestId, one);
    expect(later.json()).toMatchObject({ status: "posted", reviewId, repeated: true });
    // A fresh key against the list the person saw before posting: refused (already posted).
    const fresh = await post(alice, A.pullRequestId, click(plan));
    expect(fresh.json()).toEqual({ error: "stale" });
    expect(github.reviews).toHaveLength(1);
    expect((await submissions(A)).rowCount).toBe(1);
  });

  it("a lost answer is reconciled from GitHub after the timeout: found → posted once, never twice", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const one = click(plan);
    network = "lose_answer";
    const lost = await post(alice, A.pullRequestId, one);
    expect(lost.statusCode).toBe(502);
    expect(lost.json()).toEqual({ error: "post_unknown", submissionId: expect.any(String) });
    expect(github.reviews).toHaveLength(1); // GitHub did take it
    expect((await submissions(A)).rows[0]?.status).toBe("posting");
    network = "ok";
    // Too soon to know: the attempt stays in flight, nothing is posted again.
    expect((await post(alice, A.pullRequestId, one)).json()).toEqual({ error: "in_progress" });
    expect(((await preview(alice, A.pullRequestId)).json() as Preview).items).toEqual([]);
    // After the timeout the person's own reviews are read and the one we sent is found.
    await age(A);
    const settled = await post(alice, A.pullRequestId, one);
    expect(settled.statusCode).toBe(200);
    const reviewId = github.reviews[0]!.id;
    expect(settled.json()).toMatchObject({ status: "posted", reviewId, repeated: true });
    expect(github.reviews).toHaveLength(1);
    expect((await submissions(A)).rows[0]).toMatchObject({
      status: "posted",
      forge_review_id: String(reviewId),
    });
    const audit = await superuser.query(
      `select actor_type, actor_id from audit_events
        where org_id = $1 and action = 'review.posted' and metadata ->> 'submissionId' = $2`,
      [A.orgId, (lost.json() as { submissionId: string }).submissionId],
    );
    expect(audit.rows).toEqual([{ actor_type: "system", actor_id: "review_reconcile" }]);
  });

  it("a lost answer that never reached GitHub is released after the timeout and the click posts once", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const one = click(plan);
    network = "down";
    expect((await post(alice, A.pullRequestId, one)).json()).toMatchObject({
      error: "post_unknown",
    });
    expect(github.reviews).toHaveLength(0);
    network = "ok";
    await age(A);
    // The lost click is final for its key (the person is told), and the items are free again.
    const settled = await post(alice, A.pullRequestId, one);
    expect(settled.statusCode, settled.body).toBe(502);
    expect(settled.json()).toMatchObject({ error: "post_failed", reason: "lost" });
    expect(github.reviews).toHaveLength(0);
    const again = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(again.contentSha256).toBe(plan.contentSha256);
    const retried = await post(alice, A.pullRequestId, click(again));
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ status: "posted", repeated: false });
    expect(github.reviews).toHaveLength(1);
    const { rows } = await submissions(A);
    expect(rows.map((r) => [r.status, r.error_code])).toEqual([
      ["failed", "lost"],
      ["posted", null],
    ]);
  });

  it("the preview reports the attempt in flight and the latest attempt (review round 1, S4)", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(plan.inFlight).toBeNull();
    expect(plan.latestSubmission).toBeNull();
    const one = click(plan);
    network = "down";
    const lost = await post(alice, A.pullRequestId, one);
    const { submissionId } = lost.json() as { submissionId: string };
    const during = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(during.items).toEqual([]);
    expect(during.inFlight).toEqual({
      submissionId,
      status: "posting",
      verdict: "request_changes",
      draftCount: 2,
      commentCount: 1,
      reviewId: null,
      errorCode: null,
      createdAt: expect.any(String),
      finishedAt: null,
    });
    expect(during.latestSubmission?.submissionId).toBe(submissionId);
    // Settled as lost: no longer in flight, still the latest, with its code.
    network = "ok";
    await age(A);
    await post(alice, A.pullRequestId, one);
    const after = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(after.inFlight).toBeNull();
    expect(after.latestSubmission).toMatchObject({
      submissionId,
      status: "failed",
      errorCode: "lost",
    });
    expect(after.latestSubmission?.finishedAt).toEqual(expect.any(String));
    // Not content: no body text in the preview's attempt summaries.
    expect(JSON.stringify([after.inFlight, after.latestSubmission])).not.toMatch(/invite|inviter/);
  });

  it("a poster that refuses before any request is a definite failure, not a stuck attempt (review round 1, N1)", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    network = "bug";
    const res = await post(alice, A.pullRequestId, click(plan));
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "post_failed", reason: "invalid" });
    expect((await submissions(A)).rows[0]).toMatchObject({
      status: "failed",
      error_code: "invalid",
    });
    network = "ok";
    // Released at once: the next click (new key) posts.
    const again = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(again.inFlight).toBeNull();
    expect((await post(alice, A.pullRequestId, click(again))).statusCode).toBe(200);
    expect(github.reviews).toHaveLength(1);
  });

  it("reconciliation never adopts a review the person made by hand: state, time, body and comment count must all match (review round 1, S1)", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const one = click(plan, { verdict: "approve", body: "" });
    network = "down";
    expect((await post(alice, A.pullRequestId, one)).json()).toMatchObject({
      error: "post_unknown",
    });
    network = "ok";
    const decoy = (payload: Record<string, unknown>, submittedAt = new Date().toISOString()) =>
      github.putReview({
        repositoryId: REPO,
        number: 847,
        userId: ALICE_GH,
        userLogin: "alice",
        payload,
        submittedAt,
      });
    // An empty approval made by hand, with no inline comments (the attempt carried three).
    decoy({ event: "APPROVE", body: "", commit_id: HEAD, comments: [] });
    // A review with the right body and comments but the wrong state.
    decoy({ event: "COMMENT", body: "", commit_id: HEAD, comments: [{}, {}, {}] });
    // The right shape but submitted long before the attempt.
    decoy(
      { event: "APPROVE", body: "", commit_id: HEAD, comments: [{}, {}, {}] },
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    // The right shape on another commit.
    decoy({ event: "APPROVE", body: "", commit_id: "f".repeat(40), comments: [{}, {}, {}] });
    await age(A);
    expect((await post(alice, A.pullRequestId, one)).json()).toMatchObject({
      error: "post_failed",
      reason: "lost",
    });
    expect((await submissions(A)).rows[0]).toMatchObject({ status: "failed", error_code: "lost" });
    // The items were never posted, so they are offered again.
    expect(((await preview(alice, A.pullRequestId)).json() as Preview).items).toHaveLength(3);
  });

  it("reconciliation adopts exactly the matching review among decoys, and stays in flight when two match", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const one = click(plan);
    network = "lose_answer";
    const lost = await post(alice, A.pullRequestId, one);
    expect(lost.json()).toMatchObject({ error: "post_unknown" });
    const ours = github.reviews[0]!.id;
    network = "ok";
    const twin = { ...github.reviews[0]!.payload };
    github.putReview({
      repositoryId: REPO,
      number: 847,
      userId: ALICE_GH,
      userLogin: "alice",
      payload: { ...twin, event: "APPROVE" },
      submittedAt: new Date().toISOString(),
    });
    await age(A);
    expect((await post(alice, A.pullRequestId, one)).json()).toMatchObject({
      status: "posted",
      reviewId: ours,
      repeated: true,
    });
    expect(github.requests.filter((r) => r.path.endsWith("/comments"))).toHaveLength(1);

    // A second attempt with a true twin on GitHub: ambiguous, so it stays in flight.
    await reset();
    const plan2 = (await preview(alice, A.pullRequestId)).json() as Preview;
    const two = click(plan2);
    network = "lose_answer";
    await post(alice, A.pullRequestId, two);
    network = "ok";
    github.putReview({
      repositoryId: REPO,
      number: 847,
      userId: ALICE_GH,
      userLogin: "alice",
      payload: { ...github.reviews[0]!.payload },
      submittedAt: new Date().toISOString(),
    });
    await age(A);
    expect((await post(alice, A.pullRequestId, two)).json()).toEqual({ error: "in_progress" });
    expect((await submissions(A)).rows[0]?.status).toBe("posting");
    expect(lines.some((l) => l.includes('"reconcile_ambiguous"'))).toBe(true);
  });

  it("while GitHub cannot be asked, a lost attempt stays in flight (fail closed)", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    const one = click(plan);
    network = "down";
    await post(alice, A.pullRequestId, one);
    await age(A);
    expect((await post(alice, A.pullRequestId, one)).json()).toEqual({ error: "in_progress" });
    expect((await submissions(A)).rows[0]?.status).toBe("posting");
    expect(github.reviews).toHaveLength(0);
  });
});

describe("input and hygiene", () => {
  it("malformed clicks are 400; an empty comment review is refused", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    await db.withOrg(A.orgId, async (tx) => {
      await tx.query("delete from findings_state where analysis_id = $1", [A.analysisId]);
      await tx.query("delete from comments_pending where pull_request_id = $1", [A.pullRequestId]);
    });
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    expect(plan.items).toEqual([]);
    for (const bad of [
      click(plan, { idempotencyKey: "1" }),
      click(plan, { contentSha256: "zz" }),
      click(plan, { headSha: "A".repeat(40) }),
      click(plan, { verdict: "APPROVE" }),
      click(plan, { body: 1 }),
      click(plan, { body: "x".repeat(65_537) }),
      "x",
      [],
      null,
    ]) {
      const res = await post(alice, A.pullRequestId, bad);
      expect(res.statusCode, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    const empty = await post(
      alice,
      A.pullRequestId,
      click(plan, { verdict: "comment", body: " " }),
    );
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "invalid_request", reason: "empty_review" });
    expect(github.requests).toEqual([]);
    expect((await submissions(A)).rowCount).toBe(0);
  });

  it("logs carry ids, counts and codes only: no comment text, finding title, path, token or login", async () => {
    const alice = await sessionFor(A, A.memberId, ALICE_GH);
    const plan = (await preview(alice, A.pullRequestId)).json() as Preview;
    await post(alice, A.pullRequestId, click(plan));
    accessAnswer = { allowed: false, reason: "not_found", cached: false };
    await post(alice, A.pullRequestId, click(plan));
    const all = lines.join("\n");
    expect(all).toContain('"review posting"');
    for (const secret of [
      "Please validate the invite email",
      "Also log the inviter id",
      "invitations.ts",
      DOCUMENT.findings[0]!.title,
      tokens["alice"]!,
      "rocky_session",
      '"alice"',
    ]) {
      expect(all, secret).not.toContain(secret);
    }
    const posted = lines
      .map((l) => JSON.parse(l) as { review?: Record<string, unknown> })
      .find((l) => l.review?.["outcome"] === "posted");
    expect(posted?.review).toEqual({
      outcome: "posted",
      orgId: A.orgId,
      pullRequestId: A.pullRequestId,
      submissionId: expect.any(String),
      draftCount: 2,
      commentCount: 1,
      reviewId: github.reviews[0]!.id,
    });
    expect(ForgeReadError.name).toBe("ForgeReadError");
  });
});
