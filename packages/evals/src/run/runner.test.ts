import { createHash } from "node:crypto";
import {
  LlmCallError,
  PIPELINE_VERSION,
  PROMPT_TEXTS,
  type CompletionRoleClient,
  type LlmRoles,
  type LlmUsage,
} from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { INJECTION_CORPUS } from "../injection/corpus.js";
import { SEEDED_PRS } from "../seeded/index.js";
import { fakeTarget } from "./fake/test-support.js";
import { createMeter } from "./meter.js";
import { parseReport, PROMPT_HASH } from "./report.js";
import { runEvals, type EvalSubject } from "./runner.js";

const clock = { now: () => new Date("2026-10-27T12:00:00.000Z") };

const fakeRun = (over: Partial<Parameters<typeof runEvals>[0]> = {}) => {
  const target = fakeTarget();
  return runEvals({
    kind: "fake",
    models: target.models,
    rolesFor: target.rolesFor,
    maxTokens: 10_000_000,
    injection: false,
    clock,
    ...over,
  });
};

describe("runEvals (P4-7) on the scripted roles", () => {
  it("runs every seeded PR through the pipeline and scores it", async () => {
    const report = await fakeRun();
    expect(parseReport(JSON.parse(JSON.stringify(report))).ok).toBe(true);
    expect(report.prs.map((pr) => pr.id)).toEqual(SEEDED_PRS.map((pr) => pr.id));
    expect(report.prs.every((pr) => pr.status === "done")).toBe(true);
    const byId = Object.fromEntries(report.prs.map((pr) => [pr.id, pr]));
    // pr-847: P4-3's 8 of 10 (the two low findings in normal files are never reviewed).
    expect(byId["pr-847"]).toMatchObject({ expected: 10, matched: 8, produced: 8 });
    expect(byId["pr-847"]!.missed).toEqual(["F9", "F10"]);
    expect(byId["pr-912"]).toMatchObject({ expected: 3, matched: 3, produced: 3 });
    // The newer PRs' fakes are deliberately imperfect (misses, a wrong severity, false positives).
    expect(byId["pr-1003"]).toMatchObject({ expected: 6, matched: 4, produced: 5 });
    expect(byId["pr-1104"]).toMatchObject({
      expected: 6,
      matched: 4,
      produced: 5,
      criticalProduced: 3,
      criticalFalsePositives: 1,
    });
    expect(byId["pr-1205"]).toMatchObject({ expected: 7, matched: 5, produced: 6, tolerated: 1 });
    expect(byId["pr-1205"]!.missed).toEqual(["W3", "W6"]);
    expect(byId["pr-1205"]!.falsePositives).toEqual([
      { path: "src/webhooks/deliver.ts", severity: "high", range: { start: 6, end: 6 } },
    ]);
  });

  it("totals are micro-averaged over every PR", async () => {
    const { total, prs } = await fakeRun();
    const sum = (key: "expected" | "matched" | "produced") => prs.reduce((n, pr) => n + pr[key], 0);
    expect(total).toMatchObject({
      prs: 5,
      expected: sum("expected"),
      matched: sum("matched"),
      produced: sum("produced"),
    });
    expect(total.recall).toBeCloseTo(sum("matched") / sum("expected"), 10);
    expect(total.precision).toBeCloseTo(sum("matched") / sum("produced"), 10);
    expect(total.criticalFalsePositiveRate).toBeCloseTo(1 / 5, 10);
  });

  it("records versions, models, options, a timestamp and token usage per role", async () => {
    const report = await fakeRun();
    expect(report).toMatchObject({
      format: "rocky-evals-report",
      version: 1,
      kind: "fake",
      createdAt: "2026-10-27T12:00:00.000Z",
      pipelineVersion: PIPELINE_VERSION,
      promptHash: createHash("sha256").update(JSON.stringify(PROMPT_TEXTS)).digest("hex"),
      options: { maxTokens: 10_000_000, injection: false, only: null },
    });
    expect(report.promptHash).toBe(PROMPT_HASH);
    expect(Object.keys(report.models).sort()).toEqual(["graph", "review", "triage"]);
    for (const role of ["triage", "review", "graph"] as const) {
      expect(report.usage.byRole[role]!.calls).toBeGreaterThan(0);
      expect(report.usage.byRole[role]!.inputTokens).toBeGreaterThan(0);
      expect(report.usage.byRole[role]!.models).toEqual([`scripted-${role}`]);
    }
    expect(report.usage.capped).toBe(false);
    expect(report.injection).toBeNull();
  });

  it("--only runs the named PRs", async () => {
    const report = await fakeRun({ only: ["pr-1104"] });
    expect(report.prs.map((pr) => pr.id)).toEqual(["pr-1104"]);
    expect(report.options.only).toEqual(["pr-1104"]);
  });

  it("stops at the token cap: no call starts once the cap is reached, the rest is marked capped", async () => {
    const report = await fakeRun({ maxTokens: 5_000 });
    expect(report.usage.capped).toBe(true);
    expect(report.prs.some((pr) => pr.status === "capped")).toBe(true);
    expect(report.prs.at(-1)!.status).toBe("capped");
    // The cap is checked before each call, so at most the calls in flight overshoot it.
    expect(report.usage.totalTokens).toBeLessThan(5_000 + 20_000);
  });

  it("reports the injection corpus separately, on pr-847 and pr-912, with the adversarial fakes", async () => {
    const report = await fakeRun({ injection: true });
    const injection = report.injection!;
    expect(injection.cases).toHaveLength(INJECTION_CORPUS.length * 2);
    expect(new Set(injection.cases.map((c) => c.fixture))).toEqual(new Set(["pr-847", "pr-912"]));
    // The defences hold against a fully compromised model.
    expect(injection.total).toMatchObject({
      cases: INJECTION_CORPUS.length * 2,
      unexpectedFailures: 0,
      belowFloor: 0,
      outsideDiff: 0,
      leaks: 0,
    });
    // What a compromised model can still do is measured, not hidden.
    expect(injection.total.poisoned).toBeGreaterThan(0);
    expect(injection.total.verdictChanged).toBeGreaterThan(0);
    const poison = injection.cases.find(
      (c) => c.fixture === "pr-847" && c.case === "poison-agent-prompt",
    )!;
    expect(poison.poisoned).toBe(true);
    const failsClosed = injection.cases.filter((c) => c.expectFailsClosed);
    expect(failsClosed.length).toBeGreaterThan(0);
    expect(failsClosed.every((c) => c.status === "failed")).toBe(true);
  });
});

describe("the eval subjects", () => {
  it("live roles are asked for every subject; fake roles are per subject", async () => {
    const subjects: EvalSubject[] = [];
    const target = fakeTarget();
    await runEvals({
      kind: "fake",
      models: target.models,
      rolesFor: (subject) => {
        subjects.push(subject);
        return target.rolesFor(subject);
      },
      maxTokens: 10_000_000,
      injection: false,
      only: ["pr-912"],
      clock,
    });
    expect(subjects).toEqual([{ kind: "seeded", pr: SEEDED_PRS[1] }]);
  });
});

const usage = (inputTokens: number, outputTokens: number): LlmUsage => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
});

const rolesFrom = (complete: CompletionRoleClient["complete"]): LlmRoles => ({
  completion: (role) => ({ role, complete }),
  embedding: () => undefined,
});

const request = {} as Parameters<CompletionRoleClient["complete"]>[0];

describe("createMeter", () => {
  it("sums usage per role, including every reported attempt", async () => {
    const meter = createMeter({ maxTokens: 1_000 });
    const roles = meter.wrap(
      rolesFrom(async () => ({
        status: "ok",
        value: {} as never,
        model: "m2",
        provider: "p",
        usage: usage(10, 5),
        attempts: [
          { model: "m1", usage: usage(3, 0) },
          { model: "m2", usage: usage(10, 5) },
        ],
      })),
    );
    await roles.completion("review").complete(request);
    expect(meter.usage().byRole["review"]).toEqual({
      calls: 1,
      inputTokens: 13,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      models: ["m1", "m2"],
    });
    expect(meter.usage().totalTokens).toBe(18);
  });

  it("never counts a call whose provider reported no usage as free (P4-5)", async () => {
    const meter = createMeter({ maxTokens: 1_000_000 });
    const roles = meter.wrap(
      rolesFrom(async () => ({
        status: "ok",
        value: {} as never,
        model: "m",
        provider: "p",
        usage: undefined,
      })),
    );
    const sized = {
      instructions: { text: "abc" },
      untrusted: [{ text: "日本" }],
      maxOutputTokens: 100,
    } as unknown as Parameters<CompletionRoleClient["complete"]>[0];
    await roles.completion("review").complete(sized);
    expect(meter.usage().byRole["review"]).toMatchObject({
      calls: 1,
      inputTokens: 0,
      models: ["m"],
    });
    // The cap is charged a ceiling: UTF-8 bytes of the request (3 + 6) plus its output cap.
    expect(meter.usage().totalTokens).toBe(109);
  });

  it("refuses a call once the cap is reached, as a cancelled call", async () => {
    const meter = createMeter({ maxTokens: 10 });
    const roles = meter.wrap(
      rolesFrom(async () => ({
        status: "ok",
        value: {} as never,
        model: "m",
        provider: "p",
        usage: usage(8, 4),
      })),
    );
    await roles.completion("triage").complete(request);
    await expect(roles.completion("triage").complete(request)).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(meter.usage()).toMatchObject({ capped: true, totalTokens: 12 });
  });

  it("retries a retryable failure with the provider's hint, then gives up", async () => {
    const waits: number[] = [];
    let calls = 0;
    const meter = createMeter({ maxTokens: 100, sleep: async (ms) => void waits.push(ms) });
    const flaky = meter.wrap(
      rolesFrom(async () => {
        calls++;
        if (calls < 3) throw new LlmCallError("rate_limited", { retryAfterMs: 1_500 });
        return { status: "ok", value: {} as never, model: "m", provider: "p", usage: usage(1, 1) };
      }),
    );
    await flaky.completion("graph").complete(request);
    expect(waits).toEqual([1_500, 1_500]);

    const down = meter.wrap(
      rolesFrom(async () => {
        throw new LlmCallError("overloaded");
      }),
    );
    await expect(down.completion("graph").complete(request)).rejects.toMatchObject({
      kind: "overloaded",
    });
    expect(waits.slice(2)).toEqual([2_000, 4_000]);
    const fatal = meter.wrap(
      rolesFrom(async () => {
        throw new LlmCallError("auth");
      }),
    );
    await expect(fatal.completion("graph").complete(request)).rejects.toMatchObject({
      kind: "auth",
    });
    expect(waits).toHaveLength(4);
  });
});
