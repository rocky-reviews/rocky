import { readFile } from "node:fs/promises";
import { LlmCallError, type LlmRoles } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { evalsCli, type CliDeps, type CliIo } from "./cli.js";
import { fakeTarget } from "./fake/test-support.js";
import { parseReport, totalsOf, type EvalReport } from "./report.js";

const KEY = "sk-ant-test-DO-NOT-PRINT-0123456789";

const io = (files: Record<string, string> = {}, env: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const value: CliIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    readFile: async (path) => {
      const file = files[path] ?? written[path];
      if (file === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return file;
    },
    writeFile: async (path, text) => void (written[path] = text),
    env,
    clock: { now: () => new Date("2026-10-27T12:00:00.000Z") },
    defaultOut: (kind, at) => `reports/${kind}-${at}.json`,
  };
  return { io: value, out, err, written, text: () => [...out, ...err].join("") };
};

const unreachable: LlmRoles = {
  completion: (role) => ({
    role,
    complete: async () => {
      throw new LlmCallError("auth");
    },
  }),
  embedding: () => undefined,
};

const deps = (missingSecrets: string[] = []): CliDeps => ({
  live: () => ({
    models: {
      triage: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
      review: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
      graph: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
    },
    roles: unreachable,
    missingSecrets,
  }),
  fake: async () => fakeTarget(),
});

const written = (files: Record<string, string>, path: string): EvalReport => {
  const parsed = parseReport(JSON.parse(files[path]!));
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
  return parsed.report;
};

describe("pnpm evals run", () => {
  it("--fake writes a versioned report and prints the scores", async () => {
    const t = io();
    expect(await evalsCli(["run", "--fake", "--out", "r.json"], t.io, deps())).toBe(0);
    const report = written(t.written, "r.json");
    expect(report.kind).toBe("fake");
    expect(t.text()).toContain("total");
    expect(t.text()).toContain("recall");
    expect(t.text()).toContain("r.json");
  });

  it("defaults the report path by kind and time", async () => {
    const t = io();
    expect(await evalsCli(["run", "--fake", "--only", "pr-912"], t.io, deps())).toBe(0);
    expect(Object.keys(t.written)).toEqual(["reports/fake-2026-10-27T12-00-00-000Z.json"]);
  });

  it("--dry-run makes no call and writes nothing", async () => {
    const t = io();
    expect(await evalsCli(["run", "--dry-run"], t.io, deps())).toBe(0);
    expect(t.written).toEqual({});
    expect(t.text()).toContain("dry run");
    expect(t.text()).toContain("claude-opus-5-5");
    expect(t.text()).toContain("pr-1205");
  });

  it("a live run with its key missing stops before any call and names the variable", async () => {
    const t = io();
    expect(await evalsCli(["run"], t.io, deps(["ANTHROPIC_API_KEY"]))).toBe(2);
    expect(t.text()).toContain("ANTHROPIC_API_KEY");
    expect(t.written).toEqual({});
  });

  it("never prints or stores the key", async () => {
    const t = io({}, { ANTHROPIC_API_KEY: KEY });
    // The live roles here fail every call (auth), so each PR fails and the report is written.
    expect(await evalsCli(["run", "--out", "live.json", "--only", "pr-912"], t.io, deps())).toBe(0);
    expect(t.text()).not.toContain(KEY);
    expect(t.written["live.json"]).not.toContain(KEY);
    expect(written(t.written, "live.json").prs[0]).toMatchObject({
      status: "failed",
      failure: "llm_auth",
    });
  });

  it("exits 1 when the token cap stops the run, and still writes the partial report", async () => {
    const t = io();
    expect(
      await evalsCli(["run", "--fake", "--max-tokens", "5000", "--out", "c.json"], t.io, deps()),
    ).toBe(1);
    expect(written(t.written, "c.json").usage.capped).toBe(true);
    expect(t.text()).toContain("token cap");
  });

  it.each([
    [["run", "--max-tokens", "lots"]],
    [["run", "--max-tokens", "0"]],
    [["run", "--only", "pr-1"]],
    [["run", "--bogus"]],
    [["fly"]],
    [[]],
  ])("rejects bad usage %j with exit 2", async (argv) => {
    const t = io();
    expect(await evalsCli(argv, t.io, deps())).toBe(2);
    expect(t.text()).toMatch(/usage|unknown|--max-tokens|pr-1/i);
  });
});

describe("pnpm evals compare", () => {
  const fake = async () => {
    const t = io();
    await evalsCli(["run", "--fake", "--out", "a.json"], t.io, deps());
    return t.written["a.json"]!;
  };

  it("exits 0 when the gate passes", async () => {
    const a = await fake();
    const t = io({ "base.json": a, "new.json": a });
    expect(await evalsCli(["compare", "base.json", "new.json"], t.io, deps())).toBe(0);
    expect(t.text()).toContain("gate passed");
  });

  it("exits 1 when recall dropped more than 5 points", async () => {
    const a = JSON.parse(await fake()) as EvalReport;
    const worse = structuredClone(a);
    // Two fewer matches per PR, as a consistent report: each lost match is a false positive.
    for (const pr of worse.prs) {
      pr.matched -= 2;
      pr.recall = pr.matched / pr.expected;
      pr.precision = pr.matched / pr.produced;
    }
    worse.total = totalsOf(worse.prs);
    const t = io({ "base.json": JSON.stringify(a), "new.json": JSON.stringify(worse) });
    expect(await evalsCli(["compare", "base.json", "new.json"], t.io, deps())).toBe(1);
    expect(t.text()).toContain("recall dropped");
  });

  it("exits 3 on a placeholder baseline", async () => {
    const placeholder = await readFile(
      new URL("../../baselines/live.json", import.meta.url),
      "utf8",
    );
    const t = io({ "base.json": placeholder, "new.json": await fake() });
    expect(await evalsCli(["compare", "base.json", "new.json"], t.io, deps())).toBe(3);
    expect(t.text()).toContain("placeholder");
  });

  it("exits 2 on a missing or malformed file", async () => {
    const t = io({ "bad.json": '{"format":"x"}' });
    expect(await evalsCli(["compare", "missing.json", "bad.json"], t.io, deps())).toBe(2);
    expect(await evalsCli(["compare", "bad.json", "bad.json"], t.io, deps())).toBe(2);
    expect(await evalsCli(["compare", "bad.json"], t.io, deps())).toBe(2);
  });

  it("exits 2 on a baseline or report that ran only some PRs (review round 1)", async () => {
    const full = await fake();
    const t = io();
    await evalsCli(["run", "--fake", "--only", "pr-912", "--out", "only.json"], t.io, deps());
    const only = t.written["only.json"]!;
    const c = io({ "full.json": full, "only.json": only });
    expect(await evalsCli(["compare", "only.json", "full.json"], c.io, deps())).toBe(2);
    expect(c.text()).toContain("a baseline must run every seeded PR");
    expect(await evalsCli(["compare", "full.json", "only.json"], c.io, deps())).toBe(2);
    expect(c.text()).toContain("a gated report must run every seeded PR");
  });
});
