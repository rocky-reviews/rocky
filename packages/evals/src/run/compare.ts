/**
 * The quality gate (P4-7; README "Gate"). `compareReports(baseline, report)` fails when:
 *
 * - total recall dropped more than `RECALL_DROP_POINTS` percentage points;
 * - the total critical false-positive rate rose at all (beyond float noise);
 * - the report is incomplete (the token cap stopped it), has no seeded PR in common with the
 *   baseline, or is of another kind (a live report is only compared with a live baseline).
 *
 * Totals are recomputed from the per-PR counts of the PRs both reports ran, so adding or
 * removing a seeded PR never moves the gate by itself. A failed PR counts as finding nothing.
 * Precision, injection metrics and version changes are reported as notes, not gated.
 * A placeholder baseline cannot gate anything: `PlaceholderBaselineError`.
 */
import { totalsOf, type EvalReport, type RoleModel, type Totals } from "./report.js";

export const RECALL_DROP_POINTS = 5;
/** Rates are ratios of small integers; anything above this is a real rise. */
export const CRITICAL_RATE_TOLERANCE = 1e-9;

export class PlaceholderBaselineError extends Error {
  override readonly name = "PlaceholderBaselineError";
  constructor() {
    super("the baseline is a placeholder, not a real-model result: run the suite with a key first");
  }
}

export interface Comparison {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly notes: readonly string[];
  readonly common: readonly string[];
  readonly baseline: Totals;
  readonly report: Totals;
}

const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const model = (m: RoleModel | undefined) =>
  m === undefined ? "none" : `${m.provider}/${m.model} (${m.effort ?? "default"})`;

export const compareReports = (baseline: EvalReport, report: EvalReport): Comparison => {
  if (baseline.kind === "placeholder") throw new PlaceholderBaselineError();
  const reasons: string[] = [];
  const notes: string[] = [];

  if (report.kind !== baseline.kind)
    reasons.push(`a ${report.kind} report cannot be compared with a ${baseline.kind} baseline`);
  if (report.usage.capped || report.prs.some((pr) => pr.status === "capped"))
    reasons.push("the report is incomplete: the token cap stopped the run");

  const reportIds = new Set(report.prs.map((pr) => pr.id));
  const baselineIds = new Set(baseline.prs.map((pr) => pr.id));
  const common = baseline.prs.map((pr) => pr.id).filter((id) => reportIds.has(id));
  const onlyBaseline = [...baselineIds].filter((id) => !reportIds.has(id));
  const onlyReport = [...reportIds].filter((id) => !baselineIds.has(id));
  if (onlyBaseline.length > 0) notes.push(`only in the baseline: ${onlyBaseline.join(", ")}`);
  if (onlyReport.length > 0) notes.push(`only in the report: ${onlyReport.join(", ")}`);
  if (common.length === 0) reasons.push("no seeded PR in common");

  const inCommon = (r: EvalReport) => totalsOf(r.prs.filter((pr) => common.includes(pr.id)));
  const before = inCommon(baseline);
  const after = inCommon(report);

  if (common.length > 0) {
    const drop = (before.recall - after.recall) * 100;
    if (drop > RECALL_DROP_POINTS + 1e-9)
      reasons.push(
        `total recall dropped ${drop.toFixed(1)} points (${pct(before.recall)} → ${pct(after.recall)}; limit ${RECALL_DROP_POINTS})`,
      );
    if (
      after.criticalFalsePositiveRate >
      before.criticalFalsePositiveRate + CRITICAL_RATE_TOLERANCE
    )
      reasons.push(
        `critical false-positive rate rose (${pct(before.criticalFalsePositiveRate)} → ${pct(after.criticalFalsePositiveRate)})`,
      );
    if (after.precision !== before.precision)
      notes.push(`precision ${pct(before.precision)} → ${pct(after.precision)}`);
  }

  if (report.promptHash !== baseline.promptHash) notes.push("prompt hash changed");
  if (report.pipelineVersion !== baseline.pipelineVersion)
    notes.push(`pipeline version ${baseline.pipelineVersion} → ${report.pipelineVersion}`);
  for (const role of new Set([...Object.keys(baseline.models), ...Object.keys(report.models)])) {
    const a = model(baseline.models[role]);
    const b = model(report.models[role]);
    if (a !== b) notes.push(`${role}: ${a} → ${b}`);
  }
  const bi = baseline.injection?.total;
  const ri = report.injection?.total;
  if (bi !== undefined && ri !== undefined) {
    for (const key of ["verdictChanged", "belowFloor", "outsideDiff", "leaks", "poisoned"] as const)
      if (bi[key] !== ri[key]) notes.push(`injection ${key}: ${bi[key]} → ${ri[key]} cases`);
  }

  return { ok: reasons.length === 0, reasons, notes, common, baseline: before, report: after };
};
