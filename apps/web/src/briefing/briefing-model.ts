/**
 * The briefing's view of an analysis document (P6-2, POC `renderBrief`): the risk table rows,
 * short file names, the suggested path, the change map's state and the fixed text for pipeline
 * reasons and failure codes. Pure, so it is tested without a DOM. Every text Rocky shows for a
 * reason or code is fixed here; the document only picks which.
 */
import type {
  AnalysisDocument,
  GraphUnavailableReason,
  RiskLevel,
  TriagedFileLevel,
} from "@rocky-reviews/schema";

export type RiskRowKey = "critical" | "important" | "normal" | "ignore" | "unanalysed";

export type RiskFile = { path: string; name: string };

export type RiskRow = { key: RiskRowKey; label: string; text: string; files: RiskFile[] };

const files = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

/**
 * The shortest trailing part of each path that no other path shares (POC defect 4: two files
 * showed as `invitations.ts`).
 */
export const shortNames = (paths: readonly string[]): Map<string, string> => {
  const parts = new Map(paths.map((p) => [p, p.split("/")]));
  const depth = new Map(paths.map((p) => [p, 1]));
  const name = (p: string) => (parts.get(p) ?? []).slice(-(depth.get(p) ?? 1)).join("/");
  for (;;) {
    const seen = new Map<string, string[]>();
    for (const p of paths) seen.set(name(p), [...(seen.get(name(p)) ?? []), p]);
    const clashes = [...seen.values()].filter((group) => group.length > 1).flat();
    const widen = clashes.filter((p) => (depth.get(p) ?? 1) < (parts.get(p)?.length ?? 1));
    if (widen.length === 0) break;
    for (const p of widen) depth.set(p, (depth.get(p) ?? 1) + 1);
  }
  return new Map(paths.map((p) => [p, name(p)]));
};

const byScore = (doc: AnalysisDocument, level: TriagedFileLevel): string[] =>
  doc.triage.files
    .filter((f) => f.level === level)
    .toSorted((a, b) => b.score - a.score)
    .map((f) => f.path);

/** Every file the risk table and read-by-hand list can show, for one set of short names. */
const shownPaths = (doc: AnalysisDocument): string[] => [
  ...doc.triage.files.map((f) => f.path),
  ...doc.triage.noise.map((f) => f.path),
  ...doc.provenance.unanalysed.map((f) => f.path),
];

/** The POC's risk table: critical, important, normal, ignore (low + noise), then unanalysed. */
export const riskRows = (doc: AnalysisDocument): RiskRow[] => {
  const names = shortNames(shownPaths(doc));
  const rows: [RiskRowKey, string, string[]][] = [
    ["critical", "Critical", byScore(doc, "critical")],
    ["important", "Important", byScore(doc, "important")],
    ["normal", "Normal", byScore(doc, "normal")],
    ["ignore", "Ignore", [...byScore(doc, "low"), ...doc.triage.noise.map((f) => f.path)]],
  ];
  const unanalysed = doc.provenance.unanalysed.map((f) => f.path);
  if (unanalysed.length > 0) rows.push(["unanalysed", "Not analysed", unanalysed]);
  return rows.map(([key, label, paths]) => ({
    key,
    label,
    text: rowText(key, paths.length),
    files: paths.map((path) => ({ path, name: names.get(path) ?? path })),
  }));
};

const rowText = (key: RiskRowKey, n: number): string => {
  switch (key) {
    case "critical":
      return `${files(n)} ${n === 1 ? "needs" : "need"} your attention`;
    case "important":
      return `${files(n)} worth a careful look`;
    case "normal":
      return `${files(n)} to skim`;
    case "ignore":
      return `${files(n)} don't matter`;
    case "unanalysed":
      return `${files(n)} the AI couldn't analyse: read ${n === 1 ? "it" : "them"} yourself`;
  }
};

/** Short names for the read-by-hand list, consistent with the risk table. */
export const nameOf = (doc: AnalysisDocument): ((path: string) => string) => {
  const names = shortNames(shownPaths(doc));
  return (path) => names.get(path) ?? path;
};

export type PathRow = { path: string; why: string; score: number; level: TriagedFileLevel };

export const reviewPathRows = (doc: AnalysisDocument): PathRow[] => {
  const triaged = new Map(doc.triage.files.map((f) => [f.path, f]));
  return doc.briefing.reviewPath.flatMap((step) => {
    const file = triaged.get(step.path);
    return file === undefined
      ? []
      : [{ path: step.path, why: step.why, score: file.score, level: file.level }];
  });
};

/** Where "Start with the riskiest file" goes: the path's first stop, else the top triaged file. */
export const startFile = (doc: AnalysisDocument): string | undefined =>
  doc.briefing.reviewPath[0]?.path ??
  doc.triage.files.toSorted((a, b) => b.score - a.score)[0]?.path;

export const readByHand = (doc: AnalysisDocument): string[] =>
  doc.provenance.readByHand.map((f) => f.path);

export const VERDICT_LABEL: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical risk",
};

const GRAPH_REASON: Record<GraphUnavailableReason, string> = {
  "analysis-failed": "The AI's map of this change did not pass Rocky's checks.",
  "too-large": "This pull request is too large to map.",
  timeout: "The map took too long to produce.",
};

export const BRIEFING_REASON: Record<GraphUnavailableReason, string> = {
  "analysis-failed": "The AI's briefing did not pass Rocky's checks",
  "too-large": "The pull request was too large for an AI briefing",
  timeout: "The AI's briefing took too long",
};

export type GraphState =
  | { kind: "drawn" }
  /** `detail` is pipeline-written fixed text (`provenance.graphUnavailable.detail`). */
  | { kind: "unavailable"; reason?: string; detail?: string };

export const graphState = (doc: AnalysisDocument): GraphState => {
  if (doc.graph !== undefined) return { kind: "drawn" };
  const missing = doc.provenance.graphUnavailable;
  if (missing === undefined) return { kind: "unavailable" };
  return {
    kind: "unavailable",
    reason: GRAPH_REASON[missing.reason],
    ...(missing.detail === undefined ? {} : { detail: missing.detail }),
  };
};

/** Plain words for a stored failure code (`analyses.error_code`); unknown codes get the last. */
export const failureText = (code: string): string => {
  if (code.startsWith("llm_"))
    return "The AI provider could not complete the analysis. Rocky stopped instead of guessing.";
  if (code === "diff_truncated") return "The diff is too large for Rocky to analyse in one run.";
  if (code === "diff_empty") return "The pull request has no changes Rocky can analyse.";
  if (code.startsWith("diff_")) return "Rocky could not read this pull request's diff.";
  if (code === "repository_inaccessible" || code === "no_org")
    return "Rocky can no longer read this repository. Check that the GitHub App is still installed with access to it.";
  if (code === "metering_failed")
    return "Rocky could not record the AI usage for this run, so it stopped before spending more.";
  return "Something went wrong on Rocky's side.";
};
