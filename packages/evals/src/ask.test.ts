import { ASK_LABELS, LlmCallError, type LlmRoles } from "@rocky-reviews/core";
import { scriptedRoles, type Script } from "@rocky-reviews/core/testing";
import { describe, expect, it } from "vitest";
import { askFakeScript, LEXICAL_SPACE, lexicalEmbedder, words } from "./ask/fake.js";
import { ASK_QUESTIONS } from "./ask/questions.js";
import { ASK_REPO, ASK_REPO_PROVENANCE, askRepoText } from "./ask/repo.js";
import { ASK_EVAL_K, askRepoChunks, runAskEval } from "./ask/run.js";
import { ASK_MIN_VALID_RATE, scoreAsk, scoreQuestion, type AskRunResult } from "./ask/score.js";

/**
 * P9-2: the Ask eval. Its repository and questions are consistent, the scorer counts a question
 * only when every citation it gave is valid, and the run goes through core's `answerQuestion`, so
 * a citation outside what the model was shown is caught exactly as in production.
 */

const roles = (script: Script): LlmRoles => scriptedRoles(script).roles;

const run = (script: Script, extra: Partial<Parameters<typeof runAskEval>[0]> = {}) =>
  runAskEval({
    llm: roles(script),
    embedding: lexicalEmbedder(),
    space: LEXICAL_SPACE,
    capped: () => false,
    gate: "guard",
    ...extra,
  });

describe("the repository and the questions", () => {
  it("are synthetic, and every target is inside its file", () => {
    expect(ASK_REPO_PROVENANCE).toMatch(/^Synthetic, written for Rocky/);
    expect(ASK_QUESTIONS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(ASK_QUESTIONS.map((q) => q.id)).size).toBe(ASK_QUESTIONS.length);
    for (const q of ASK_QUESTIONS) {
      expect(q.targets.length, q.id).toBeGreaterThan(0);
      for (const t of q.targets) {
        const lines = ASK_REPO[t.path];
        expect(lines, `${q.id} ${t.path}`).toBeDefined();
        expect(t.start).toBeGreaterThanOrEqual(1);
        expect(t.end).toBeGreaterThanOrEqual(t.start);
        expect(t.end, q.id).toBeLessThanOrEqual(lines?.length ?? 0);
      }
    }
  });

  it("targets name the code that answers (spot checks)", () => {
    const at = (path: string, line: number) => ASK_REPO[path]?.[line - 1] ?? "";
    expect(at("src/auth/password.ts", 9)).toContain("function hashPassword");
    expect(at("src/auth/password.ts", 15)).toContain("function verifyPassword");
    expect(at("src/auth/password.ts", 20)).toContain("timingSafeEqual");
    expect(at("src/auth/session.ts", 22)).toContain("function revokeSession");
    expect(at("src/billing/invoice.ts", 13)).toContain("function applyDiscount");
    expect(at("src/billing/webhook.ts", 7)).toContain("function verifySignature");
    expect(at("src/jobs/retry.ts", 7)).toContain("function withRetry");
    expect(at("src/db/tenancy.ts", 7)).toContain("function withTenant");
    expect(at("src/api/routes.ts", 9)).toContain("verifySession");
    const selection = ASK_QUESTIONS.find((q) => q.selection !== undefined)?.selection;
    expect(selection?.text).toContain("timingSafeEqual");
    expect(() => askRepoText("nope.ts")).toThrow(RangeError);
  });

  it("are cut into function-level chunks by the indexer's tree-sitter chunker", async () => {
    const chunks = await askRepoChunks();
    expect(chunks.length).toBeGreaterThan(Object.keys(ASK_REPO).length);
    const session = chunks.filter((c) => c.path === "src/auth/session.ts");
    expect(session.some((c) => c.start <= 22 && c.end >= 25 && c.start > 9)).toBe(true);
    for (const c of chunks) expect(c.input.startsWith(`${c.path}\n`)).toBe(true);
  });
});

describe("the scorer", () => {
  const result = (over: Partial<AskRunResult> = {}): AskRunResult => ({
    id: "q01-x",
    status: "answer",
    reason: null,
    valid: [{ path: "a.ts", start: 3, end: 4 }],
    dropped: 0,
    excerpts: 2,
    ...over,
  });
  const targets = [{ path: "a.ts", start: 4, end: 9 }];

  it("counts a question only when it is answered with valid citations and no invalid one", () => {
    expect(scoreQuestion(result(), targets)).toMatchObject({
      validlyCited: true,
      targetHit: true,
      validCitations: 1,
      invalidCitations: 0,
    });
    expect(scoreQuestion(result({ dropped: 1 }), targets).validlyCited).toBe(false);
    expect(scoreQuestion(result({ valid: [] }), targets).validlyCited).toBe(false);
    for (const status of ["no_answer", "failed", "capped"] as const)
      expect(scoreQuestion(result({ status }), targets).validlyCited).toBe(false);
    expect(
      scoreQuestion(result({ valid: [{ path: "a.ts", start: 10, end: 12 }] }), targets).targetHit,
    ).toBe(false);
    expect(
      scoreQuestion(result({ valid: [{ path: "b.ts", start: 4, end: 4 }] }), targets).targetHit,
    ).toBe(false);
  });

  it("gates at 90% of questions; 9 of 10 passes, 8 of 10 does not", () => {
    expect(ASK_MIN_VALID_RATE).toBe(0.9);
    const of = (good: number, total: number) =>
      scoreAsk(
        Array.from({ length: total }, (_, i) =>
          scoreQuestion(result({ dropped: i < good ? 0 : 1 }), targets),
        ),
        "guard",
      );
    expect(of(9, 10)).toMatchObject({ validlyCited: 9, validRate: 0.9, pass: true });
    expect(of(8, 10)).toMatchObject({ validRate: 0.8, pass: false });
    expect(of(10, 10).citationValidity).toBe(1);
    expect(of(8, 10).citationValidity).toBeCloseTo(10 / 12);
    expect(scoreAsk([], "guard")).toMatchObject({ validRate: 0, pass: false, citationValidity: 1 });
  });

  it("on_target (live) also needs 90% of questions validly cited on a target range", () => {
    // 10 questions, all validly cited; `onTarget` of them cite the answering lines.
    const of = (onTarget: number, gate: "guard" | "on_target") =>
      scoreAsk(
        Array.from({ length: 10 }, (_, i) =>
          scoreQuestion(
            result({
              valid: [{ path: "a.ts", start: i < onTarget ? 5 : 20, end: i < onTarget ? 6 : 21 }],
            }),
            targets,
          ),
        ),
        gate,
      );
    expect(of(9, "on_target")).toMatchObject({
      validRate: 1,
      onTarget: 9,
      onTargetRate: 0.9,
      pass: true,
    });
    expect(of(8, "on_target")).toMatchObject({ validRate: 1, onTargetRate: 0.8, pass: false });
    // The guard gate does not look at targets.
    expect(of(0, "guard")).toMatchObject({ onTargetRate: 0, pass: true });
    // On target but with an invalid citation too does not count.
    const mixed = scoreAsk(
      [scoreQuestion(result({ valid: [{ path: "a.ts", start: 5, end: 5 }], dropped: 1 }), targets)],
      "on_target",
    );
    expect(mixed).toMatchObject({ targetHits: 1, onTarget: 0, pass: false });
  });
});

describe("the run", () => {
  it("--fake: every question answered with valid citations, half or more on target", async () => {
    const result = await run(askFakeScript);
    expect(result).toMatchObject({
      status: "done",
      questions: ASK_QUESTIONS.length,
      validlyCited: ASK_QUESTIONS.length,
      invalidCitations: 0,
      pass: true,
    });
    expect(result.gate).toBe("guard");
    // Target hits measure the bag-of-words fake here, not a model: reported, not gated.
    expect(result.onTargetRate).toBeGreaterThanOrEqual(0.5);
    expect(result.embeddingTokens).toBeGreaterThan(0);
    expect(result.chunks).toBeGreaterThan(0);
  });

  it("the model sees the question, the selection and the code as untrusted parts only", async () => {
    const { roles: llm, calls } = scriptedRoles(askFakeScript);
    await runAskEval({
      llm,
      embedding: lexicalEmbedder(),
      space: LEXICAL_SPACE,
      capped: () => false,
      gate: "guard",
    });
    // The eval shows ASK_EVAL_K excerpts, fewer than production's 8 (retrieval must choose).
    for (const call of calls)
      expect(call.labels.filter((l) => l === ASK_LABELS.code).length).toBeLessThanOrEqual(
        ASK_EVAL_K,
      );
    const withSelection = calls.find((c) => c.part(ASK_LABELS.selection) !== undefined);
    expect(withSelection?.part(ASK_LABELS.question)).toBe(
      "Is this comparison safe against timing attacks?",
    );
    for (const call of calls) {
      expect(call.role).toBe("ask");
      expect(call.instructions.text).not.toContain("timingSafeEqual");
    }
  });

  it("a citation outside what the model was shown fails its question (core's guard)", async () => {
    // Cites a real file of the repository, at lines no excerpt showed.
    const liar: Script = () => ({
      value: {
        answered: true,
        answer: "See the retry loop.",
        citations: [{ path: "src/jobs/retry.ts", start: 900, end: 901 }],
      },
    });
    const result = await run(liar);
    expect(result).toMatchObject({ validlyCited: 0, answered: 0, pass: false });
    expect(result.invalidCitations).toBe(ASK_QUESTIONS.length);
    expect(result.results.every((r) => r.status === "no_answer" && r.reason === "uncited")).toBe(
      true,
    );
  });

  it("one bad citation among good ones still fails the question", async () => {
    const mixed: Script = (call) => {
      const good = askFakeScript(call) as { value: { citations: unknown[] } };
      return {
        value: {
          ...good.value,
          citations: [...good.value.citations, { path: "src/x.ts", start: 1, end: 1 }],
        },
      };
    };
    const result = await run(mixed);
    expect(result).toMatchObject({ answered: ASK_QUESTIONS.length, validlyCited: 0 });
    expect(result.citationValidity).toBeCloseTo(0.5);
  });

  it("refusals, call errors and the cap are recorded by code", async () => {
    const refused = await run(() => ({ status: "refused" }));
    expect(refused.results.every((r) => r.status === "failed" && r.reason === "refused")).toBe(
      true,
    );
    const down = await run(() => ({ error: new LlmCallError("server_error") }));
    expect(down.results[0]).toMatchObject({ status: "failed", reason: "server_error" });
    let calls = 0;
    const capped = await run(askFakeScript, { capped: () => ++calls > 3 });
    expect(capped.status).toBe("capped");
    expect(capped.results.filter((r) => r.status === "capped").length).toBeGreaterThan(0);
  });

  it("the model declining is a no-answer, not a pass", async () => {
    const result = await run(() => ({
      value: { answered: false, answer: "The excerpts do not say.", citations: [] },
    }));
    expect(result.results.every((r) => r.reason === "model")).toBe(true);
    expect(result.pass).toBe(false);
  });
});

describe("the fake model", () => {
  it("splits identifiers and stems words, so questions meet code", () => {
    expect(words("verifySession hashed Sessions")).toEqual([
      "verify",
      "session",
      "hash",
      "session",
    ]);
  });

  it("only answers the ask role", () => {
    const answer = askFakeScript({
      role: "review",
      instructions: { text: "" } as never,
      untrusted: [],
      labels: [],
      repair: false,
      maxOutputTokens: 1,
      part: () => undefined,
    });
    expect(answer).toEqual({ status: "refused" });
  });
});
