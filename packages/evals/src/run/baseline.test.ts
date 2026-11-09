import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compareReports } from "./compare.js";
import { fakeTarget } from "./fake/test-support.js";
import { parseReport, PLACEHOLDER_NOTICE, type EvalReport } from "./report.js";
import { runEvals } from "./runner.js";

/**
 * P4-7 acceptance: a baseline report is committed, and the gate fails if recall drops more than
 * 5 points. The `--fake` baseline is what CI's harness check compares a fresh `--fake` run with;
 * the live baseline stays a clearly marked placeholder until a human runs the suite with a key.
 * Regenerate the fake one with `pnpm evals run --fake --injection --memory --ask --max-tokens 2000000 --out packages/evals/baselines/fake.json`.
 */

const load = async (name: string): Promise<EvalReport> => {
  const text = await readFile(new URL(`../../baselines/${name}`, import.meta.url), "utf8");
  const parsed = parseReport(JSON.parse(text));
  if (!parsed.ok) throw new Error(`${name}: ${parsed.issues.join("; ")}`);
  return parsed.report;
};

describe("committed baselines", () => {
  it("the fake baseline matches a fresh --fake run: the gate passes and every score is equal", async () => {
    const baseline = await load("fake.json");
    expect(baseline.kind).toBe("fake");
    expect(baseline.options.injection).toBe(true);
    // P8-2: the baseline carries the project-memory eval, passed, so the gate holds it.
    expect(baseline.options.memory).toBe(true);
    expect(baseline.memory?.pass).toBe(true);
    // P9-2: and the Ask eval, passed.
    expect(baseline.options.ask).toBe(true);
    expect(baseline.ask?.pass).toBe(true);
    // P9-3: and the corpus on the Ask channel, with no guard broken.
    expect(baseline.options.askInjection).toBe(true);
    expect(baseline.askInjection?.total).toMatchObject({ leaks: 0, outside: 0, markup: 0 });
    const target = fakeTarget();
    const fresh = await runEvals({
      kind: "fake",
      models: target.models,
      rolesFor: target.rolesFor,
      maxTokens: baseline.options.maxTokens,
      injection: true,
      memory: true,
      ask: target.ask,
      askInjection: true,
      clock: { now: () => new Date() },
    });
    expect(compareReports(baseline, fresh).ok).toBe(true);
    expect(fresh.total).toEqual(baseline.total);
    expect(fresh.prs).toEqual(baseline.prs);
    expect(fresh.injection?.total).toEqual(baseline.injection?.total);
    expect(fresh.memory).toEqual(baseline.memory);
    expect(fresh.ask).toEqual(baseline.ask);
    expect(fresh.askInjection).toEqual(baseline.askInjection);
    // A whole injection run through the pipeline (three graph-role calls per map since H4-7):
    // over the 5 s default when the test runner instruments coverage.
  }, 60_000);

  it("the gate on the fake baseline fails once recall drops more than 5 points", async () => {
    const baseline = await load("fake.json");
    const worse = structuredClone(baseline);
    // Lose two seeded findings out of 32: 6.25 points.
    worse.prs[0]!.matched -= 2;
    expect(compareReports(baseline, worse).ok).toBe(false);
  });

  it("the live baseline is a placeholder that cannot be mistaken for a real-model result", async () => {
    const live = await load("live.json");
    expect(live.kind).toBe("placeholder");
    expect(live.notice).toBe(PLACEHOLDER_NOTICE);
    expect(live.notice).toMatch(/NOT A REAL-MODEL RESULT/);
    expect(live.prs).toEqual([]);
  });
});
