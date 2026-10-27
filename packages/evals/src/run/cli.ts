/**
 * `pnpm evals` (P4-7). The entry point (`scripts/evals.ts`) wires the real LLM roles in; this
 * module owns arguments, output and exit codes, and is tested with injected I/O.
 *
 *   pnpm evals run [--fake] [--dry-run] [--injection] [--max-tokens N] [--only id,…] [--out path]
 *   pnpm evals compare <baseline.json> <report.json>
 *
 * Exit codes: 0 ok; 1 gate failed (compare) or the token cap stopped the run (run); 2 usage,
 * config or file error; 3 the baseline is a placeholder (no real-model baseline yet).
 *
 * Output is ids, counts, scores, model names and variable names only: never a key, a prompt,
 * PR content or model text.
 */
import { parseArgs } from "node:util";
import type { Clock, LlmRoles } from "@rocky-reviews/core";
import { INJECTION_CORPUS } from "../injection/corpus.js";
import { INJECTION_FIXTURES } from "../injection/inject.js";
import { SEEDED_PRS } from "../seeded/index.js";
import { compareReports, PlaceholderBaselineError } from "./compare.js";
import { parseReport, type EvalReport, type ReportModels } from "./report.js";
import { runEvals, type EvalSubject } from "./runner.js";

/** Default spend cap: the seeded PRs fit well inside it; `--injection` needs a higher one. */
export const DEFAULT_MAX_TOKENS = 1_000_000;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** Where a report goes without `--out`; `stamp` is the run's time, safe in a file name. */
  defaultOut(kind: "fake" | "live", stamp: string): string;
}

/** The real roles from `ROCKY_LLM_*`. Throws an Error whose message is safe to print. */
export interface LiveTarget {
  readonly models: ReportModels;
  readonly roles: LlmRoles;
  /** Key variables the config names that are unset (names only). */
  readonly missingSecrets: readonly string[];
}

export interface FakeTargetLike {
  readonly models: ReportModels;
  rolesFor(subject: EvalSubject): LlmRoles;
}

export interface CliDeps {
  live(env: CliIo["env"]): LiveTarget;
  /** Defaults to the scripted target, loaded only when `--fake` is given. */
  fake?(): Promise<FakeTargetLike>;
}

const USAGE = [
  "usage:",
  "  pnpm evals run [--fake] [--dry-run] [--injection] [--max-tokens N] [--only pr-847,…] [--out report.json]",
  "  pnpm evals compare <baseline.json> <report.json>",
  "",
].join("\n");

const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`.padStart(6);

class UsageError extends Error {}

const loadFake = async (): Promise<FakeTargetLike> =>
  (await import("./fake/test-support.js")).fakeTarget();

const summary = (report: EvalReport): string => {
  const lines = [
    `${report.kind} run, pipeline ${report.pipelineVersion}, prompt ${report.promptHash.slice(0, 12)}`,
    ...Object.entries(report.models).map(
      ([role, m]) => `  ${role}: ${m.provider}/${m.model} (${m.effort ?? "default"})`,
    ),
    "",
    "PR          status  recall  precision  critical FP",
    ...report.prs.map(
      (pr) =>
        `${pr.id.padEnd(11)} ${pr.status.padEnd(7)} ${pct(pr.recall)}  ${pct(pr.precision)}     ${pr.criticalFalsePositives}/${pr.criticalProduced}`,
    ),
    `${"total".padEnd(11)} ${"".padEnd(7)} ${pct(report.total.recall)}  ${pct(report.total.precision)}     ${report.total.criticalFalsePositives}/${report.total.criticalProduced} (${pct(report.total.criticalFalsePositiveRate).trim()})`,
    `matched ${report.total.matched} of ${report.total.expected} seeded findings; ${report.total.produced} produced`,
    "",
    "tokens by role:",
    ...Object.entries(report.usage.byRole).map(
      ([role, u]) =>
        `  ${role}: ${u.calls} calls, ${u.inputTokens} in, ${u.outputTokens} out, ${u.cacheReadInputTokens} cache read, ${u.cacheWriteInputTokens} cache write`,
    ),
    `  total: ${report.usage.totalTokens} of ${report.options.maxTokens}${report.usage.capped ? " (token cap reached: the run is incomplete)" : ""}`,
  ];
  if (report.injection !== null) {
    const t = report.injection.total;
    lines.push(
      "",
      `injection: ${t.cases} cases; verdict changed ${t.verdictChanged}, below floor ${t.belowFloor}, outside the diff ${t.outsideDiff}, leaks ${t.leaks}, poisoned ${t.poisoned}, unexpected failures ${t.unexpectedFailures}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const run = async (args: string[], io: CliIo, deps: CliDeps): Promise<number> => {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      fake: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      injection: { type: "boolean", default: false },
      "max-tokens": { type: "string" },
      only: { type: "string" },
      out: { type: "string" },
    },
  });
  const maxTokens =
    values["max-tokens"] === undefined ? DEFAULT_MAX_TOKENS : Number(values["max-tokens"]);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
    throw new UsageError("--max-tokens must be a positive whole number");
  const only = values.only
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = (only ?? []).filter((id) => !SEEDED_PRS.some((pr) => pr.id === id));
  if (unknown.length > 0)
    throw new UsageError(
      `unknown seeded PR ${unknown.join(", ")} (known: ${SEEDED_PRS.map((pr) => pr.id).join(", ")})`,
    );
  const kind = values.fake ? "fake" : "live";

  let models: ReportModels;
  let rolesFor: (subject: EvalSubject) => LlmRoles;
  if (kind === "fake") {
    const target = await (deps.fake ?? loadFake)();
    models = target.models;
    rolesFor = (subject) => target.rolesFor(subject);
  } else {
    let target: LiveTarget;
    try {
      target = deps.live(io.env);
    } catch (error) {
      io.stderr(`evals: ${error instanceof Error ? error.message : "invalid LLM configuration"}\n`);
      return 2;
    }
    if (target.missingSecrets.length > 0) {
      io.stderr(
        `evals: set ${target.missingSecrets.join(", ")} (the provider key) to run against real models, or pass --fake\n`,
      );
      return 2;
    }
    models = target.models;
    rolesFor = () => target.roles;
  }

  const prs = only === undefined ? SEEDED_PRS : SEEDED_PRS.filter((pr) => only.includes(pr.id));
  if (values["dry-run"]) {
    io.stdout(
      [
        `dry run (${kind}): no model is called and no report is written`,
        ...Object.entries(models).map(
          ([role, m]) => `  ${role}: ${m.provider}/${m.model} (${m.effort ?? "default"})`,
        ),
        `seeded PRs: ${prs.map((pr) => `${pr.id} (${pr.expected.length} seeded)`).join(", ")}`,
        `injection: ${values.injection ? `${INJECTION_CORPUS.length * INJECTION_FIXTURES.length} cases` : "off"}`,
        `token cap: ${maxTokens}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  const report = await runEvals({
    kind,
    models,
    rolesFor,
    maxTokens,
    injection: values.injection,
    ...(only === undefined ? {} : { only }),
    clock: io.clock,
    onProgress: (line) => io.stderr(`${line}\n`),
  });
  const out = values.out ?? io.defaultOut(kind, report.createdAt.replace(/[:.]/g, "-"));
  await io.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  io.stdout(summary(report));
  io.stdout(`report: ${out}\n`);
  if (report.usage.capped) {
    io.stderr("evals: the token cap stopped the run; raise --max-tokens for a complete report\n");
    return 1;
  }
  return 0;
};

const readReport = async (
  io: CliIo,
  path: string,
  purpose: "baseline" | "report",
): Promise<EvalReport> => {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch {
    throw new UsageError(`cannot read ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError(`${path} is not JSON`);
  }
  const parsed = parseReport(json, { purpose });
  if (!parsed.ok)
    throw new UsageError(`${path} is not an eval report: ${parsed.issues.join("; ")}`);
  return parsed.report;
};

const compare = async (args: string[], io: CliIo): Promise<number> => {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
  if (positionals.length !== 2) throw new UsageError("compare takes a baseline and a report");
  const [baselinePath, reportPath] = positionals as [string, string];
  const baseline = await readReport(io, baselinePath, "baseline");
  const report = await readReport(io, reportPath, "report");
  let result;
  try {
    result = compareReports(baseline, report);
  } catch (error) {
    if (!(error instanceof PlaceholderBaselineError)) throw error;
    io.stderr(
      `evals: ${baselinePath}: ${error.message} (placeholder baseline; gate not applied)\n`,
    );
    return 3;
  }
  io.stdout(
    [
      `PRs compared: ${result.common.join(", ") || "none"}`,
      `recall ${pct(result.baseline.recall).trim()} → ${pct(result.report.recall).trim()}`,
      `critical false-positive rate ${pct(result.baseline.criticalFalsePositiveRate).trim()} → ${pct(result.report.criticalFalsePositiveRate).trim()}`,
      ...result.notes.map((note) => `note: ${note}`),
      ...result.reasons.map((reason) => `FAIL: ${reason}`),
      result.ok ? "gate passed" : "gate failed",
      "",
    ].join("\n"),
  );
  return result.ok ? 0 : 1;
};

export const evalsCli = async (
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps,
): Promise<number> => {
  const [command, ...args] = argv;
  try {
    if (command === "run") return await run(args, io, deps);
    if (command === "compare") return await compare(args, io);
    throw new UsageError(command === undefined ? "no command" : `unknown command ${command}`);
  } catch (error) {
    const known =
      error instanceof UsageError ||
      (error instanceof TypeError &&
        "code" in error &&
        String(error.code).startsWith("ERR_PARSE_ARGS"));
    if (!known) throw error;
    io.stderr(`evals: ${error.message}\n${USAGE}`);
    return 2;
  }
};
