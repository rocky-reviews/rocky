import { describe, expect, it } from "vitest";
import {
  askPath,
  citationUrl,
  lineLabel,
  parseAskIndex,
  parseAskReply,
  retryAfterFromHeader,
  type RawAnswer,
} from "./ask-data.js";
import { createFixtureAskSource, FIXTURE_INDEXED_SHA } from "./ask-fixture-source.js";
import { selectionFrom } from "./selection.js";

/**
 * P9-2 (ADR 0041): what the Ask panel accepts from its source. A citation is a link only when
 * the page can build it from checked parts; anything else is dropped, never linked.
 */

const PULL = { owner: "acme", repo: "rocky-app", number: 847 };
const SHA = "a".repeat(40);
const ok = (body: unknown): RawAnswer => ({ status: 200, body });
const answered = (citations: unknown[], extra: Record<string, unknown> = {}) =>
  ok({ status: "answered", answer: "It is `accept`.", indexedSha: SHA, citations, ...extra });

describe("citationUrl", () => {
  it("links the cited lines at the indexed commit on GitHub", () => {
    expect(citationUrl(PULL, SHA, { path: "src/auth/invite.ts", startLine: 4, endLine: 9 })).toBe(
      `https://github.com/acme/rocky-app/blob/${SHA}/src/auth/invite.ts#L4-L9`,
    );
    expect(citationUrl(PULL, SHA, { path: "a.ts", startLine: 7, endLine: 7 })).toBe(
      `https://github.com/acme/rocky-app/blob/${SHA}/a.ts#L7`,
    );
  });

  it("encodes each path segment, so a name cannot add a query, a fragment or a segment", () => {
    expect(citationUrl(PULL, SHA, { path: "docs/a b#c?d%e.md", startLine: 1, endLine: 1 })).toBe(
      `https://github.com/acme/rocky-app/blob/${SHA}/docs/a%20b%23c%3Fd%25e.md#L1`,
    );
  });

  it("refuses anything it cannot build safely", () => {
    const c = { path: "src/a.ts", startLine: 1, endLine: 2 };
    for (const path of ["", "/etc/passwd", "a//b", "../x", "a/./b", "a/..", "a\\b", "a\nb", "a‮b"])
      expect(citationUrl(PULL, SHA, { ...c, path }), JSON.stringify(path)).toBeUndefined();
    expect(citationUrl(PULL, "HEAD", c)).toBeUndefined();
    expect(citationUrl(PULL, "A".repeat(40), c)).toBeUndefined();
    expect(citationUrl(PULL, SHA, { ...c, startLine: 0 })).toBeUndefined();
    expect(citationUrl(PULL, SHA, { ...c, startLine: 3 })).toBeUndefined();
    expect(citationUrl(PULL, SHA, { ...c, endLine: 1.5 })).toBeUndefined();
    expect(citationUrl({ ...PULL, owner: "evil.example/x" }, SHA, c)).toBeUndefined();
    expect(citationUrl({ ...PULL, repo: ".." }, SHA, c)).toBeUndefined();
  });
});

describe("parseAskIndex", () => {
  it("reads each state", () => {
    expect(
      parseAskIndex(ok({ index: { status: "ready", indexedSha: SHA, updating: true } })),
    ).toEqual({
      ok: true,
      index: { status: "ready", indexedSha: SHA, updating: true },
    });
    for (const status of ["indexing", "not_indexed", "off"] as const)
      expect(parseAskIndex(ok({ index: { status } }))).toEqual({ ok: true, index: { status } });
  });

  it("is a problem for refusals and for anything it does not understand", () => {
    expect(parseAskIndex({ status: 401, body: undefined })).toEqual({
      ok: false,
      problem: "signed_out",
    });
    expect(parseAskIndex({ status: 404, body: undefined })).toEqual({
      ok: false,
      problem: "not_found",
    });
    expect(parseAskIndex({ status: 500, body: undefined })).toEqual({
      ok: false,
      problem: "failed",
    });
    for (const body of [
      undefined,
      { index: { status: "ready", indexedSha: "x", updating: false } },
      { index: { status: "ready", indexedSha: SHA } },
      { index: { status: "weird" } },
      { index: [] },
    ])
      expect(parseAskIndex(ok(body)).ok).toBe(false);
  });
});

describe("parseAskReply", () => {
  it("keeps an answer and builds each citation's link itself", () => {
    expect(
      parseAskReply(
        PULL,
        answered([{ path: "src/a.ts", startLine: 2, endLine: 4, url: "https://evil.example" }]),
      ),
    ).toEqual({
      kind: "answered",
      answer: "It is `accept`.",
      indexedSha: SHA,
      citations: [
        {
          path: "src/a.ts",
          startLine: 2,
          endLine: 4,
          url: `https://github.com/acme/rocky-app/blob/${SHA}/src/a.ts#L2-L4`,
        },
      ],
    });
  });

  it("drops a citation it cannot link; with none left, the answer is not shown", () => {
    const reply = parseAskReply(
      PULL,
      answered([
        { path: "../x", startLine: 1, endLine: 1 },
        { path: "ok.ts", startLine: 3, endLine: 1 },
        { path: "ok.ts", startLine: "1", endLine: 2 },
        "nope",
        { path: "ok.ts", startLine: 1, endLine: 1 },
      ]),
    );
    expect(reply.kind === "answered" && reply.citations.map((c) => c.path)).toEqual(["ok.ts"]);
    expect(parseAskReply(PULL, answered([{ path: "../x", startLine: 1, endLine: 1 }]))).toEqual({
      kind: "no_answer",
      reason: "uncited",
      note: null,
    });
  });

  it("reads no good answer, with the model's note only for `model`", () => {
    expect(
      parseAskReply(PULL, ok({ status: "no_answer", reason: "model", note: "Missing." })),
    ).toEqual({
      kind: "no_answer",
      reason: "model",
      note: "Missing.",
    });
    expect(
      parseAskReply(PULL, ok({ status: "no_answer", reason: "no_context", note: "x" })),
    ).toEqual({
      kind: "no_answer",
      reason: "no_context",
      note: null,
    });
    expect(parseAskReply(PULL, ok({ status: "no_answer", reason: "other" }))).toEqual({
      kind: "error",
      problem: "failed",
    });
  });

  it("maps every refusal to a fixed problem", () => {
    const cases: [number, unknown, string][] = [
      [401, undefined, "signed_out"],
      [404, { error: "not_found" }, "not_found"],
      [429, { error: "rate_limited" }, "rate_limited"],
      [409, { error: "not_indexed" }, "not_indexed"],
      [409, { error: "indexing" }, "indexing"],
      [502, { error: "model_unavailable", retryable: true }, "model_unavailable"],
      [502, { error: "answer_failed", reason: "refused" }, "answer_failed"],
      [502, { error: "forge_unavailable" }, "forge_unavailable"],
      [503, { error: "ask_unavailable" }, "unavailable"],
      [400, { error: "invalid_question" }, "invalid_question"],
      [400, { error: "constructor" }, "failed"],
      [500, undefined, "failed"],
    ];
    for (const [status, body, problem] of cases)
      expect(parseAskReply(PULL, { status, body }), `${status}`).toEqual({
        kind: "error",
        problem,
      });
  });

  it("P9-3: a 429 says whose limit it was, and how long to wait only when that is sane", () => {
    const limited = (body: unknown, retryAfterSeconds?: number) =>
      parseAskReply(
        PULL,
        retryAfterSeconds === undefined
          ? { status: 429, body }
          : { status: 429, body, retryAfterSeconds },
      );
    expect(limited({ error: "rate_limited", limit: "member" }, 42)).toEqual({
      kind: "error",
      problem: "rate_limited",
      retryAfterSeconds: 42,
    });
    expect(limited({ error: "rate_limited", limit: "org" }, 1800)).toEqual({
      kind: "error",
      problem: "org_rate_limited",
      retryAfterSeconds: 1800,
    });
    // An older server, or another route: no `limit` means the member's own.
    expect(limited({ error: "rate_limited" })).toEqual({ kind: "error", problem: "rate_limited" });
    expect(limited(undefined)).toEqual({ kind: "error", problem: "rate_limited" });
    for (const limit of ["ORG", "organisation", 1, null, ["org"]])
      expect(limited({ error: "rate_limited", limit }), JSON.stringify(limit)).toEqual({
        kind: "error",
        problem: "rate_limited",
      });
    // The wait is shown only as a whole number of seconds from one to a day.
    expect(limited({ limit: "org" }, 1)).toHaveProperty("retryAfterSeconds", 1);
    expect(limited({ limit: "org" }, 86_400)).toHaveProperty("retryAfterSeconds", 86_400);
    for (const bad of [0, -5, 1.5, 86_401, Number.NaN, Number.POSITIVE_INFINITY])
      expect(limited({ limit: "org" }, bad), `${bad}`).toEqual({
        kind: "error",
        problem: "org_rate_limited",
      });
    // Only a limit carries a wait, whatever the source read.
    expect(
      parseAskReply(PULL, {
        status: 502,
        body: { error: "model_unavailable" },
        retryAfterSeconds: 5,
      }),
    ).toEqual({ kind: "error", problem: "model_unavailable" });
  });

  it("P9-3: reads a retry-after header's seconds, never its HTTP-date form", () => {
    expect(retryAfterFromHeader("42")).toBe(42);
    expect(retryAfterFromHeader("1")).toBe(1);
    expect(retryAfterFromHeader("86400")).toBe(86_400);
    for (const value of [
      null,
      "",
      "0",
      "86401",
      "100000",
      "-1",
      "+42",
      "4e1",
      "1.5",
      " 42",
      "42s",
      "Wed, 21 Oct 2026 07:28:00 GMT",
    ])
      expect(retryAfterFromHeader(value), JSON.stringify(value)).toBeUndefined();
  });

  it("refuses a malformed answer", () => {
    for (const body of [
      null,
      { status: "answered" },
      { status: "answered", answer: "", indexedSha: SHA, citations: [] },
      { status: "answered", answer: "x", indexedSha: "main", citations: [] },
      { status: "answered", answer: "x", indexedSha: SHA, citations: {} },
      { status: "answered", answer: "x".repeat(4001), indexedSha: SHA, citations: [] },
    ])
      expect(parseAskReply(PULL, ok(body))).toEqual({ kind: "error", problem: "failed" });
  });
});

describe("labels, paths and the selection", () => {
  it("labels a citation by its lines", () => {
    expect(lineLabel({ path: "a.ts", startLine: 3, endLine: 3 })).toBe("a.ts:3");
    expect(lineLabel({ path: "a.ts", startLine: 3, endLine: 9 })).toBe("a.ts:3–9");
    expect(askPath({ owner: "acme", repo: "rocky-app", number: 847 })).toBe(
      "/api/repos/acme/rocky-app/pulls/847/ask",
    );
  });

  it("builds a selection from the rows it touches, or nothing", () => {
    expect(selectionFrom("src/a.ts", [12, 10, Number.NaN, 11], "  a()\n b() ")).toEqual({
      path: "src/a.ts",
      startLine: 10,
      endLine: 12,
      text: "a()\n b()",
    });
    expect(selectionFrom(null, [1], "a")).toBeNull();
    expect(selectionFrom("a.ts", [], "a")).toBeNull();
    expect(selectionFrom("a.ts", [Number.NaN], "a")).toBeNull();
    expect(selectionFrom("a.ts", [1], "   ")).toBeNull();
    expect(selectionFrom("a.ts", [1], "x".repeat(5000))?.text).toHaveLength(4000);
  });
});

describe("the fixture source", () => {
  it("answers through the same checks, with links at the fixture's commit", async () => {
    const source = createFixtureAskSource();
    const index = parseAskIndex(await source.index(PULL));
    expect(index).toEqual({
      ok: true,
      index: { status: "ready", indexedSha: FIXTURE_INDEXED_SHA, updating: false },
    });
    const reply = parseAskReply(
      PULL,
      await source.ask(PULL, { question: "Who calls acceptInvitation?" }),
    );
    expect(reply.kind).toBe("answered");
    if (reply.kind === "answered")
      expect(reply.citations[0]?.url).toBe(
        `https://github.com/acme/rocky-app/blob/${FIXTURE_INDEXED_SHA}/src/api/routes/invitations.ts#L18-L24`,
      );
    for (const [scenario, kind] of [
      ["no-answer", "no_answer"],
      ["error", "error"],
    ] as const) {
      const r = parseAskReply(
        PULL,
        await createFixtureAskSource(scenario).ask(PULL, { question: "q" }),
      );
      expect(r.kind).toBe(kind);
    }
  });

  it("P9-3: has a scenario for each limit, with its wait", async () => {
    for (const [scenario, problem, retryAfterSeconds] of [
      ["rate-limited", "rate_limited", 42],
      ["org-rate-limited", "org_rate_limited", 1800],
    ] as const)
      expect(
        parseAskReply(PULL, await createFixtureAskSource(scenario).ask(PULL, { question: "q" })),
        scenario,
      ).toEqual({ kind: "error", problem, retryAfterSeconds });
  });
});
