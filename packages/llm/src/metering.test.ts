import {
  isLlmMeteringError,
  LlmCallError,
  rockyInstructions,
  type CompletionRoleClient,
  type LlmCompletionRole,
  type LlmRoles,
  type LlmUsage,
  type LlmUsageRecord,
  type LlmUsageSink,
  type ProviderCompletionResult,
  type StructuredCompletionRequest,
  type StructuredCompletionResult,
} from "@rocky-reviews/core";
import { createLogger } from "@rocky-reviews/log";
import { describe, expect, it } from "vitest";
import { parseLlmConfig } from "./config.js";
import { meterRoles, usageTargetsFor, type LlmUsageTargets } from "./metering.js";
import { costMicroUsd, modelPrice, PRICE_TABLES } from "./prices.js";

/**
 * P4-5 (ADR 0016): every call through the metered roles writes one usage record per reported
 * attempt, and the rows add up to exactly what the provider reported, across a multi-call run
 * with repairs, fallbacks, refusals, truncations, failures and retries. No network, no spending.
 */

const MARKER = "secret-diff-marker-5512";
const NOW = new Date("2026-10-27T12:00:00Z");
const latest = PRICE_TABLES[PRICE_TABLES.length - 1]!;

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheWrite5mInputTokens = 0,
  cacheWrite1hInputTokens = 0,
): LlmUsage => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheWrite5mInputTokens,
  cacheWrite1hInputTokens,
});

type Step =
  | { readonly result: ProviderCompletionResult<unknown>; provider?: string }
  | { readonly error: unknown };

const DEFAULT_MODELS: Record<LlmCompletionRole, string> = {
  triage: "claude-haiku-5-5",
  review: "claude-opus-5-5",
  graph: "claude-sonnet-5-5",
  ask: "claude-sonnet-5-5",
};

const TARGETS: LlmUsageTargets = {
  triage: { provider: "anthropic", model: DEFAULT_MODELS.triage },
  review: { provider: "anthropic", model: DEFAULT_MODELS.review },
  graph: { provider: "anthropic", model: DEFAULT_MODELS.graph },
  ask: { provider: "anthropic", model: DEFAULT_MODELS.ask },
  embed: null,
};

/** A scripted `LlmRoles`: each call takes the next step of its role's script. */
const scripted = (steps: Partial<Record<LlmCompletionRole, Step[]>>) => {
  const calls: { role: LlmCompletionRole; request: StructuredCompletionRequest<unknown> }[] = [];
  const queues = new Map(Object.entries(steps).map(([role, list]) => [role, [...list]]));
  const roles: LlmRoles = {
    completion: (role): CompletionRoleClient => ({
      role,
      complete: async <T>(request: StructuredCompletionRequest<T>) => {
        calls.push({ role, request: request as StructuredCompletionRequest<unknown> });
        const step = queues.get(role)?.shift();
        if (step === undefined) throw new Error(`no scripted step for ${role}`);
        if ("error" in step) throw step.error;
        return {
          ...step.result,
          provider: step.provider ?? "anthropic",
        } as StructuredCompletionResult<T>;
      },
    }),
    embedding: () => undefined,
  };
  return { roles, calls };
};

const ok = (model: string, used: LlmUsage): Step => ({
  result: { status: "ok", value: { fine: true }, model, usage: used },
});

const memorySink = (options: { failTimes?: number } = {}) => {
  const rows: LlmUsageRecord[] = [];
  const keys = new Set<string>();
  let failures = options.failTimes ?? 0;
  let writes = 0;
  const sink: LlmUsageSink = {
    record: (records) => {
      writes++;
      if (failures > 0) {
        failures--;
        return Promise.reject(
          Object.assign(new Error(`insert failed ${MARKER}`), { code: "57P01" }),
        );
      }
      for (const record of records) {
        // Idempotent per (callId, attempt), like the database's unique key.
        const key = `${record.callId}:${record.attempt}`;
        if (!keys.has(key)) {
          keys.add(key);
          rows.push(record);
        }
      }
      return Promise.resolve();
    },
  };
  return { sink, rows, writes: () => writes };
};

const capture = () => {
  const lines: string[] = [];
  const log = createLogger("metering-test", {
    destination: { write: (line: string) => void lines.push(line) },
  });
  return { log, lines };
};

let ids = 0;
const meter = (
  roles: LlmRoles,
  sink: LlmUsageSink,
  extra: { log?: ReturnType<typeof capture>["log"] } = {},
) =>
  meterRoles(roles, {
    sink,
    targets: TARGETS,
    log: extra.log ?? capture().log,
    analysisId: "4b0c1f8e-2d6f-4f55-9b1a-6b2f0d1e9a01",
    clock: { now: () => NOW },
    callId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    retryDelayMs: 0,
  });

const request = {
  instructions: rockyInstructions`Review the change.`,
  untrusted: [{ label: "diff", text: `+const key = "${MARKER}";` }],
  output: {
    name: "answer",
    jsonSchema: { type: "object" },
    parse: (value: unknown) => ({ success: true as const, data: value }),
  },
  maxOutputTokens: 1000,
};

const call = (roles: LlmRoles, role: LlmCompletionRole) => roles.completion(role).complete(request);

const settle = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};

const sum = (list: readonly (LlmUsage | undefined)[]) =>
  list.reduce(
    (total, u) => ({
      inputTokens: total.inputTokens + (u?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (u?.outputTokens ?? 0),
      cacheReadTokens: total.cacheReadTokens + (u?.cacheReadInputTokens ?? 0),
      cacheWrite5mTokens: total.cacheWrite5mTokens + (u?.cacheWrite5mInputTokens ?? 0),
      cacheWrite1hTokens: total.cacheWrite1hTokens + (u?.cacheWrite1hInputTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
  );

const rowSum = (rows: readonly LlmUsageRecord[]) =>
  rows.reduce(
    (total, row) => ({
      inputTokens: total.inputTokens + (row.tokens?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (row.tokens?.outputTokens ?? 0),
      cacheReadTokens: total.cacheReadTokens + (row.tokens?.cacheReadTokens ?? 0),
      cacheWrite5mTokens: total.cacheWrite5mTokens + (row.tokens?.cacheWrite5mTokens ?? 0),
      cacheWrite1hTokens: total.cacheWrite1hTokens + (row.tokens?.cacheWrite1hTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
  );

const priced = (model: string, used: LlmUsage): number =>
  costMicroUsd(modelPrice(latest, "anthropic", model)!, {
    inputTokens: used.inputTokens,
    outputTokens: used.outputTokens,
    cacheReadTokens: used.cacheReadInputTokens,
    cacheWrite5mTokens: used.cacheWrite5mInputTokens,
    cacheWrite1hTokens: used.cacheWrite1hInputTokens,
  });

describe("the sum of usage rows equals provider-reported usage", () => {
  it("over a multi-call analysis: triage + repair, review with a fallback, graph, briefing, failures and a retry", async () => {
    const reported: (LlmUsage | undefined)[] = [];
    const remember = (step: Step): Step => {
      if ("result" in step) {
        const attempts = step.result.attempts;
        if (attempts === undefined) reported.push(step.result.usage);
        else for (const attempt of attempts) reported.push(attempt.usage);
      } else if (step.error instanceof LlmCallError) {
        reported.push(step.error.partialUsage);
      }
      return step;
    };
    const fallbackFirst = usage(2048, 40, 0, 2048, 0);
    const fallbackServed = usage(2100, 300, 1500, 0, 0);
    const script = {
      triage: [
        ok("claude-haiku-5-5", usage(900, 120, 4096, 0, 0)),
        // An invalid answer, then its repair round.
        {
          result: {
            status: "invalid_output" as const,
            issues: ["level: invalid_value"],
            model: "claude-haiku-5-5",
            usage: usage(950, 80, 4096, 0, 0),
          },
        },
        ok("claude-haiku-5-5", usage(1010, 90, 4096, 0, 0)),
        // A refusal before any output, and one mid-answer.
        { result: { status: "refused" as const, model: "claude-haiku-5-5", usage: usage(700, 0) } },
        {
          result: { status: "refused" as const, model: "claude-haiku-5-5", usage: usage(700, 33) },
        },
        // A long prompt: over Haiku 5.5's 100 000-token threshold.
        ok("claude-haiku-5-5", usage(98_000, 400, 3_000, 0, 0)),
      ],
      review: [
        // A server-side fallback: two attempts, each billed at its own model.
        {
          result: {
            status: "ok" as const,
            value: { findings: [] },
            model: "claude-opus-4-8",
            usage: fallbackServed,
            attempts: [
              { model: "claude-opus-5-5", usage: fallbackFirst },
              { model: "claude-opus-4-8", usage: fallbackServed },
            ],
          },
        },
        // Truncated at the output cap: ran and billed.
        {
          result: {
            status: "truncated" as const,
            model: "claude-opus-5-5",
            usage: usage(5000, 64_000, 0, 0, 3000),
          },
        },
        // A stream that broke part-way, then a rate limit with nothing reported, then the retry.
        {
          error: new LlmCallError("overloaded", { partialUsage: usage(4000, 12, 2000, 1024, 256) }),
        },
        { error: new LlmCallError("rate_limited", { retryAfterMs: 1000 }) },
        ok("claude-opus-5-5", usage(4000, 2500, 2000, 0, 0)),
        // The briefing (review role).
        ok("claude-opus-5-5", usage(6000, 1800, 3500, 0, 0)),
      ],
      graph: [ok("claude-sonnet-5-5", usage(7000, 3000, 0, 2048, 0))],
    } satisfies Partial<Record<LlmCompletionRole, Step[]>>;
    for (const steps of Object.values(script)) for (const step of steps) remember(step);

    const { roles } = scripted(script);
    const { sink, rows } = memorySink();
    const metered = meter(roles, sink);
    for (let i = 0; i < script.triage.length; i++) await call(metered, "triage");
    for (let i = 0; i < script.review.length; i++) await settle(call(metered, "review"));
    await call(metered, "graph");

    // 13 calls, one with two attempts.
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((r) => r.callId)).size).toBe(13);
    expect(rowSum(rows)).toEqual(sum(reported));
    expect(metered.totals()).toMatchObject({ calls: 13, records: 14, ...sum(reported) });

    // The cost of every priced row is the list price of its own tokens at its own model.
    for (const row of rows.filter((r) => r.costStatus === "priced")) {
      const t = row.tokens!;
      expect(row.costMicroUsd).toBe(costMicroUsd(modelPrice(latest, row.provider, row.model)!, t));
      expect(row.priceVersion).toBe(latest.version);
    }
    expect(metered.totals().costMicroUsd).toBe(
      rows.reduce((total, r) => total + (r.costMicroUsd ?? 0), 0),
    );

    const fallback = rows.filter(
      (r) =>
        r.role === "review" && r.callId === rows.find((x) => x.model === "claude-opus-4-8")!.callId,
    );
    expect(fallback.map((r) => [r.attempt, r.model, r.outcome, r.costStatus])).toEqual([
      // The declined attempt produced output (40 tokens), so it bills at normal rates.
      [0, "claude-opus-5-5", "refused", "priced"],
      [1, "claude-opus-4-8", "ok", "priced"],
    ]);
    expect(fallback[0]!.costMicroUsd).toBe(priced("claude-opus-5-5", fallbackFirst));
    expect(fallback[1]!.costMicroUsd).toBe(priced("claude-opus-4-8", fallbackServed));
  });

  it("records every call of a repair loop and of retried runs, each as its own row", async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 6; i++) steps.push(ok("claude-sonnet-5-5", usage(100 + i, 10 + i)));
    const { roles, calls } = scripted({ graph: steps });
    const { sink, rows } = memorySink();
    // Two runs of the same analysis (a requeue): each makes its own wrapper; both are kept.
    const first = meter(roles, sink);
    for (let i = 0; i < 3; i++) await call(first, "graph");
    const second = meter(roles, sink);
    for (let i = 0; i < 3; i++) await call(second, "graph");
    expect(calls).toHaveLength(6);
    expect(rows).toHaveLength(6);
    expect(rowSum(rows).inputTokens).toBe(100 + 101 + 102 + 103 + 104 + 105);
    expect(rowSum(rows).outputTokens).toBe(10 + 11 + 12 + 13 + 14 + 15);
  });
});

describe("what a usage row says", () => {
  it("records the outcome, the model per attempt and the cost status by the billing rules", async () => {
    const { roles } = scripted({
      triage: [
        { result: { status: "refused", model: "claude-haiku-5-5", usage: usage(700, 0) } },
        { result: { status: "refused", model: "claude-haiku-5-5", usage: usage(700, 5) } },
        { result: { status: "truncated", model: "claude-haiku-5-5", usage: usage(700, 1000) } },
        {
          result: {
            status: "invalid_output",
            issues: ["(root): invalid_json"],
            model: "claude-haiku-5-5",
            usage: usage(700, 50),
          },
        },
      ],
    });
    const { sink, rows } = memorySink();
    const metered = meter(roles, sink);
    for (let i = 0; i < 4; i++) await call(metered, "triage");
    expect(rows.map((r) => [r.outcome, r.usageStatus, r.costStatus])).toEqual([
      // A refusal before any output: billed only in some categories Rocky cannot see.
      ["refused", "reported", "billing_unverified"],
      ["refused", "reported", "priced"],
      ["truncated", "reported", "priced"],
      ["invalid_output", "reported", "priced"],
    ]);
    expect(rows[0]!.costMicroUsd).toBeNull();
    expect(rows[0]!.tokens).toEqual({
      inputTokens: 700,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
    for (const row of rows) {
      expect(row).toMatchObject({
        role: "triage",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        attempt: 0,
        analysisId: "4b0c1f8e-2d6f-4f55-9b1a-6b2f0d1e9a01",
        priceVersion: latest.version,
      });
    }
  });

  it("records a failed call with its partial usage, or with no tokens at all, and rethrows the error", async () => {
    const partial = new LlmCallError("network", { partialUsage: usage(2048, 1, 1536, 1024, 256) });
    const none = new LlmCallError("auth");
    const bug = new TypeError("not an LlmCallError");
    const { roles } = scripted({ review: [{ error: partial }, { error: none }, { error: bug }] });
    const { sink, rows } = memorySink();
    const metered = meter(roles, sink);
    expect(await settle(call(metered, "review"))).toBe(partial);
    expect(await settle(call(metered, "review"))).toBe(none);
    expect(await settle(call(metered, "review"))).toBe(bug);
    expect(
      rows.map((r) => [r.outcome, r.errorKind, r.usageStatus, r.costStatus, r.costMicroUsd]),
    ).toEqual([
      ["error", "network", "partial", "billing_unverified", null],
      ["error", "auth", "unreported", "no_usage", null],
      ["error", undefined, "unreported", "no_usage", null],
    ]);
    expect(rows[1]!.tokens).toBeNull();
    // The role's configured target names the model and provider of a call that never answered.
    for (const row of rows)
      expect([row.provider, row.model]).toEqual(["anthropic", "claude-opus-5-5"]);
  });

  it("records a result whose provider reported no (valid) usage as unreported, never as a priced zero (review 1)", async () => {
    const { roles } = scripted({
      graph: [
        { result: { status: "ok", value: {}, model: "claude-sonnet-5-5", usage: undefined } },
        {
          result: {
            status: "ok",
            value: {},
            model: "claude-opus-4-8",
            usage: usage(10, 5),
            attempts: [
              { model: "claude-opus-5-5", usage: undefined },
              { model: "claude-opus-4-8", usage: usage(10, 5) },
            ],
          },
        },
      ],
    });
    const { sink, rows } = memorySink();
    const metered = meter(roles, sink);
    await call(metered, "graph");
    await call(metered, "graph");
    expect(
      rows.map((r) => [r.attempt, r.usageStatus, r.costStatus, r.costMicroUsd, r.tokens]),
    ).toEqual([
      [0, "unreported", "no_usage", null, null],
      [0, "unreported", "no_usage", null, null],
      [1, "reported", "priced", priced("claude-opus-4-8", usage(10, 5)), expect.any(Object)],
    ]);
  });

  it("records tokens with no price for an unknown model or an unverified platform; never guesses", async () => {
    const { roles } = scripted({
      graph: [
        ok("claude-opus-9", usage(100, 10)),
        { ...ok("claude-sonnet-5-5", usage(100, 10)), provider: "bedrock" },
        { ...ok("claude-sonnet-5-5", usage(100, 10)), provider: "vertex" },
        { ...ok("qwen3-coder:30b", usage(100, 10)), provider: "openai-compatible" },
        { ...ok("claude-sonnet-5-5", usage(100, 10)), provider: "foundry" },
      ],
    });
    const { sink, rows } = memorySink();
    const metered = meter(roles, sink);
    for (let i = 0; i < 5; i++) await call(metered, "graph");
    expect(rows.map((r) => [r.provider, r.model, r.costStatus])).toEqual([
      ["anthropic", "claude-opus-9", "no_price"],
      ["bedrock", "claude-sonnet-5-5", "no_price"],
      ["vertex", "claude-sonnet-5-5", "no_price"],
      ["openai-compatible", "qwen3-coder:30b", "no_price"],
      ["foundry", "claude-sonnet-5-5", "priced"],
    ]);
    for (const row of rows.slice(0, 4)) {
      expect(row.costMicroUsd).toBeNull();
      expect(row.tokens?.inputTokens).toBe(100);
    }
  });

  it("records no price when no price table is in effect", async () => {
    const { roles } = scripted({ graph: [ok("claude-sonnet-5-5", usage(100, 10))] });
    const { sink, rows } = memorySink();
    await call(
      meterRoles(roles, {
        sink,
        targets: TARGETS,
        log: capture().log,
        clock: { now: () => new Date("2020-01-01T00:00:00Z") },
      }),
      "graph",
    );
    expect(rows[0]).toMatchObject({
      costStatus: "no_price",
      costMicroUsd: null,
      priceVersion: "none",
    });
    expect(rows[0]!.analysisId).toBeUndefined();
  });

  it("does not trust a hostile model id or token counts", async () => {
    const { roles } = scripted({
      graph: [
        ok(`claude"; drop table llm_usage; -- ${MARKER}`, usage(100, 10)),
        ok("claude-sonnet-5-5", usage(3_000_000_000, 10)),
        { ...ok("claude-sonnet-5-5", usage(1, 1)), provider: "Bad Provider" },
      ],
    });
    const { sink, rows } = memorySink();
    const { log, lines } = capture();
    const metered = meter(roles, sink, { log });
    for (let i = 0; i < 3; i++) await call(metered, "graph");
    expect(rows[0]).toMatchObject({ model: "unrecognised", costStatus: "no_price" });
    expect(rows[1]).toMatchObject({
      usageStatus: "unreported",
      tokens: null,
      costStatus: "no_usage",
    });
    expect(rows[2]).toMatchObject({ provider: "unrecognised", costStatus: "no_price" });
    expect(lines.join("\n")).toContain("llm_usage_out_of_range");
    expect(JSON.stringify(rows) + lines.join("\n")).not.toContain(MARKER);
  });

  it("holds ids, enums and numbers only: no prompt, code or model output", async () => {
    const { roles } = scripted({
      review: [
        {
          result: {
            status: "ok",
            value: { summary: MARKER },
            model: "claude-opus-5-5",
            usage: usage(1, 1),
          },
        },
        {
          result: {
            status: "invalid_output",
            issues: [`${MARKER}: custom`],
            model: "claude-opus-5-5",
            usage: usage(1, 1),
          },
        },
      ],
    });
    const { sink, rows } = memorySink({ failTimes: 0 });
    const metered = meter(roles, sink);
    await call(metered, "review");
    await call(metered, "review");
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "analysisId",
          "attempt",
          "callId",
          "costMicroUsd",
          "costStatus",
          "model",
          "outcome",
          "priceVersion",
          "provider",
          "role",
          "tokens",
          "usageStatus",
        ].sort(),
      );
      expect(Object.isFrozen(row)).toBe(true);
    }
  });
});

describe("a metering write that fails", () => {
  it("is retried; the call's result is handed on only once its usage is stored", async () => {
    const { roles } = scripted({ graph: [ok("claude-sonnet-5-5", usage(100, 10))] });
    const { sink, rows, writes } = memorySink({ failTimes: 2 });
    const metered = meter(roles, sink);
    const result = await call(metered, "graph");
    expect(result.status).toBe("ok");
    expect(writes()).toBe(3);
    expect(rows).toHaveLength(1);
    expect(metered.failed).toBe(false);
  });

  it("is never silent: the usage is logged as numbers, the call fails, and later calls are refused", async () => {
    const { roles, calls } = scripted({
      review: [
        ok("claude-opus-5-5", usage(1234, 567, 89, 10, 11)),
        ok("claude-opus-5-5", usage(1, 1)),
      ],
      graph: [{ error: new LlmCallError("rate_limited") }],
    });
    const { sink, rows } = memorySink({ failTimes: 99 });
    const { log, lines } = capture();
    const metered = meter(roles, sink, { log });
    const error = await settle(call(metered, "review"));
    expect(isLlmMeteringError(error)).toBe(true);
    expect(metered.failed).toBe(true);
    expect(rows).toHaveLength(0);

    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const unrecorded = logged.find((l) => l["errorCode"] === "llm_usage_unrecorded");
    expect(unrecorded).toMatchObject({
      level: 50,
      sqlstate: "57P01",
      role: "review",
      model: "claude-opus-5-5",
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadCount: 89,
      cacheWrite5mCount: 10,
      cacheWrite1hCount: 11,
      costStatus: "priced",
    });
    // The driver's message (which can echo values) and the request never reach the log.
    expect(lines.join("\n")).not.toContain(MARKER);

    // Fail closed: nothing else reaches a provider through this wrapper.
    expect(isLlmMeteringError(await settle(call(metered, "review")))).toBe(true);
    expect(isLlmMeteringError(await settle(call(metered, "graph")))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("replaces the call's own error when the failed call's usage cannot be stored either", async () => {
    const { roles } = scripted({ triage: [{ error: new LlmCallError("overloaded") }] });
    const { sink } = memorySink({ failTimes: 99 });
    const metered = meter(roles, sink);
    expect(isLlmMeteringError(await settle(call(metered, "triage")))).toBe(true);
  });
});

describe("embeddings and targets", () => {
  it("meters the embed role too", async () => {
    const roles: LlmRoles = {
      completion: () => {
        throw new TypeError("unused");
      },
      embedding: () => ({
        embed: () =>
          Promise.resolve({
            vectors: [[0.1, 0.2]],
            model: "nomic-embed-text",
            usage: { inputTokens: 42 },
            provider: "openai-compatible",
          }),
      }),
    };
    const { sink, rows } = memorySink();
    const metered = meterRoles(roles, {
      sink,
      targets: { ...TARGETS, embed: { provider: "openai-compatible", model: "nomic-embed-text" } },
      log: capture().log,
      clock: { now: () => NOW },
    });
    const result = await metered.embedding()!.embed({ inputs: [MARKER] });
    expect(result.vectors).toEqual([[0.1, 0.2]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "embed",
      provider: "openai-compatible",
      model: "nomic-embed-text",
      outcome: "ok",
      tokens: { inputTokens: 42, outputTokens: 0 },
      costStatus: "no_price",
    });
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  });

  it("records a failed embedding call and keeps the role off when embeddings are off", async () => {
    const failing: LlmRoles = {
      completion: () => {
        throw new TypeError("unused");
      },
      embedding: () => ({ embed: () => Promise.reject(new LlmCallError("timeout")) }),
    };
    const { sink, rows } = memorySink();
    const metered = meterRoles(failing, { sink, targets: TARGETS, log: capture().log });
    expect(await settle(metered.embedding()!.embed({ inputs: ["x"] }))).toBeInstanceOf(
      LlmCallError,
    );
    expect(rows[0]).toMatchObject({
      role: "embed",
      outcome: "error",
      errorKind: "timeout",
      provider: "unrecognised",
      model: "unrecognised",
    });
    const off = meterRoles(scripted({}).roles, { sink, targets: TARGETS, log: capture().log });
    expect(off.embedding()).toBeUndefined();
    expect(() => off.completion("teapot" as LlmCompletionRole)).toThrow(TypeError);
  });

  it("derives targets from the validated config", () => {
    const config = parseLlmConfig({
      providers: { anthropic: { kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" } },
      roles: {
        triage: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
        review: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
        graph: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
        ask: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
        embed: null,
      },
    });
    expect(usageTargetsFor(config)).toEqual(TARGETS);
  });
});
