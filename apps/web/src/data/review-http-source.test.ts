import { describe, expect, it } from "vitest";
import {
  parseDraftRecord,
  parseOwnComment,
  parseReviewState,
  ReviewDataError,
} from "./review-data.js";
import { createHttpReviewSource, ReviewRequestError } from "./review-http-source.js";

/** P6-4 (ADR 0027): the drafts API client and the checks on what it returns. */

const ID = "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c";
const COMMENT = "0b2d4e6f-8a1c-4c3e-9a7f-6f1c2a9e1d4b";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

const fakeFetch = (answers: (call: Call) => { status: number; body?: unknown }) => {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    calls.push(call);
    const { status, body } = answers(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const draft = (over: Record<string, unknown> = {}) => ({
  findingId: "F1",
  state: "accepted",
  reason: null,
  edited: false,
  body: "AI text",
  agentPromptCopiedAt: null,
  updatedAt: "2026-10-25T12:00:00.000Z",
  ...over,
});

describe("http review source", () => {
  it("loads the review with cookies, no CSRF token needed for a read", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { drafts: [], comments: [] } }));
    const source = createHttpReviewSource({ fetch, csrfToken: () => Promise.reject(new Error()) });
    expect(await source.load(ID)).toEqual({ drafts: [], comments: [] });
    expect(calls[0]).toMatchObject({ url: `/api/analyses/${ID}/review`, method: "GET" });
    expect(calls[0]?.headers["x-rocky-csrf"]).toBeUndefined();
  });

  it("sends each action with the CSRF token, and reads 200 and 409 answers", async () => {
    let status = 200;
    const { fetch, calls } = fakeFetch(() => ({ status, body: { draft: draft() } }));
    const source = createHttpReviewSource({ fetch, csrfToken: async () => "tok" });
    expect(await source.decide(ID, "F1", { kind: "accept" })).toEqual({
      kind: "ok",
      draft: draft(),
    });
    await source.decide(ID, "F1", { kind: "edit", body: "mine" });
    await source.decide(ID, "F1", { kind: "dismiss", reason: "intentional" });
    await source.decide(ID, "F1", { kind: "undo" });
    await source.decide(ID, "F1", { kind: "send_to_agent" });
    expect(calls.map((c) => c.body)).toEqual([
      { action: "accept" },
      { action: "edit", body: "mine" },
      { action: "dismiss", reason: "intentional" },
      { action: "undo" },
      { action: "send_to_agent" },
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({ url: `/api/analyses/${ID}/drafts/F1`, method: "POST" });
      expect(call.headers["x-rocky-csrf"]).toBe("tok");
      expect(call.headers["content-type"]).toBe("application/json");
    }
    status = 409;
    expect((await source.decide(ID, "F1", { kind: "accept" })).kind).toBe("conflict");
  });

  it("adds and deletes own comments", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.method === "DELETE"
        ? { status: 204 }
        : { status: 201, body: { comment: { id: COMMENT, path: "a.ts", line: 3, body: "x" } } },
    );
    const source = createHttpReviewSource({ fetch, csrfToken: async () => "tok" });
    expect(await source.addComment(ID, { path: "a.ts", line: 3, body: "x" })).toMatchObject({
      id: COMMENT,
    });
    await source.deleteComment(ID, COMMENT);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /api/analyses/${ID}/comments`,
      `DELETE /api/analyses/${ID}/comments/${COMMENT}`,
    ]);
    expect(calls[0]?.body).toEqual({ path: "a.ts", line: 3, body: "x" });
  });

  it("throws on any other status, with the status only", async () => {
    const { fetch } = fakeFetch(() => ({ status: 503, body: { error: "secret detail" } }));
    const source = createHttpReviewSource({ fetch, csrfToken: async () => "tok" });
    for (const run of [
      () => source.load(ID),
      () => source.decide(ID, "F1", { kind: "accept" }),
      () => source.addComment(ID, { path: "a.ts", line: 1, body: "x" }),
      () => source.deleteComment(ID, COMMENT),
    ]) {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReviewRequestError);
      expect((error as ReviewRequestError).status).toBe(503);
      expect(String(error)).not.toContain("secret");
    }
  });

  it("asks the session for the CSRF token once, and again after a failed lookup", async () => {
    let sessions = 0;
    let fail = true;
    const { fetch } = fakeFetch((call) => {
      if (call.url === "/api/session") {
        sessions++;
        return fail ? { status: 500 } : { status: 200, body: { csrfToken: "fresh" } };
      }
      return { status: 200, body: { draft: draft() } };
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const source = createHttpReviewSource({ fetch });
      await expect(source.decide(ID, "F1", { kind: "accept" })).rejects.toThrow();
      fail = false;
      await source.decide(ID, "F1", { kind: "accept" });
      await source.decide(ID, "F1", { kind: "undo" });
      expect(sessions).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("parsing answers", () => {
  it("reads drafts in every state", () => {
    expect(parseDraftRecord(draft()).decision).toEqual({
      state: "accepted",
      edited: false,
      body: "AI text",
    });
    expect(
      parseDraftRecord(draft({ state: "dismissed", reason: "handled_elsewhere", body: null }))
        .decision,
    ).toEqual({ state: "dismissed", reason: "handled_elsewhere" });
    expect(
      parseDraftRecord(
        draft({ state: "draft", body: null, agentPromptCopiedAt: "2026-10-25T12:00:00.000Z" }),
      ),
    ).toEqual({
      findingId: "F1",
      decision: { state: "draft" },
      agentPromptCopiedAt: "2026-10-25T12:00:00.000Z",
    });
  });

  it("refuses malformed or inconsistent drafts with a fixed message", () => {
    for (const bad of [
      draft({ state: "posted" }),
      draft({ findingId: "../x" }),
      draft({ body: null }),
      draft({ state: "dismissed", reason: null, body: null }),
      draft({ state: "dismissed", reason: "free text", body: null }),
      draft({ body: "x".repeat(65_537) }),
      null,
    ]) {
      expect(() => parseDraftRecord(bad)).toThrow(ReviewDataError);
    }
  });

  it("reads comments and the whole review", () => {
    const comment = { id: COMMENT, path: "a.ts", line: 3, body: "x", createdAt: "z" };
    expect(parseOwnComment(comment)).toEqual({ id: COMMENT, path: "a.ts", line: 3, body: "x" });
    expect(() => parseOwnComment({ ...comment, line: 0 })).toThrow(ReviewDataError);
    expect(() => parseOwnComment({ ...comment, id: "c1" })).toThrow(ReviewDataError);
    const review = parseReviewState({ analysisId: ID, drafts: [draft()], comments: [comment] });
    expect(review.drafts.get("F1")?.decision.state).toBe("accepted");
    expect(review.comments).toHaveLength(1);
    expect(() => parseReviewState({ drafts: "x", comments: [] })).toThrow(ReviewDataError);
  });
});
