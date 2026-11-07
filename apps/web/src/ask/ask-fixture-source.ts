/**
 * Ask for the fixture PR (P9-2; development and tests only, loaded behind the fixture switch
 * like the other fixture sources). It answers like the server would, as raw answers that go
 * through the same checks, so every state of the panel can be shown and screenshotted:
 *
 *   ?ask=ready (default) | not-indexed | indexing | off | index-error | no-answer | error | slow
 *
 * `slow` never answers a question (the "Reading the code…" state). The answers are the POC's
 * mocked ones (design-poc/index.html, ANSWERS), with citations in the server's shape.
 */
import type { AskSource, RawAnswer } from "./ask-data.js";

export const ASK_SCENARIOS = [
  "ready",
  "not-indexed",
  "indexing",
  "off",
  "index-error",
  "no-answer",
  "error",
  "slow",
] as const;
export type AskScenario = (typeof ASK_SCENARIOS)[number];

export const askScenarioFromSearch = (search: string): AskScenario => {
  const value = new URLSearchParams(search).get("ask");
  return (ASK_SCENARIOS as readonly string[]).includes(value ?? "")
    ? (value as AskScenario)
    : "ready";
};

/** The commit the fixture index holds. */
export const FIXTURE_INDEXED_SHA = "5e0c8a9d27f14b6e93a1c4d8f0b2e7a6c3d9f141";

export const FIXTURE_SUGGESTED = [
  "Who calls acceptInvitation?",
  "Is this covered by tests?",
  "What does an attacker need to exploit F1?",
] as const;

const ANSWERS: readonly { match: RegExp; body: Record<string, unknown> }[] = [
  {
    match: /who calls|callers?/i,
    body: {
      answer:
        "Only one caller: the `POST /invitations/:token/accept` route. Nothing else in the indexed code calls `acceptInvitation`.",
      citations: [
        { path: "src/api/routes/invitations.ts", startLine: 18, endLine: 24 },
        { path: "src/auth/invitations.ts", startLine: 22, endLine: 31 },
      ],
    },
  },
  {
    match: /test|cover/i,
    body: {
      answer:
        "Partly. The happy path and expiry are tested. **Not tested:** reusing an accepted invite, the role override, and the permission check on create.",
      citations: [{ path: "src/auth/invitations.test.ts", startLine: 12, endLine: 40 }],
    },
  },
  {
    match: /attacker|exploit|F1/i,
    body: {
      answer:
        'Any valid invite link plus a signed-in account. Open the link, then send `POST /invitations/<token>/accept` with `{"role":"admin"}`: the role comes from the request body, not the invitation.',
      citations: [{ path: "src/auth/invitations.ts", startLine: 28, endLine: 28 }],
    },
  },
];

const FALLBACK = {
  answer:
    "The invitation is created in `createInvitation` and accepted in `acceptInvitation`; both run inside the org's transaction.",
  citations: [{ path: "src/auth/invitations.ts", startLine: 9, endLine: 31 }],
};

const later = <T>(ms: number, value: T, signal?: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

export const createFixtureAskSource = (scenario: AskScenario = "ready"): AskSource => ({
  index: async (_pull, { signal } = {}) => {
    const index =
      scenario === "not-indexed"
        ? { status: "not_indexed" }
        : scenario === "indexing"
          ? { status: "indexing" }
          : scenario === "off"
            ? { status: "off" }
            : { status: "ready", indexedSha: FIXTURE_INDEXED_SHA, updating: false };
    if (scenario === "index-error")
      return later(50, { status: 502, body: { error: "internal" } }, signal);
    return later(50, { status: 200, body: { index } }, signal);
  },
  ask: async (_pull, question, { signal } = {}): Promise<RawAnswer> => {
    if (scenario === "slow") return new Promise<RawAnswer>(() => undefined);
    if (scenario === "error")
      return later(
        300,
        { status: 502, body: { error: "model_unavailable", retryable: true } },
        signal,
      );
    if (scenario === "no-answer")
      return later(
        300,
        {
          status: 200,
          body: {
            status: "no_answer",
            reason: "model",
            note: "The indexed code does not show where invitations are sent; the mailer is not in the excerpts Rocky found.",
          },
        },
        signal,
      );
    const hit = ANSWERS.find((a) => a.match.test(question.question))?.body ?? FALLBACK;
    return later(
      300,
      { status: 200, body: { status: "answered", indexedSha: FIXTURE_INDEXED_SHA, ...hit } },
      signal,
    );
  },
});
