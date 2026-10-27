import { LLM_COMPLETION_ROLES } from "@rocky-reviews/core";
import type { AnalysisDocument, Finding, TriagedFile } from "@rocky-reviews/schema";
import type { UsageReport } from "./budget.js";
import type { Plan } from "./plan.js";
import { oneLine, terminalText } from "./terminal.js";

/**
 * The CLI's text output (P4-8): the briefing as a reviewer reads it before the diff, the dry-run
 * plan and the token usage. Plain text, no colour codes, so the output stays greppable and
 * nothing here emits a control sequence of its own. Every string from the pull request or a
 * model passes through `oneLine` (fields) or `terminalText` (bodies, behind a gutter) on its way
 * out.
 */

export interface PullRequestHeader {
  readonly fullName: string;
  readonly number: number;
  /** Untrusted (the PR's author wrote it). */
  readonly title: string;
  readonly state: string;
}

const LEVELS: readonly TriagedFile["level"][] = ["critical", "important", "normal", "low"];
const SEVERITIES: readonly Finding["severity"][] = ["critical", "high", "medium", "low"];

const fmt = (n: number): string => n.toLocaleString("en-US");
const short = (sha: string): string => sha.slice(0, 7);

/**
 * Model-written multi-line text (a reason, the summary, a finding body), sanitised, with every
 * line behind a fixed gutter: an injected line such as `Verdict: LOW` or `[F9] src/x.ts:1` then
 * never starts where Rocky's own structure does (review round 1, item 5).
 */
const GUTTER = "\u2502 ";
const indent = (text: string, prefix: string): string[] =>
  terminalText(text)
    .split("\n")
    .map((line) => `${prefix}${GUTTER}${line}`.trimEnd());

const lineRange = (finding: Finding): string =>
  finding.range.start === finding.range.end
    ? `${finding.range.start}`
    : `${finding.range.start}-${finding.range.end}`;

export const renderBriefing = (doc: AnalysisDocument, pr: PullRequestHeader): string => {
  const { briefing, provenance, triage, findings } = doc;
  const out: string[] = [];
  out.push(`Rocky briefing: ${oneLine(pr.fullName)}#${pr.number} (${oneLine(pr.state)})`);
  out.push(`Title: ${oneLine(pr.title)}`);
  out.push(`Base ${short(provenance.base.sha)} -> head ${short(provenance.head.sha)}`);
  const roles = provenance.generator.roles.map(
    (role) => `${role.role} ${oneLine(role.provider ?? "?")}/${oneLine(role.model)}`,
  );
  if (roles.length > 0) out.push(`Models: ${roles.join(", ")}`);
  out.push("");

  out.push(`Verdict: ${briefing.verdict.level.toUpperCase()}`);
  out.push(...indent(briefing.verdict.reason, "  "));
  if (provenance.briefingUnavailable !== undefined) {
    out.push(
      `  AI briefing unavailable (${provenance.briefingUnavailable.reason}): Rocky wrote this briefing from its rules, the triage and the draft findings.`,
    );
  }
  out.push("");
  out.push("Summary");
  out.push(...indent(briefing.summary, "  "));
  out.push(`  Estimated review: ${briefing.estimatedReviewMinutes} min`);
  out.push("");

  out.push("Risk");
  const width = Math.max(
    0,
    ...triage.files.map((file) => oneLine(file.path).length),
    ...triage.noise.map((file) => oneLine(file.path).length),
  );
  for (const level of LEVELS) {
    const files = triage.files.filter((file) => file.level === level);
    out.push(`  ${level} (${files.length})`);
    for (const file of files) {
      out.push(
        `    ${oneLine(file.path).padEnd(width)}  score ${String(file.score).padStart(3)}  ${file.reviewMinutes} min  ${oneLine(file.reason)}`,
      );
    }
  }
  out.push(`  noise (${triage.noise.length})`);
  for (const file of triage.noise) {
    out.push(`    ${oneLine(file.path).padEnd(width)}  ${oneLine(file.summary)}`);
  }
  out.push("");

  out.push(`Findings (${findings.length})`);
  for (const severity of SEVERITIES) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    out.push(`  ${severity.toUpperCase()} (${group.length})`);
    for (const finding of group) {
      out.push(
        `    [${oneLine(finding.id)}] ${oneLine(finding.path)}:${lineRange(finding)}  ${oneLine(finding.title)}  (confidence ${finding.confidence})`,
      );
      out.push(...indent(finding.body, "        "));
      if (finding.suggestion !== undefined) {
        out.push("        Suggested replacement:");
        for (const line of finding.suggestion.lines) out.push(`          | ${oneLine(line)}`);
      }
    }
  }
  if (findings.length === 0) out.push("  (none)");
  out.push("");

  out.push("Review path");
  briefing.reviewPath.forEach((step, index) => {
    out.push(`  ${index + 1}. ${oneLine(step.path)}: ${oneLine(step.why)}`);
  });
  if (briefing.reviewPath.length === 0) out.push("  (none)");
  if (briefing.checkedOk.length > 0) {
    out.push("");
    out.push("Checked and fine (by the AI)");
    for (const item of briefing.checkedOk) out.push(`  - ${oneLine(item)}`);
  }
  out.push("");

  out.push(
    `Read by hand (${provenance.readByHand.length}): risky files the AI reviewed and drafted nothing for`,
  );
  for (const file of provenance.readByHand) out.push(`  - ${oneLine(file.path)}`);
  out.push(`Not analysed (${provenance.unanalysed.length})`);
  for (const file of provenance.unanalysed) {
    out.push(
      `  - ${oneLine(file.path)} (${file.reason})${file.detail === undefined ? "" : `: ${oneLine(file.detail)}`}`,
    );
  }
  out.push(
    `Change map: ${
      doc.graph !== undefined
        ? "drawn"
        : provenance.graphUnavailable !== undefined
          ? `unavailable (${provenance.graphUnavailable.reason})`
          : "none"
    }`,
  );
  return `${out.join("\n")}\n`;
};

/**
 * Prices a run's usage (P4-5 seam): once the price table merges, the CLI passes one and the usage
 * block gains a cost line. Undefined today.
 */
export type UsagePricer = (report: UsageReport) => string | undefined;

export const renderUsage = (report: UsageReport, price?: UsagePricer): string => {
  const out: string[] = [`Token usage (cap ${fmt(report.cap)})`];
  for (const role of LLM_COMPLETION_ROLES) {
    const usage = report.roles[role];
    if (usage.calls === 0) continue;
    const who = `${oneLine(usage.provider ?? "?")}/${usage.models.map(oneLine).join("+")}`;
    out.push(
      `  ${role.padEnd(7)} ${who}  ${usage.calls} ${usage.calls === 1 ? "call" : "calls"}  in ${fmt(usage.inputTokens)}  out ${fmt(usage.outputTokens)}  cache read ${fmt(usage.cacheReadInputTokens)}  cache write ${fmt(usage.cacheWriteInputTokens)}  total ${fmt(usage.totalTokens)}${usage.unreported > 0 ? `  (${usage.unreported} unreported)` : ""}`,
    );
  }
  out.push(`  total   ${fmt(report.totalTokens)} tokens`);
  out.push(`  cost    ${price?.(report) ?? "not priced yet (the price table comes with P4-5)"}`);
  return `${out.join("\n")}\n`;
};

export const renderCapStop = (report: UsageReport): string => {
  const stop = report.stopped;
  if (stop === undefined) return "";
  return `rocky: token cap of ${fmt(stop.cap)} reached: ${fmt(stop.usedTokens)} used, ${fmt(stop.reservedTokens)} held by calls in flight, and the next ${stop.role} call may need ${fmt(stop.nextCallTokens)}. Nothing was printed; raise --max-tokens (see --dry-run) to finish.\n`;
};

const DISPOSITION: Readonly<Record<string, string>> = {
  noise: "noise",
  binary: "not analysed (binary)",
  "too-large": "not analysed (too large)",
  triage: "triage",
};

export const renderPlan = (
  plan: Plan & { ok: true },
  pr: PullRequestHeader,
  cap: number,
): string => {
  const out: string[] = [];
  out.push(`Dry run: ${oneLine(pr.fullName)}#${pr.number} (${oneLine(pr.state)}). No model calls.`);
  out.push(`Title: ${oneLine(pr.title)}`);
  out.push("");
  out.push(`Pre-triage (Rocky's rules, ${plan.files.length} files)`);
  const width = Math.max(0, ...plan.files.map((file) => oneLine(file.path).length));
  for (const file of plan.files) {
    const extra =
      file.disposition === "noise"
        ? ` (${file.rule})`
        : file.floor !== undefined
          ? `, floored ${file.floor} (${file.rule})`
          : "";
    out.push(`  ${oneLine(file.path).padEnd(width)}  ${DISPOSITION[file.disposition]}${extra}`);
  }
  out.push("");
  out.push("Planned calls (input estimate + output cap, in tokens)");
  for (const stage of ["triage", "review", "graph", "briefing"] as const) {
    const calls = plan.calls.filter((call) => call.stage === stage);
    if (calls.length === 0) {
      out.push(
        `  ${stage.padEnd(8)} none${stage === "graph" && plan.graphSkipped ? " (PR too large for the change map)" : ""}`,
      );
      continue;
    }
    const certain = calls.filter((call) => call.certain).length;
    const input = calls.reduce((sum, call) => sum + call.inputTokens, 0);
    const output = calls.reduce((sum, call) => sum + call.maxOutputTokens, 0);
    const count =
      certain === calls.length
        ? `${calls.length} ${calls.length === 1 ? "call" : "calls"}`
        : `${certain} to ${calls.length} calls (depends on the triage)`;
    out.push(`  ${stage.padEnd(8)} ${count}  input ~${fmt(input)}  output cap ${fmt(output)}`);
  }
  out.push("");
  out.push(`Certain calls: ~${fmt(plan.certainTokens)} tokens at their caps`);
  out.push(
    `Worst case: ~${fmt(plan.worstCaseTokens)} tokens (every possible call, each with a repair round)`,
  );
  out.push(
    `Token cap ${fmt(cap)}: ${
      plan.worstCaseTokens <= cap
        ? "the worst case fits."
        : plan.certainTokens <= cap
          ? "the certain calls fit; the run stops if real usage climbs past it."
          : "too low for the certain calls; raise --max-tokens."
    }`,
  );
  return `${out.join("\n")}\n`;
};
