import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import {
  applyDraftAction,
  composePostedComment,
  DRAFT,
  type DraftDecision,
  parseDraftAction,
} from "../../../packages/core/src/drafts.js";
import {
  canonicalReviewPlan,
  isReviewVerdict,
  type ReviewPlanItem,
  type ReviewVerdict,
  validateReviewSubmission,
} from "../../../packages/core/src/review-posting.js";
import pr847 from "../../../packages/schema/fixtures/pr-847.json" with { type: "json" };

/**
 * P6-4: the drafts API (ADR 0027) for the e2e and visual suites. The page runs its real HTTP
 * client (`createHttpReviewSource`); Playwright answers its requests from this store, which
 * lives in the test (Node), not in the page. A reload therefore starts a fresh page that can
 * only show what it reads back over HTTP: "refresh keeps state" exercises the client's write and
 * read paths end to end. The server's own persistence is tested on Postgres in
 * `apps/server/src/reviews/routes.db.test.ts`.
 *
 * It answers like the server: the same transitions (core `applyDraftAction`), 409 with the
 * current state for a refused one, and 403 unless the CSRF token from `/api/session` is sent.
 *
 * P6-6: also the posting API (ADR 0026) for pr-847: `GET …/review` builds the plan from this
 * store exactly as the server does (accepted drafts as core `composePostedComment`, own
 * comments, minus what an attempt carries; digest of core `canonicalReviewPlan`), and `POST`
 * refuses a wrong digest or head (`stale`, `head_moved`), repeats an answer for a key it has
 * seen, refuses while an attempt is in flight, and otherwise records the review "GitHub"
 * received (`posted()`). A draft or comment an attempt carries is `posted` in the drafts
 * answer and refuses changes with 409 `already_posted`, as P3-5's boundary fix does.
 */

export const CSRF_TOKEN = "e2e-csrf-token";
/** pr-847's analysis id in the fixture source (`fixtureAnalysisId(847)`). */
export const PR_847_ANALYSIS = "00000000-0000-4000-8000-000000000847";
/** pr-847's pull request id in the fixture source (`fixturePullRequestId(847)`). */
export const PR_847_PULL_REQUEST = "00000000-0000-4000-8001-000000000847";
export const PR_847_HEAD = "9b4e1d7a3c5f2e8b6d0a4c7e1f3b5d9a2c6e8f4b";
export const ME = { login: "dana-k", orgId: "00000000-0000-4000-8002-000000000001" };

type Stored = { decision: DraftDecision; copiedAt: string | null };
type Comment = { id: string; path: string; line: number; body: string; createdAt: string };
type Posted = "posting" | "posted";

/** What "GitHub" received: one review, as the server would send it. */
export type PostedReview = {
  readonly id: number;
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  readonly body: string;
  readonly comments: readonly {
    path: string;
    line: number;
    startLine: number | null;
    body: string;
  }[];
};

type Submission = {
  id: string;
  key: string;
  contentSha256: string;
  headSha: string;
  verdict: ReviewVerdict;
  body: string;
  items: ReviewPlanItem[];
  status: Posted | "failed";
  reviewId: number | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  answer: { status: number; body: unknown };
};

export type ReviewApi = {
  /** Every request the page made, as `METHOD path`. */
  readonly requests: string[];
  /** The decision stored for a pr-847 finding. */
  decision(findingId: string): DraftDecision;
  comments(): readonly Comment[];
  /** Stores a decision for a pr-847 finding, as another tab would have. */
  set(findingId: string, decision: DraftDecision): void;
  /** Makes the next `n` state-changing requests fail with 503. */
  failNext(n: number): void;
  /** Holds every load of the review until the returned function is called. */
  holdLoads(): () => void;
  /** Makes every load of the review fail with 503. */
  failLoads(): void;
  /** P6-6: the plan as the server would build it now (what the modal must show). */
  plan(): { headSha: string; contentSha256: string; items: ReviewPlanItem[] };
  /** The reviews "GitHub" received, in order. */
  posted(): readonly PostedReview[];
  /** Every attempt recorded (a scripted answer records none), with its key. */
  submissions(): readonly {
    key: string;
    contentSha256: string;
    verdict: ReviewVerdict;
    body: string;
  }[];
  /** Every POST …/review the page made, as sent (before any answer). */
  clicks(): readonly { key: unknown; contentSha256: unknown; headSha: unknown; verdict: unknown }[];
  /** The next POST answers with this, recording nothing (then back to normal). */
  scriptSubmit(answer: { status: number; body: unknown }): void;
  /** Holds every POST until the returned function is called. */
  holdSubmits(): () => void;
  /** Moves the pull request's head: the next plan is for the new commit. */
  setHead(sha: string): void;
  /** Marks a finding's accepted draft, or a comment, as carried by an attempt (another tab posted). */
  markPosted(target: { findingId: string } | { commentId: string }, status?: Posted): void;
  /** An attempt still in flight, as after a lost answer. */
  addInFlight(): void;
};

const findings = new Map(pr847.findings.map((f) => [f.id, f]));

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const uuid = (n: number, group: string) =>
  `00000000-0000-4000-${group}-${String(n).padStart(12, "0")}`;
/** A stable id per finding for its draft item (the server's: the `findings_state` row id). */
const draftItemId = (findingId: string) => uuid(Number(findingId.replace(/\D/g, "")) || 0, "8003");

const wire = (findingId: string, s: Stored, posted: Posted | null) => ({
  findingId,
  state: s.decision.state,
  reason: s.decision.state === "dismissed" ? s.decision.reason : null,
  edited: s.decision.state === "accepted" && s.decision.edited,
  body: s.decision.state === "accepted" ? s.decision.body : null,
  agentPromptCopiedAt: s.copiedAt,
  updatedAt: "2026-10-25T12:00:00.000Z",
  posted,
});

const json = (route: Route, status: number, body?: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const mockReviewApi = async (page: Page): Promise<ReviewApi> => {
  const drafts = new Map<string, Map<string, Stored>>();
  const comments = new Map<string, Comment[]>();
  const requests: string[] = [];
  let failures = 0;
  let loadsFail = false;
  let loadsHeld: Promise<void> | null = null;
  let submitsHeld: Promise<void> | null = null;
  let nextComment = 1;
  // P6-6: the posting side.
  let head = PR_847_HEAD;
  const carried = new Map<string, Posted>(); // `draft:<findingId>` or `comment:<id>`
  const submissions: Submission[] = [];
  const github: PostedReview[] = [];
  const clicks: { key: unknown; contentSha256: unknown; headSha: unknown; verdict: unknown }[] = [];
  let scripted: { status: number; body: unknown } | null = null;
  let nextReview = 1;
  let clock = Date.parse("2026-10-25T12:10:00.000Z");

  const draftsOf = (id: string) => {
    const found = drafts.get(id) ?? new Map<string, Stored>();
    drafts.set(id, found);
    return found;
  };
  const commentsOf = (id: string) => {
    const found = comments.get(id) ?? [];
    comments.set(id, found);
    return found;
  };
  const carriedOf = (kind: "draft" | "comment", id: string) => carried.get(`${kind}:${id}`) ?? null;

  /** The plan as `loadReviewPlan` builds it: document order, then own comments by creation. */
  const plan = () => {
    const items: ReviewPlanItem[] = [];
    const store = draftsOf(PR_847_ANALYSIS);
    for (const finding of pr847.findings) {
      const s = store.get(finding.id);
      if (s === undefined || s.decision.state !== "accepted") continue;
      if (carriedOf("draft", finding.id) !== null) continue;
      const { start, end } = finding.range;
      items.push({
        kind: "draft",
        id: draftItemId(finding.id),
        path: finding.path,
        line: end,
        startLine: start === end ? null : start,
        body: composePostedComment(finding, { body: s.decision.body }),
      });
    }
    for (const c of commentsOf(PR_847_ANALYSIS)) {
      if (carriedOf("comment", c.id) !== null) continue;
      items.push({
        kind: "comment",
        id: c.id,
        path: c.path,
        line: c.line,
        startLine: null,
        body: c.body,
      });
    }
    return { headSha: head, items, contentSha256: sha256(canonicalReviewPlan(head, items)) };
  };

  const summary = (s: Submission | undefined) =>
    s === undefined
      ? null
      : {
          submissionId: s.id,
          status: s.status,
          verdict: s.verdict,
          draftCount: s.items.filter((i) => i.kind === "draft").length,
          commentCount: s.items.filter((i) => i.kind === "comment").length,
          reviewId: s.reviewId,
          errorCode: s.errorCode,
          createdAt: s.createdAt,
          finishedAt: s.finishedAt,
        };

  const carry = (items: readonly ReviewPlanItem[], status: Posted) => {
    for (const item of items) {
      const key =
        item.kind === "draft"
          ? `draft:${[...findings.keys()].find((id) => draftItemId(id) === item.id) ?? ""}`
          : `comment:${item.id}`;
      carried.set(key, status);
    }
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/session") {
      return json(route, 200, {
        authenticated: true,
        user: { id: "u1", forgeUserId: 1 },
        orgs: [
          {
            id: ME.orgId,
            login: "acme",
            memberId: "00000000-0000-4000-8002-000000000002",
            memberLogin: ME.login,
            role: "member",
          },
        ],
        activeOrgId: ME.orgId,
        csrfToken: CSRF_TOKEN,
        expiresAt: "2026-10-26T12:00:00.000Z",
        idleExpiresAt: "2026-10-25T20:00:00.000Z",
      });
    }

    // P6-6: the posting API (P3-5), for pr-847 only.
    const posting = /^\/api\/pull-requests\/([0-9a-f-]{36})\/review$/.exec(url.pathname);
    if (posting !== null) {
      const [, pullRequestId] = posting as unknown as [string, string];
      if (pullRequestId !== PR_847_PULL_REQUEST) return json(route, 404, { error: "not_found" });
      if (method === "GET") {
        const current = plan();
        return json(route, 200, {
          pullRequestId,
          number: 847,
          headSha: current.headSha,
          revisionKnown: true,
          contentSha256: current.contentSha256,
          items: current.items,
          inFlight: summary(submissions.find((s) => s.status === "posting")),
          latestSubmission: summary(submissions.at(-1)),
        });
      }
      if (method !== "POST") return json(route, 404, { error: "not_found" });
      if (request.headers()["x-rocky-csrf"] !== CSRF_TOKEN)
        return json(route, 403, { error: "csrf" });
      const sent = request.postDataJSON() as Record<string, unknown> | null;
      clicks.push({
        key: sent?.["idempotencyKey"],
        contentSha256: sent?.["contentSha256"],
        headSha: sent?.["headSha"],
        verdict: sent?.["verdict"],
      });
      if (submitsHeld !== null) await submitsHeld;
      if (scripted !== null) {
        const answer = scripted;
        scripted = null;
        return json(route, answer.status, answer.body);
      }
      const body = request.postDataJSON() as Record<string, unknown> | null;
      const key = body?.["idempotencyKey"];
      const digest = body?.["contentSha256"];
      const headSha = body?.["headSha"];
      const verdict = body?.["verdict"];
      const text = body?.["body"];
      if (
        typeof key !== "string" ||
        !UUID.test(key) ||
        typeof digest !== "string" ||
        typeof headSha !== "string" ||
        !isReviewVerdict(verdict) ||
        typeof text !== "string"
      )
        return json(route, 400, { error: "invalid_request" });
      const earlier = submissions.find((s) => s.key === key);
      if (earlier !== undefined) return json(route, earlier.answer.status, earlier.answer.body);
      const current = plan();
      if (current.headSha !== headSha) return json(route, 409, { error: "head_moved" });
      if (current.contentSha256 !== digest) return json(route, 409, { error: "stale" });
      const review = {
        headSha,
        verdict,
        body: text,
        comments: current.items.map((i) => ({
          path: i.path,
          line: i.line,
          startLine: i.startLine,
          body: i.body,
        })),
      };
      const valid = validateReviewSubmission(review);
      if (!valid.ok) return json(route, 400, { error: "invalid_request", reason: valid.reason });
      if (submissions.some((s) => s.status === "posting"))
        return json(route, 409, { error: "in_progress" });
      const id = uuid(submissions.length + 1, "8004");
      const reviewId = nextReview++;
      const answer = {
        status: 200,
        body: { status: "posted", submissionId: id, reviewId, repeated: false },
      };
      submissions.push({
        id,
        key,
        contentSha256: digest,
        headSha,
        verdict,
        body: text,
        items: current.items,
        status: "posted",
        reviewId,
        errorCode: null,
        createdAt: new Date(clock).toISOString(),
        finishedAt: new Date(clock + 1000).toISOString(),
        answer,
      });
      carry(current.items, "posted");
      github.push({ id: reviewId, ...review });
      return json(route, answer.status, answer.body);
    }

    const match = /^\/api\/analyses\/([0-9a-f-]{36})\/(review|drafts|comments)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    if (match === null) return json(route, 404, { error: "not_found" });
    const [, analysisId, kind, item] = match as unknown as [string, string, string, string?];
    const posted = (findingId: string) =>
      analysisId === PR_847_ANALYSIS ? carriedOf("draft", findingId) : null;
    if (method === "GET" && kind === "review") {
      if (loadsHeld !== null) await loadsHeld;
      if (loadsFail) return json(route, 503, { error: "internal" });
      return json(route, 200, {
        analysisId,
        drafts: [...draftsOf(analysisId)]
          .filter(([, s]) => s.decision.state !== "draft" || s.copiedAt !== null)
          .map(([id, s]) => wire(id, s, posted(id))),
        comments: commentsOf(analysisId).map((c) => ({
          ...c,
          posted: analysisId === PR_847_ANALYSIS ? carriedOf("comment", c.id) : null,
        })),
      });
    }
    if (request.headers()["x-rocky-csrf"] !== CSRF_TOKEN)
      return json(route, 403, { error: "csrf" });
    if (failures > 0) {
      failures--;
      return json(route, 503, { error: "internal" });
    }
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (method === "POST" && kind === "drafts" && item !== undefined) {
      const finding = findings.get(decodeURIComponent(item));
      if (finding === undefined) return json(route, 404, { error: "not_found" });
      const action = parseDraftAction(body);
      if (action === null) return json(route, 400, { error: "invalid_action" });
      const store = draftsOf(analysisId);
      const current = store.get(finding.id) ?? { decision: DRAFT, copiedAt: null };
      if (posted(finding.id) !== null)
        return json(route, 409, {
          error: "already_posted",
          draft: wire(finding.id, current, posted(finding.id)),
        });
      const t = applyDraftAction(current.decision, action, finding);
      if (!t.ok) {
        return t.error === "invalid_body"
          ? json(route, 400, { error: "invalid_body" })
          : json(route, 409, {
              error: "invalid_transition",
              draft: wire(finding.id, current, null),
            });
      }
      const next = {
        decision: t.next,
        copiedAt: t.agentPromptCopied ? "2026-10-25T12:05:00.000Z" : current.copiedAt,
      };
      store.set(finding.id, next);
      return json(route, 200, { draft: wire(finding.id, next, null) });
    }
    if (method === "POST" && kind === "comments" && item === undefined) {
      const comment: Comment = {
        id: `00000000-0000-4000-8000-${String(nextComment++).padStart(12, "0")}`,
        path: String(body?.["path"]),
        line: Number(body?.["line"]),
        body: String(body?.["body"]).trim(),
        createdAt: "2026-10-25T12:05:00.000Z",
      };
      commentsOf(analysisId).push(comment);
      return json(route, 201, { comment: { ...comment, posted: null } });
    }
    if (method === "DELETE" && kind === "comments" && item !== undefined) {
      const list = commentsOf(analysisId);
      const at = list.findIndex((c) => c.id === item);
      if (at === -1) return json(route, 404, { error: "not_found" });
      if (analysisId === PR_847_ANALYSIS && carriedOf("comment", item) !== null)
        return json(route, 409, { error: "already_posted" });
      list.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    return json(route, 404, { error: "not_found" });
  });

  return {
    requests,
    decision: (findingId) => draftsOf(PR_847_ANALYSIS).get(findingId)?.decision ?? DRAFT,
    comments: () => commentsOf(PR_847_ANALYSIS),
    set: (findingId, decision) => {
      const store = draftsOf(PR_847_ANALYSIS);
      store.set(findingId, { decision, copiedAt: store.get(findingId)?.copiedAt ?? null });
    },
    failNext: (n) => {
      failures = n;
    },
    holdLoads: () => {
      let release!: () => void;
      loadsHeld = new Promise((resolve) => (release = resolve));
      return () => {
        loadsHeld = null;
        release();
      };
    },
    failLoads: () => {
      loadsFail = true;
    },
    plan,
    posted: () => github,
    submissions: () =>
      submissions.map((s) => ({
        key: s.key,
        contentSha256: s.contentSha256,
        verdict: s.verdict,
        body: s.body,
      })),
    clicks: () => clicks,
    scriptSubmit: (answer) => {
      scripted = answer;
    },
    holdSubmits: () => {
      let release!: () => void;
      submitsHeld = new Promise((resolve) => (release = resolve));
      return () => {
        submitsHeld = null;
        release();
      };
    },
    setHead: (sha) => {
      head = sha;
    },
    markPosted: (target, status = "posted") => {
      carried.set(
        "findingId" in target ? `draft:${target.findingId}` : `comment:${target.commentId}`,
        status,
      );
    },
    addInFlight: () => {
      clock += 1000;
      submissions.push({
        id: uuid(submissions.length + 1, "8004"),
        key: uuid(900 + submissions.length, "8005"),
        contentSha256: sha256("x"),
        headSha: head,
        verdict: "comment",
        body: "",
        items: [],
        status: "posting",
        reviewId: null,
        errorCode: null,
        createdAt: new Date(clock).toISOString(),
        finishedAt: null,
        answer: { status: 502, body: { error: "post_unknown" } },
      });
    },
  };
};
