/**
 * Scripted model answers for pr-847 (P4-3). Each answer is what the P1-3 fixture says a good model
 * would have produced for that call, keyed only by what the call carries (role and untrusted
 * parts), so the pipeline's wiring decides what reaches the document: which files are triaged,
 * which are reviewed, how answers are validated and repaired, and what is stored.
 *
 * Decoys catch wiring mistakes: a noise file sent to triage, or a file below `important` sent to
 * review, gets a critical answer that would show up as a critical false positive. One answer is
 * wrong on purpose (a finding outside the diff) so the repair round is exercised.
 *
 * This measures the pipeline, not a model: real model quality is P4-7 and P4-8.
 */
import type { ScriptedAnswer, ScriptedCall } from "@rocky-reviews/core/testing";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import fixture from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };

export const PR847 = fixture as unknown as AnalysisDocument;

/** The file whose first review answer is wrong, to exercise the repair round. */
export const REPAIRED_PATH = "src/jobs/sendInviteEmail.ts";

const DECOY_TRIAGE = {
  score: 99,
  level: "critical",
  reviewMinutes: 5,
  reason: "Decoy: this file should never reach triage.",
  whatChanged: "Decoy.",
  whyThisLevel: "Decoy.",
  flags: [],
};

const decoyFinding = {
  severity: "critical",
  confidence: 99,
  range: { start: 1, end: 1 },
  title: "Decoy: this file should never reach review",
  body: "Decoy.",
  agentPrompt: "Decoy.",
};

const REVIEWED = new Set(
  PR847.triage.files
    .filter((file) => file.level === "critical" || file.level === "important")
    .map((file) => file.path),
);

const reviewAnswer = (path: string, repair: boolean): ScriptedAnswer => {
  if (!REVIEWED.has(path)) return { value: { findings: [decoyFinding] } };
  const findings = PR847.findings
    .filter((finding) => finding.path === path)
    .map((finding, index) => ({
      severity: finding.severity,
      confidence: finding.confidence,
      range:
        path === REPAIRED_PATH && !repair && index === 0 ? { start: 99, end: 99 } : finding.range,
      title: finding.title,
      body: finding.body,
      ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
      agentPrompt: finding.agentPrompt,
    }));
  return { value: { findings } };
};

export const pr847Script = (call: ScriptedCall): ScriptedAnswer => {
  const path = call.part("file_path");
  if (call.role === "triage") {
    const entry = PR847.triage.files.find((file) => file.path === path);
    if (entry === undefined) return { value: DECOY_TRIAGE };
    const answer: Record<string, unknown> = { ...entry };
    delete answer["path"];
    return { value: answer };
  }
  if (call.role === "review" && path !== undefined) return reviewAnswer(path, call.repair);
  if (call.role === "review") {
    const { summary, verdict, reviewPath, checkedOk } = PR847.briefing;
    return { value: { summary, verdict, reviewPath, checkedOk } };
  }
  if (call.role === "graph") return { value: PR847.graph };
  return { status: "refused" };
};
