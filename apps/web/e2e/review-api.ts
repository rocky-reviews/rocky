import type { Page, Route } from "@playwright/test";
import {
  applyDraftAction,
  DRAFT,
  type DraftDecision,
  parseDraftAction,
} from "../../../packages/core/src/drafts.js";
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
 */

export const CSRF_TOKEN = "e2e-csrf-token";
/** pr-847's analysis id in the fixture source (`fixtureAnalysisId(847)`). */
export const PR_847_ANALYSIS = "00000000-0000-4000-8000-000000000847";

type Stored = { decision: DraftDecision; copiedAt: string | null };
type Comment = { id: string; path: string; line: number; body: string; createdAt: string };

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
};

const findings = new Map(pr847.findings.map((f) => [f.id, f]));

const wire = (findingId: string, s: Stored) => ({
  findingId,
  state: s.decision.state,
  reason: s.decision.state === "dismissed" ? s.decision.reason : null,
  edited: s.decision.state === "accepted" && s.decision.edited,
  body: s.decision.state === "accepted" ? s.decision.body : null,
  agentPromptCopiedAt: s.copiedAt,
  updatedAt: "2026-10-25T12:00:00.000Z",
});

const json = (route: Route, status: number, body?: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const mockReviewApi = async (page: Page): Promise<ReviewApi> => {
  const drafts = new Map<string, Map<string, Stored>>();
  const comments = new Map<string, Comment[]>();
  const requests: string[] = [];
  let failures = 0;
  let nextComment = 1;
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

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/session") {
      return json(route, 200, {
        authenticated: true,
        user: { id: "u1", forgeUserId: 1 },
        orgs: [],
        activeOrgId: null,
        csrfToken: CSRF_TOKEN,
        expiresAt: "2026-10-26T12:00:00.000Z",
        idleExpiresAt: "2026-10-25T20:00:00.000Z",
      });
    }
    const match = /^\/api\/analyses\/([0-9a-f-]{36})\/(review|drafts|comments)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    if (match === null) return json(route, 404, { error: "not_found" });
    const [, analysisId, kind, item] = match as unknown as [string, string, string, string?];
    if (method === "GET" && kind === "review") {
      return json(route, 200, {
        analysisId,
        drafts: [...draftsOf(analysisId)]
          .filter(([, s]) => s.decision.state !== "draft" || s.copiedAt !== null)
          .map(([id, s]) => wire(id, s)),
        comments: commentsOf(analysisId),
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
      const t = applyDraftAction(current.decision, action, finding);
      if (!t.ok) {
        return t.error === "invalid_body"
          ? json(route, 400, { error: "invalid_body" })
          : json(route, 409, { error: "invalid_transition", draft: wire(finding.id, current) });
      }
      const next = {
        decision: t.next,
        copiedAt: t.agentPromptCopied ? "2026-10-25T12:05:00.000Z" : current.copiedAt,
      };
      store.set(finding.id, next);
      return json(route, 200, { draft: wire(finding.id, next) });
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
      return json(route, 201, { comment });
    }
    if (method === "DELETE" && kind === "comments" && item !== undefined) {
      const list = commentsOf(analysisId);
      const at = list.findIndex((c) => c.id === item);
      if (at === -1) return json(route, 404, { error: "not_found" });
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
  };
};
