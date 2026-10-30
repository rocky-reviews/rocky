import { describe, expect, it } from "vitest";
import {
  parseReviewPreview,
  PostingDataError,
  previewOutcome,
  submitOutcome,
} from "./posting-data.js";
import { createHttpPostingSource, PostingRequestError } from "./posting-http-source.js";

/** P6-6 (ADR 0031): the posting API client and the checks on what the server answers. */

const PR = "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c";
const SUB = "0b2d4e6f-8a1c-4c3e-9a7f-6f1c2a9e1d4b";
/** The fixture click: a uuid used as the idempotency key. */
const CLICK_ID = "1b2d4e6f-8a1c-4c3e-9a7f-6f1c2a9e1d4b";
const HEAD = "9b4e1d7a3c5f2e8b6d0a4c7e1f3b5d9a2c6e8f4b";
const DIGEST = "a".repeat(64);

const item = (over: Record<string, unknown> = {}) => ({
  kind: "draft",
  id: SUB,
  path: "src/auth/invitations.ts",
  line: 28,
  startLine: null,
  body: "**Title**\n\nbody @someone https://evil.example ![x](https://evil.example/x.png)",
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  submissionId: SUB,
  status: "posted",
  verdict: "approve",
  draftCount: 1,
  commentCount: 0,
  reviewId: 77,
  errorCode: null,
  createdAt: "2026-10-25T12:00:00.000Z",
  finishedAt: "2026-10-25T12:00:01.000Z",
  ...over,
});

const preview = (over: Record<string, unknown> = {}) => ({
  pullRequestId: PR,
  number: 847,
  headSha: HEAD,
  revisionKnown: true,
  contentSha256: DIGEST,
  items: [item()],
  inFlight: null,
  latestSubmission: summary(),
  ...over,
});

describe("parsing the preview", () => {
  it("keeps every item's body exactly as the server sent it (the markdown GitHub will get)", () => {
    const parsed = parseReviewPreview(preview());
    expect(parsed.items).toEqual([item()]);
    expect(parsed.latestSubmission).toEqual(summary());
    expect(parsed.inFlight).toBeNull();
    expect(parsed.contentSha256).toBe(DIGEST);
  });

  it("refuses malformed answers with a message that names no value", () => {
    const bad = [
      preview({ contentSha256: "abc" }),
      preview({ headSha: "x".repeat(40) }),
      preview({ items: [item({ body: "" })] }),
      preview({ items: [item({ line: 0 })] }),
      preview({ items: [item({ kind: "verdict" })] }),
      preview({ items: [item({ id: "not-a-uuid" })] }),
      preview({ items: Array.from({ length: 101 }, () => item()) }),
      preview({ latestSubmission: summary({ status: "done" }) }),
      preview({ latestSubmission: summary({ verdict: "merge" }) }),
      preview({ latestSubmission: summary({ errorCode: "Secret Value!" }) }),
      preview({ items: "none" }),
      null,
      "x",
    ];
    for (const input of bad) {
      let error: unknown;
      try {
        parseReviewPreview(input);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(input)?.slice(0, 80)).toBeInstanceOf(PostingDataError);
      expect(String(error)).not.toContain("evil");
      expect(String(error)).not.toContain("Secret");
    }
  });

  it("turns statuses into outcomes: 200 parsed, 401, 404, 503, anything else an error", () => {
    expect(previewOutcome({ status: 200, body: preview() }).kind).toBe("ok");
    expect(previewOutcome({ status: 200, body: { nope: 1 } })).toEqual({
      kind: "error",
      status: 200,
    });
    expect(previewOutcome({ status: 401, body: {} })).toEqual({ kind: "signed_out" });
    expect(previewOutcome({ status: 404, body: {} })).toEqual({ kind: "not_found" });
    expect(previewOutcome({ status: 503, body: {} })).toEqual({ kind: "unavailable" });
    expect(previewOutcome({ status: 500, body: {} })).toEqual({ kind: "error", status: 500 });
  });
});

describe("the click's answer (ADR 0026 §6)", () => {
  it("200 posted, with the repeat flag", () => {
    expect(
      submitOutcome({
        status: 200,
        body: { status: "posted", submissionId: SUB, reviewId: 77, repeated: true },
      }),
    ).toEqual({ kind: "posted", submissionId: SUB, reviewId: 77, repeated: true });
    // A 200 that does not say "posted" is never taken as a success.
    expect(submitOutcome({ status: 200, body: { status: "ok" } })).toEqual({
      kind: "error",
      status: 200,
    });
  });

  it("409 refusals by fixed code; an unknown code is an error", () => {
    for (const code of [
      "stale",
      "head_moved",
      "in_progress",
      "key_reused",
      "no_revision",
      "token_unavailable",
    ]) {
      expect(submitOutcome({ status: 409, body: { error: code } })).toEqual({
        kind: "refused",
        reason: code,
      });
    }
    expect(submitOutcome({ status: 409, body: { error: "something_else" } })).toEqual({
      kind: "error",
      status: 409,
    });
    expect(submitOutcome({ status: 409, body: { error: "<b>html</b>" } })).toEqual({
      kind: "error",
      status: 409,
    });
  });

  it("400 invalid with its reason, 502 post_failed with its reason, 502 post_unknown", () => {
    expect(
      submitOutcome({ status: 400, body: { error: "invalid_request", reason: "empty_review" } }),
    ).toEqual({ kind: "invalid", reason: "empty_review" });
    expect(submitOutcome({ status: 400, body: { error: "invalid_request" } })).toEqual({
      kind: "invalid",
      reason: "invalid_request",
    });
    expect(
      submitOutcome({ status: 502, body: { error: "post_failed", reason: "rejected" } }),
    ).toEqual({ kind: "post_failed", reason: "rejected" });
    expect(submitOutcome({ status: 502, body: { error: "post_unknown" } })).toEqual({
      kind: "post_unknown",
    });
    // A reason that is not a fixed code is never shown.
    expect(
      submitOutcome({ status: 502, body: { error: "post_failed", reason: "GitHub said: x" } }),
    ).toEqual({ kind: "error", status: 502 });
  });

  it("401, 404, 503 and the rest", () => {
    expect(submitOutcome({ status: 401, body: undefined })).toEqual({ kind: "signed_out" });
    expect(submitOutcome({ status: 404, body: { error: "not_found" } })).toEqual({
      kind: "not_found",
    });
    expect(submitOutcome({ status: 503, body: {} })).toEqual({ kind: "unavailable" });
    expect(submitOutcome({ status: 500, body: "oops" })).toEqual({ kind: "error", status: 500 });
  });
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

const fakeFetch = (answers: (call: Call) => { status: number; body?: unknown; text?: string }) => {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    calls.push(call);
    const { status, body, text } = answers(call);
    return new Response(text ?? (body === undefined ? null : JSON.stringify(body)), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

describe("http posting source", () => {
  it("reads the preview with cookies and no CSRF token", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: preview() }));
    const source = createHttpPostingSource({
      fetch,
      csrfToken: () => Promise.reject(new Error("not needed")),
    });
    expect(await source.preview(PR)).toEqual({ status: 200, body: preview() });
    expect(calls[0]).toMatchObject({ url: `/api/pull-requests/${PR}/review`, method: "GET" });
    expect(calls[0]?.headers["x-rocky-csrf"]).toBeUndefined();
  });

  it("posts the click with the CSRF token and exactly the documented fields", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { status: "posted", submissionId: SUB, reviewId: 1, repeated: false },
    }));
    const source = createHttpPostingSource({ fetch, csrfToken: async () => "tok" });
    const input = {
      idempotencyKey: CLICK_ID,
      contentSha256: DIGEST,
      headSha: HEAD,
      verdict: "approve" as const,
      body: "Looks good.",
    };
    const answer = await source.submit(PR, { ...input, extra: "ignored" } as typeof input);
    expect(answer.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: `/api/pull-requests/${PR}/review`, method: "POST" });
    expect(calls[0]?.headers["x-rocky-csrf"]).toBe("tok");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual(input);
  });

  it("hands back any status with its JSON body, or no body when it is not JSON", async () => {
    const { fetch } = fakeFetch((call) =>
      call.method === "POST"
        ? { status: 502, text: "<html>bad gateway</html>" }
        : { status: 404, body: { error: "not_found" } },
    );
    const source = createHttpPostingSource({ fetch, csrfToken: async () => "tok" });
    expect(await source.preview(PR)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(
      await source.submit(PR, {
        idempotencyKey: CLICK_ID,
        contentSha256: DIGEST,
        headSha: HEAD,
        verdict: "comment",
        body: "",
      }),
    ).toEqual({ status: 502, body: undefined });
  });

  it("asks the session for the CSRF token once, and again after a failed lookup", async () => {
    let sessions = 0;
    let fail = true;
    const { fetch } = fakeFetch((call) => {
      if (call.url === "/api/session") {
        sessions++;
        return fail ? { status: 500 } : { status: 200, body: { csrfToken: "fresh" } };
      }
      return { status: 409, body: { error: "stale" } };
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const source = createHttpPostingSource({ fetch });
      const input = {
        idempotencyKey: CLICK_ID,
        contentSha256: DIGEST,
        headSha: HEAD,
        verdict: "comment" as const,
        body: "x",
      };
      await expect(source.submit(PR, input)).rejects.toThrow();
      fail = false;
      await source.submit(PR, input);
      await source.submit(PR, input);
      expect(sessions).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("a signed-out session is a 401 error without any answer text", async () => {
    const { fetch } = fakeFetch((call) =>
      call.url === "/api/session" ? { status: 401 } : { status: 200, body: {} },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const source = createHttpPostingSource({ fetch });
      const error = await source
        .submit(PR, {
          idempotencyKey: CLICK_ID,
          contentSha256: DIGEST,
          headSha: HEAD,
          verdict: "comment",
          body: "x",
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PostingRequestError);
      expect((error as PostingRequestError).status).toBe(401);
    } finally {
      globalThis.fetch = original;
    }
  });
});
