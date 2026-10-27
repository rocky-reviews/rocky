import {
  LlmCallError,
  rockyInstructions,
  type LlmCompletionRole,
  type LlmOutputSchema,
  type LlmRoles,
  type LlmUsage,
  type StructuredCompletionRequest,
} from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { estimateInputTokens, TokenCapReached, withTokenCap } from "./budget.js";

/**
 * P4-8: the per-run spend cap. Before each call, refuse once the usage reported so far, plus what
 * calls in flight may still use, plus the next call's input estimate and `maxOutputTokens`, would
 * exceed the cap.
 */

const OUTPUT: LlmOutputSchema<{ ok: boolean }> = {
  name: "t",
  jsonSchema: { type: "object" },
  parse: (value) => ({ success: true, data: value as { ok: boolean } }),
};

const usage = (inputTokens: number, outputTokens: number, cache = 0): LlmUsage => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: cache,
  cacheWrite5mInputTokens: cache,
  cacheWrite1hInputTokens: 0,
});

/** Roles that answer `{ ok: true }` with the given usage, and count calls that reached them. */
const fakeRoles = (
  answer: (role: LlmCompletionRole) => {
    usage: LlmUsage;
    attempts?: { model: string; usage: LlmUsage }[];
    error?: LlmCallError;
  },
  gate?: Promise<void>,
) => {
  const reached: LlmCompletionRole[] = [];
  const roles: LlmRoles = {
    completion: (role) => ({
      role,
      complete: async <T>(request: StructuredCompletionRequest<T>) => {
        void request;
        reached.push(role);
        await gate;
        const a = answer(role);
        if (a.error !== undefined) throw a.error;
        return {
          status: "ok" as const,
          value: { ok: true } as T,
          model: `m-${role}`,
          provider: "anthropic",
          usage: a.usage,
          ...(a.attempts === undefined ? {} : { attempts: a.attempts }),
        };
      },
    }),
    embedding: () => undefined,
  };
  return { roles, reached };
};

const request = (
  maxOutputTokens: number,
  text = "x",
): StructuredCompletionRequest<{ ok: boolean }> => ({
  instructions: rockyInstructions`Test.`,
  untrusted: [{ label: "diff", text }],
  output: OUTPUT,
  maxOutputTokens,
});

describe("estimateInputTokens", () => {
  it("grows with the content and counts the instructions and the output schema", () => {
    const small = estimateInputTokens(request(1, "a"));
    const large = estimateInputTokens(request(1, "a".repeat(30_000)));
    expect(small).toBeGreaterThan(0);
    expect(large - small).toBeGreaterThanOrEqual(29_999);
  });

  it("is a ceiling for dense text: one token per UTF-8 byte (CJK, emoji, base64)", () => {
    const base = estimateInputTokens(request(1, ""));
    // 10,000 CJK characters are 30,000 UTF-8 bytes; a tokenizer can spend a token per character.
    expect(estimateInputTokens(request(1, "\u6f22".repeat(10_000))) - base).toBeGreaterThanOrEqual(
      30_000,
    );
    expect(
      estimateInputTokens(request(1, "\u{1f680}".repeat(1_000))) - base,
    ).toBeGreaterThanOrEqual(4_000);
    expect(estimateInputTokens(request(1, "QUJD".repeat(5_000))) - base).toBeGreaterThanOrEqual(
      20_000,
    );
  });
});

describe("withTokenCap", () => {
  it("adds reported usage per role (cache reads and writes too, and every attempt)", async () => {
    const { roles } = fakeRoles((role) =>
      role === "triage"
        ? { usage: usage(100, 20, 5) }
        : {
            usage: usage(300, 40),
            attempts: [
              { model: "a", usage: usage(50, 0) },
              { model: "b", usage: usage(300, 40) },
            ],
          },
    );
    const budget = withTokenCap(roles, 1_000_000);
    await budget.roles.completion("triage").complete(request(10));
    await budget.roles.completion("triage").complete(request(10));
    await budget.roles.completion("review").complete(request(10));
    const report = budget.report();
    expect(report.roles.triage).toMatchObject({
      calls: 2,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheWriteInputTokens: 10,
      totalTokens: 260,
      provider: "anthropic",
      models: ["m-triage"],
    });
    // A refusal fallback reports two attempts: both count toward the cap.
    expect(report.roles.review).toMatchObject({ calls: 1, inputTokens: 350, totalTokens: 390 });
    expect(report.totalTokens).toBe(650);
    expect(report.cap).toBe(1_000_000);
    expect(report.stopped).toBeUndefined();
  });

  it("refuses the call that would cross the cap, before it reaches the provider", async () => {
    const { roles, reached } = fakeRoles(() => ({ usage: usage(400, 100) }));
    const budget = withTokenCap(roles, 2_000);
    const triage = budget.roles.completion("triage");
    await triage.complete(request(100)); // 500 used
    await triage.complete(request(100)); // 1000 used
    // 1000 + estimate + 1000 > 2000: refused.
    await expect(triage.complete(request(1_000))).rejects.toBeInstanceOf(TokenCapReached);
    expect(reached).toHaveLength(2);
    const report = budget.report();
    expect(report.totalTokens).toBe(1_000);
    expect(report.stopped).toMatchObject({ role: "triage", usedTokens: 1_000, cap: 2_000 });
    expect(report.stopped!.nextCallTokens).toBeGreaterThan(1_000);
    // Once stopped, every later call is refused too, even a small one.
    await expect(triage.complete(request(1))).rejects.toBeInstanceOf(TokenCapReached);
    expect(reached).toHaveLength(2);
  });

  it("refuses a dense CJK diff before the call reaches the provider", async () => {
    const { roles, reached } = fakeRoles(() => ({ usage: usage(1, 1) }));
    // 10,000 characters: under the old characters / 3 estimate this fit in 25,000 tokens.
    const budget = withTokenCap(roles, 25_000);
    await expect(
      budget.roles.completion("triage").complete(request(100, "\u6f22".repeat(10_000))),
    ).rejects.toBeInstanceOf(TokenCapReached);
    expect(reached).toHaveLength(0);
  });

  it("a call that reports more than its reservation still stops the next call", async () => {
    const { roles, reached } = fakeRoles(() => ({ usage: usage(45_000, 5_000) }));
    const budget = withTokenCap(roles, 40_000);
    const review = budget.roles.completion("review");
    await review.complete(request(100)); // reserved ~1k, reported 50k: over the cap
    await expect(review.complete(request(1))).rejects.toBeInstanceOf(TokenCapReached);
    expect(reached).toHaveLength(1);
    expect(budget.report().totalTokens).toBe(50_000);
    expect(budget.report().stopped).toMatchObject({ usedTokens: 50_000 });
  });

  it("reserves the input once per possible attempt where a refusal fallback can re-run it", async () => {
    const { roles, reached } = fakeRoles(() => ({ usage: usage(1, 1) }));
    const text = "a".repeat(10_000);
    const single = estimateInputTokens(request(0, text));
    // Fits once, not twice: refused only for the role whose fallback may bill the input again.
    const cap = single * 2 - 1;
    const budget = withTokenCap(roles, cap, {
      inputAttempts: (role) => (role === "review" ? 2 : 1),
    });
    await budget.roles.completion("triage").complete(request(0, text));
    expect(reached).toEqual(["triage"]);
    await expect(
      budget.roles.completion("review").complete(request(0, text)),
    ).rejects.toBeInstanceOf(TokenCapReached);
    expect(budget.report().stopped).toMatchObject({ role: "review", nextCallTokens: single * 2 });
    expect(() => withTokenCap(roles, 10, { inputAttempts: () => 0 })).toThrow(RangeError);
  });

  it("reserves what calls in flight may use, so parallel calls cannot overshoot together", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { roles, reached } = fakeRoles(() => ({ usage: usage(10, 10) }), gate);
    const budget = withTokenCap(roles, 3_000);
    const review = budget.roles.completion("review");
    const first = review.complete(request(1_000)); // in flight: ~1000 reserved
    await expect(review.complete(request(1_000))).rejects.toBeInstanceOf(TokenCapReached);
    open();
    await first;
    expect(reached).toHaveLength(1);
    expect(budget.report().totalTokens).toBe(20);
  });

  it("releases the reservation of a call that failed", async () => {
    let fail = true;
    const { roles } = fakeRoles(() =>
      fail
        ? { usage: usage(0, 0), error: new LlmCallError("server_error") }
        : { usage: usage(1, 1) },
    );
    const budget = withTokenCap(roles, 3_000);
    const graph = budget.roles.completion("graph");
    await expect(graph.complete(request(1_000))).rejects.toBeInstanceOf(LlmCallError);
    fail = false;
    await graph.complete(request(1_000));
    expect(budget.report().roles.graph).toMatchObject({ calls: 1, totalTokens: 2 });
  });

  it("refuses a cap that is not a positive integer", () => {
    const { roles } = fakeRoles(() => ({ usage: usage(0, 0) }));
    for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withTokenCap(roles, cap)).toThrow(RangeError);
    }
  });
});
