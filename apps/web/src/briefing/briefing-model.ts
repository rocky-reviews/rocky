/**
 * The briefing's view of an analysis document (P6-2, POC `renderBrief`): the risk levels,
 * short file names, the suggested path, the change map's state and the fixed text for pipeline
 * reasons and failure codes. Pure, so it is tested without a DOM. Every text Rocky shows for a
 * reason or code is fixed here; the document only picks which.
 */
import type {
  AnalysisDocument,
  BriefingUnavailableReason,
  GraphUnavailableReason,
  RiskLevel,
  TriagedFileLevel,
} from "@rocky-reviews/schema";
import type { AnalysisRun } from "./analysis-run.js";

export type RiskLevelKey = "critical" | "important" | "normal" | "ignore" | "unanalysed";

export type RiskFile = { path: string; name: string };

export type RiskLevelGroup = { key: RiskLevelKey; label: string; files: RiskFile[] };

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

/** Every file the risk levels and read-by-hand list can show, for one set of short names. */
const shownPaths = (doc: AnalysisDocument): string[] => [
  ...doc.triage.files.map((f) => f.path),
  ...doc.triage.noise.map((f) => f.path),
  ...doc.provenance.unanalysed.map((f) => f.path),
];

/**
 * The files by risk (H4-10: count chips; the POC's risk table): critical, important, normal,
 * unanalysed (files to read by hand rank above ignore, as in the sidebar), then ignore (low +
 * noise), each level only when it has files.
 */
export const riskLevels = (doc: AnalysisDocument): RiskLevelGroup[] => {
  const names = shortNames(shownPaths(doc));
  const levels: [RiskLevelKey, string, string[]][] = [
    ["critical", "Critical", byScore(doc, "critical")],
    ["important", "Important", byScore(doc, "important")],
    ["normal", "Normal", byScore(doc, "normal")],
    ["unanalysed", "Not analysed", doc.provenance.unanalysed.map((f) => f.path)],
    ["ignore", "Ignore", [...byScore(doc, "low"), ...doc.triage.noise.map((f) => f.path)]],
  ];
  return levels
    .filter(([, , paths]) => paths.length > 0)
    .map(([key, label, paths]) => ({
      key,
      label,
      files: paths.map((path) => ({ path, name: names.get(path) ?? path })),
    }));
};

/** The level selected first: the first present, as levels come riskiest first. */
export const defaultRiskLevel = (levels: readonly RiskLevelGroup[]): RiskLevelKey | undefined =>
  levels[0]?.key;

/** A level the reviewer picked, for the document (head commit) it was picked on. */
export type RiskChoice = { head: string; key: RiskLevelKey };

/**
 * The selected level: the reviewer's choice while it is for this document's head commit and the
 * level still has files; otherwise the default, so a new document starts on its riskiest level.
 */
export const selectedRiskLevel = (
  levels: readonly RiskLevelGroup[],
  head: string,
  choice: RiskChoice | undefined,
): RiskLevelGroup | undefined =>
  (choice?.head === head ? levels.find((l) => l.key === choice.key) : undefined) ??
  levels.find((l) => l.key === defaultRiskLevel(levels));

/**
 * Where a key moves the focus in a WAI-ARIA tab list of `count` tabs, from tab `index`: Left and
 * Right wrap, Home and End go to the ends; any other key is not the tab list's.
 */
export const tabKeyTarget = (count: number, index: number, key: string): number | undefined => {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
};

/** Short names for the read-by-hand list, consistent with the risk levels. */
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

/**
 * What the briefing opens with (H4-8): the TL;DR bullets of a schema 1.4 document, or the summary
 * paragraph every older document (and Rocky's own fallback briefing) carries. The schema
 * guarantees one of the two; a document with both shows the TL;DR.
 */
export type BriefingLead = { kind: "tldr"; items: string[] } | { kind: "summary"; text: string };

export const briefingLead = (doc: AnalysisDocument): BriefingLead =>
  doc.briefing.tldr !== undefined
    ? { kind: "tldr", items: doc.briefing.tldr }
    : { kind: "summary", text: doc.briefing.summary ?? "" };

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
  "no-logic": "Nothing to map: Rocky's path rules found only documentation, tooling or CI files.",
};

export const BRIEFING_REASON: Record<BriefingUnavailableReason, string> = {
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

const fmt = (n: number): string => n.toLocaleString("en-US");
export const tokensText = (estimated: number, limit: number): string =>
  `about ${fmt(estimated)} tokens, over the per-PR limit of ${fmt(limit)}`;

export type Banner = {
  tone: "neutral" | "ai" | "warn" | "crit";
  title: string;
  detail: string;
  /** Announced politely (a run in progress). */
  live: boolean;
  /** The newer run's fixed failure code. */
  code?: string;
};

/**
 * The banner over a document that is not the latest word (ADR 0019 §3 amendment): a newer run is
 * queued, running, held or failed, or the document describes another commit than the PR's head.
 * Fixed text only; the SHAs are validated hex.
 */
export const briefingBanner = (
  run: AnalysisRun,
  documentHead: string,
  pullHead: string,
): Banner | undefined => {
  const doc = documentHead.slice(0, 7);
  const stale = documentHead !== pullHead;
  const which = stale
    ? `Showing the briefing for an earlier commit, ${doc}; the pull request's head is now ${pullHead.slice(0, 7)}.`
    : `Showing the briefing for commit ${doc}.`;
  switch (run.status) {
    case "done":
      return stale
        ? { tone: "neutral", title: "This briefing is out of date", detail: which, live: false }
        : undefined;
    case "queued":
    case "running":
      return { tone: "ai", title: "Re-analysing the latest push…", detail: which, live: true };
    case "awaiting_approval":
      return {
        tone: "warn",
        title: "Waiting for approval to analyse the latest push",
        detail: `It needs ${tokensText(run.estimatedTokens, run.limitTokens)}. ${which}`,
        live: false,
      };
    case "failed":
      return {
        tone: "crit",
        title: "The latest push could not be analysed",
        detail: `${failureText(run.code)} ${which}`,
        live: false,
        code: run.code,
      };
    case "none":
      return undefined;
  }
};
