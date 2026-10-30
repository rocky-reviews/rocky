import { ForgeReadError, type ReviewSubmission } from "@rocky-reviews/core";
import { beforeEach, describe, expect, it } from "vitest";
import { githubEndpoints } from "./app-manifest.js";
import {
  createGitHubReviewPoster,
  MAX_REVIEW_LIST_PAGES,
  MAX_REVIEW_RESPONSE_BYTES,
  REVIEW_POST_TIMEOUT_MS,
} from "./reviews.js";
import { fakeGitHubApi, FIXTURE_APP_ID, testAppKeys, type FakeGitHubApi } from "./testing.js";

/**
 * P3-5 (ADR 0026): the GitHub review poster against the fake. The user's token goes into the
 * authorization header of exactly these requests; documented refusals are outcomes; anything
 * else throws `ForgeReadError`, which the caller treats as "unknown" (never "not posted").
 */

const { api } = githubEndpoints({});
const INSTALLATION = 4242;
const REPO = 77;
const ALICE = 9101;
const HEAD = "a".repeat(40);
const PR = { fullName: "acme/api", number: 847 };

let github: FakeGitHubApi;
let token: string;
const credential = () => ({ token, userId: ALICE });
const poster = (options: { fetch?: typeof fetch; timeoutMs?: number } = {}) =>
  createGitHubReviewPoster({ api, fetch: options.fetch ?? github.fetch, ...options });

const review = (over: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  headSha: HEAD,
  verdict: "comment",
  body: "Looks fine overall.",
  comments: [
    { path: "src/invite.ts", line: 12, startLine: null, body: "Validate the email first." },
    { path: "src/mailer.ts", line: 40, startLine: 38, body: "**Retries**\n\nBound these." },
  ],
  ...over,
});

beforeEach(() => {
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: testAppKeys().publicKey });
  github.install(INSTALLATION, { id: 9001, login: "acme", type: "Organization" });
  github.addRepository(INSTALLATION, { id: REPO, fullName: PR.fullName });
  github.putPullRequest(REPO, { number: PR.number, headSha: HEAD, authorLogin: "octo-author" });
  token = github.addUser({ id: ALICE, login: "octo-dev" });
  github.setPermission(ALICE, REPO, "write");
});

describe("postReview", () => {
  it("posts one review with the exact body, verdict, commit and comments, as the user", async () => {
    const outcome = await poster().postReview(credential(), PR, review());
    expect(outcome.posted).toBe(true);
    if (!outcome.posted) return;
    expect(outcome.review.id).toBe(880011);
    expect(outcome.review.headSha).toBe(HEAD);
    expect(outcome.review.body).toBe("Looks fine overall.");
    expect(outcome.review.submittedAt).toBeInstanceOf(Date);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.userId).toBe(ALICE);
    expect(github.reviews[0]?.payload).toEqual({
      commit_id: HEAD,
      event: "COMMENT",
      body: "Looks fine overall.",
      comments: [
        { path: "src/invite.ts", line: 12, side: "RIGHT", body: "Validate the email first." },
        {
          path: "src/mailer.ts",
          line: 40,
          side: "RIGHT",
          start_line: 38,
          start_side: "RIGHT",
          body: "**Retries**\n\nBound these.",
        },
      ],
    });
    expect(github.requests).toEqual([
      { method: "POST", path: "/repos/acme/api/pulls/847/reviews", authorized: true },
    ]);
  });

  it("maps every verdict to GitHub's event", async () => {
    for (const [verdict, event] of [
      ["approve", "APPROVE"],
      ["request_changes", "REQUEST_CHANGES"],
      ["comment", "COMMENT"],
    ] as const) {
      const outcome = await poster().postReview(credential(), PR, review({ verdict }));
      expect(outcome.posted, verdict).toBe(true);
      expect(github.reviews.at(-1)?.payload["event"]).toBe(event);
    }
    const approval = await poster().postReview(
      credential(),
      PR,
      review({ verdict: "approve", body: "", comments: [] }),
    );
    expect(approval.posted).toBe(true);
    expect(github.reviews.at(-1)?.payload).toEqual({
      commit_id: HEAD,
      event: "APPROVE",
      body: "",
      comments: [],
    });
  });

  it("sends the token only in the authorization header, and refuses a token that is not a bearer value", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      });
      return github.fetch(input, init);
    };
    await poster({ fetch: spy }).postReview(credential(), PR, review());
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(request?.url).not.toContain(token);
    expect(request?.body).not.toContain(token);
    expect(request?.headers["content-type"]).toMatch(/^application\/json/);
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28");

    for (const bad of ["", "short", "has space in it 0123456789", "x\r\ny".padEnd(20, "z")]) {
      const outcome = await poster().postReview({ token: bad, userId: ALICE }, PR, review());
      expect(outcome, JSON.stringify(bad)).toEqual({ posted: false, reason: "token_rejected" });
    }
    expect(github.reviews).toHaveLength(1);
  });

  it("answers GitHub's refusals as outcomes: 401 token_rejected, 403 forbidden, 404 not_found, 422 rejected", async () => {
    github.revokeUserToken(token);
    expect(await poster().postReview(credential(), PR, review())).toEqual({
      posted: false,
      reason: "token_rejected",
    });
    token = github.addUser({ id: ALICE, login: "octo-dev" });
    github.failRoute("review", 403);
    expect(await poster().postReview(credential(), PR, review())).toEqual({
      posted: false,
      reason: "forbidden",
    });
    // No access to the repository: GitHub's JSON 404.
    github.setPermission(ALICE, REPO, null);
    expect(await poster().postReview(credential(), PR, review())).toEqual({
      posted: false,
      reason: "not_found",
    });
    github.setPermission(ALICE, REPO, "write");
    expect(await poster().postReview(credential(), { ...PR, number: 848 }, review())).toEqual({
      posted: false,
      reason: "not_found",
    });
    // Approving one's own pull request: GitHub validates and refuses (422).
    github.putPullRequest(REPO, { number: 849, headSha: HEAD, authorLogin: "octo-dev" });
    expect(
      await poster().postReview(
        credential(),
        { ...PR, number: 849 },
        review({ verdict: "approve" }),
      ),
    ).toEqual({ posted: false, reason: "rejected" });
    expect(github.reviews).toHaveLength(0);
  });

  it("throws ForgeReadError on anything else: server errors, rate limits, timeouts, network, bad bodies", async () => {
    for (const status of [500, 502, 429, 301, 201]) {
      github.failRoute("review", status);
      await expect(poster().postReview(credential(), PR, review())).rejects.toMatchObject({
        name: "ForgeReadError",
        reason: "http_status",
        status,
      });
    }
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    await expect(
      poster({ fetch: hanging, timeoutMs: 20 }).postReview(credential(), PR, review()),
    ).rejects.toMatchObject({ reason: "timeout" });
    const offline: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(
      poster({ fetch: offline }).postReview(credential(), PR, review()),
    ).rejects.toMatchObject({ reason: "network" });

    const bodies: [string, string][] = [
      ["application/json", "not json"],
      ["text/html", "{}"],
      ["application/json", JSON.stringify({ id: "x" })],
      ["application/json", JSON.stringify({ id: 1, user: { id: ALICE } })],
      ["application/json", "x".repeat(MAX_REVIEW_RESPONSE_BYTES + 1)],
    ];
    for (const [type, body] of bodies) {
      const odd: typeof fetch = async () =>
        new Response(body, { status: 200, headers: { "content-type": type } });
      await expect(
        poster({ fetch: odd }).postReview(credential(), PR, review()),
        `${type} ${body.slice(0, 20)}`,
      ).rejects.toMatchObject({ reason: "invalid_response" });
    }
    // Under the server's 30 s request timeout (review round 1, N2), long enough for GitHub.
    expect(REVIEW_POST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(REVIEW_POST_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("refuses to follow a redirect (a renamed repository is not followed with the user's token)", async () => {
    const redirecting: typeof fetch = async (_input, init) => {
      if (init?.redirect !== "error") throw new Error("redirects must be refused");
      throw new TypeError("fetch failed: redirect");
    };
    await expect(
      poster({ fetch: redirecting }).postReview(credential(), PR, review()),
    ).rejects.toMatchObject({ reason: "network" });
  });

  it("refuses a malformed pull request, user or review before any request (caller bugs, not GitHub's answer)", async () => {
    const calls = () => github.requests.length;
    for (const pr of [
      { fullName: "acme", number: 1 },
      { fullName: "acme/../api", number: 1 },
      { fullName: "acme/api", number: 0 },
      { fullName: "acme/api", number: 1.5 },
      { fullName: "acme/api", number: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      await expect(poster().postReview(credential(), pr, review())).rejects.toThrow(
        /invalid pull request/,
      );
    }
    await expect(poster().postReview({ token, userId: 0 }, PR, review())).rejects.toThrow(
      /invalid user/,
    );
    await expect(
      poster().postReview(
        credential(),
        PR,
        review({ comments: [{ path: "../x", line: 1, startLine: null, body: "b" }] }),
      ),
    ).rejects.toThrow(/invalid review/);
    await expect(
      poster().postReview(credential(), PR, review({ verdict: "comment", body: "", comments: [] })),
    ).rejects.toThrow(/invalid review/);
    expect(calls()).toBe(0);
  });

  it("encodes the path segments of the URL and JSON-encodes hostile content", async () => {
    const hostile = review({
      body: 'Looks fine" , "event":"APPROVE\n\u0000 <script>',
      comments: [{ path: "a b/c#d?.ts", line: 1, startLine: null, body: '{"x":1}' }],
    });
    const outcome = await poster().postReview(
      credential(),
      { fullName: "acme/api", number: 847 },
      hostile,
    );
    expect(outcome.posted).toBe(true);
    expect(github.reviews[0]?.payload["body"]).toBe(hostile.body);
    expect(github.reviews[0]?.payload["event"]).toBe("COMMENT");
    expect((github.reviews[0]?.payload["comments"] as { path: string }[])[0]?.path).toBe(
      "a b/c#d?.ts",
    );
  });
});

describe("listOwnReviews", () => {
  it("lists the user's own reviews on the pull request, newest first, and nobody else's", async () => {
    const bobToken = github.addUser({ id: 9102, login: "octo-bob" });
    github.setPermission(9102, REPO, "write");
    await poster().postReview({ token: bobToken, userId: 9102 }, PR, review({ body: "bob's" }));
    await poster().postReview(credential(), PR, review({ body: "first" }));
    await poster().postReview(credential(), PR, review({ body: "second", verdict: "approve" }));
    const own = await poster().listOwnReviews(credential(), PR);
    expect(own.map((r) => r.body)).toEqual(["second", "first"]);
    expect(own.map((r) => r.state)).toEqual(["approve", "comment"]);
    expect(own[0]?.headSha).toBe(HEAD);
    expect(own[0]?.id).toBeGreaterThan(own[1]?.id ?? 0);
    expect(github.requests.at(-1)).toEqual({
      method: "GET",
      path: "/repos/acme/api/pulls/847/reviews",
      authorized: true,
    });
  });

  const plant = (count: number) => {
    for (let i = 0; i < count; i++) {
      github.putReview({
        repositoryId: REPO,
        number: PR.number,
        userId: i % 2 === 0 ? ALICE : 9102,
        userLogin: i % 2 === 0 ? "octo-dev" : "octo-bob",
        payload: { event: "COMMENT", body: `r${i}`, commit_id: HEAD },
        submittedAt: "2026-10-30T10:00:00Z",
      });
    }
  };

  it("pages through up to MAX_REVIEW_LIST_PAGES pages of 100", async () => {
    plant(150);
    const own = await poster().listOwnReviews(credential(), PR);
    expect(own).toHaveLength(75);
    expect(github.requests.filter((r) => r.method === "GET")).toHaveLength(2);
    expect(MAX_REVIEW_LIST_PAGES).toBeGreaterThanOrEqual(2);
  });

  it("throws instead of answering a partial list when every page was full (GitHub lists oldest first: the newest could be unseen)", async () => {
    plant(MAX_REVIEW_LIST_PAGES * 100);
    await expect(poster().listOwnReviews(credential(), PR)).rejects.toMatchObject({
      reason: "invalid_response",
    });
    // Exactly a multiple of the page size with one more page: still read to the short page.
    github.reviews.length = 0;
    plant(200);
    expect(await poster().listOwnReviews(credential(), PR)).toHaveLength(100);
    expect(github.requests.filter((r) => r.method === "GET")).toHaveLength(
      MAX_REVIEW_LIST_PAGES + 3,
    );
  });

  it("maps every state and answers null for one it does not know", async () => {
    for (const [state, expected] of [
      ["APPROVED", "approve"],
      ["CHANGES_REQUESTED", "request_changes"],
      ["COMMENTED", "comment"],
      ["PENDING", null],
      ["DISMISSED", null],
    ] as const) {
      const odd: typeof fetch = async () =>
        new Response(
          JSON.stringify([{ id: 5, user: { id: ALICE }, body: "", state, commit_id: HEAD }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const [own] = await poster({ fetch: odd }).listOwnReviews(credential(), PR);
      expect(own?.state, state).toBe(expected);
    }
  });

  it("answers an empty list only for GitHub's 404; refusals and failures throw", async () => {
    expect(await poster().listOwnReviews(credential(), { ...PR, number: 999 })).toEqual([]);
    github.revokeUserToken(token);
    await expect(poster().listOwnReviews(credential(), PR)).rejects.toBeInstanceOf(ForgeReadError);
    token = github.addUser({ id: ALICE, login: "octo-dev" });
    github.failRoute("reviews", 500);
    await expect(poster().listOwnReviews(credential(), PR)).rejects.toMatchObject({
      reason: "http_status",
      status: 500,
    });
    const odd: typeof fetch = async () =>
      new Response(JSON.stringify([{ id: "nope" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await expect(poster({ fetch: odd }).listOwnReviews(credential(), PR)).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });
});

describe("countReviewComments", () => {
  it("counts the inline comments of one review, paging, and throws for an unknown review or a failure", async () => {
    await poster().postReview(credential(), PR, review());
    const id = github.reviews[0]!.id;
    expect(await poster().countReviewComments(credential(), PR, id)).toBe(2);
    await poster().postReview(credential(), PR, review({ verdict: "approve", comments: [] }));
    expect(await poster().countReviewComments(credential(), PR, github.reviews[1]!.id)).toBe(0);
    const many = Array.from({ length: 100 }, (_, i) => ({
      path: "a.ts",
      line: i + 1,
      startLine: null,
      body: "x",
    }));
    await poster().postReview(credential(), PR, review({ comments: many }));
    expect(await poster().countReviewComments(credential(), PR, github.reviews[2]!.id)).toBe(100);
    expect(github.requests.filter((r) => r.path.endsWith("/comments"))).toHaveLength(4);
    await expect(poster().countReviewComments(credential(), PR, 424242)).rejects.toMatchObject({
      reason: "http_status",
      status: 404,
    });
    github.failRoute("reviews", 500);
    await expect(poster().countReviewComments(credential(), PR, id)).rejects.toMatchObject({
      reason: "http_status",
      status: 500,
    });
    await expect(poster().countReviewComments(credential(), PR, 0)).rejects.toThrow(
      /invalid review id/,
    );
    await expect(
      poster().countReviewComments({ token: "x", userId: ALICE }, PR, id),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("construction", () => {
  it("requires an https API base ending in /", () => {
    expect(() => createGitHubReviewPoster({ api: new URL("http://api.github.com/") })).toThrow(
      /https/,
    );
    expect(() => createGitHubReviewPoster({ api: new URL("https://ghe.example/api/v3") })).toThrow(
      /end with \//,
    );
    expect(createGitHubReviewPoster({ api }).kind).toBe("github");
  });
});
