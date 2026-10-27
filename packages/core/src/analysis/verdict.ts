/**
 * Verdict floors (P4-3, ADR 0014 §2; review round 1, Fix A). The PR verdict never sits below:
 *
 * - what the findings say (a critical finding → critical, a high one → at least medium);
 * - the risk of a file that was not reviewed: a file the rules floor (migration, auth path) or
 *   that triage called critical → at least high; one triage called important → at least medium.
 *
 * Otherwise a PR author could make a risky file fail on purpose (a refused review, a padded or
 * binary file) and talk the briefing into "low", and a stored document would say "low" with the
 * auth file sitting only in `provenance.unanalysed`.
 *
 * `belowUnanalysedRuleFloor` re-checks the rules half on a stored document (the pipeline's final
 * check and `completeAnalysis`). The triage half cannot be re-checked there: an unanalysed file
 * carries no triage level in the document, and adding one is a schema change (ADR 0014 §2).
 */
import type { AnalysisDocument, Finding, RiskLevel, TriagedFile } from "@rocky-reviews/schema";
import { preTriage, type FloorLevel } from "./rules.js";

const RANK: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export const maxRisk = (...levels: RiskLevel[]): RiskLevel =>
  levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "low");

export const findingsFloor = (findings: readonly Finding[]): RiskLevel => {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "high")) return "medium";
  return "low";
};

/** What is known about a file that was not reviewed: its rules floor and its triage level. */
export interface UnreviewedRisk {
  readonly ruleFloor?: FloorLevel | undefined;
  readonly level?: TriagedFile["level"] | undefined;
}

export const unreviewedFloor = (files: readonly UnreviewedRisk[]): RiskLevel =>
  maxRisk(
    ...files.map((file): RiskLevel =>
      file.ruleFloor !== undefined || file.level === "critical"
        ? "high"
        : file.level === "important"
          ? "medium"
          : "low",
    ),
  );

/** True when an unanalysed file on a rules-floored path sits above the stored verdict. */
export const belowUnanalysedRuleFloor = (document: AnalysisDocument): boolean => {
  const floor = unreviewedFloor(
    document.provenance.unanalysed.map((file) => {
      const rule = preTriage(file.path);
      return { ruleFloor: rule.kind === "analyse" ? rule.floor : undefined };
    }),
  );
  return RANK[document.briefing.verdict.level] < RANK[floor];
};
