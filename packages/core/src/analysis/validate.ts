/**
 * Validation for the pipeline's units (P4-3, ADR 0014 §5). A stage answer is checked by the same
 * code that checks a stored document: it is placed in a one-file analysis document next to the
 * file's known facts and parsed with `parseAnalysisDocumentJson` (shape, limits, character rules,
 * hunk membership, score bands, suggestion context). No second, weaker set of rules exists.
 *
 * Issues go back to the model in a repair round as `path: CODE` lines, rebased onto the answer's
 * own paths. Messages are never used: they can quote values, and values come from PR content.
 */
import {
  limits,
  parseAnalysisDocumentJson,
  SCHEMA_VERSION,
  type AnalysisDocument,
  type ChangedFile,
  type FileLines,
  type Parsed,
  type Provenance,
  type SchemaIssue,
  type TriagedFile,
} from "@rocky-reviews/schema";
import type { ReviewFinding, TriageAnswer } from "./outputs.js";
import { MAX_REPAIR_ISSUES } from "./outputs.js";

/** The facts every unit document shares: the PR and the generator, never a model's word. */
export type ProvenanceBase = Omit<
  Provenance,
  "files" | "unanalysed" | "graphUnavailable" | "briefingUnavailable" | "readByHand"
>;

export interface UnitContext {
  readonly provenance: ProvenanceBase;
  readonly file: ChangedFile;
  readonly newFileLines?: readonly string[] | undefined;
}

/** A briefing no unit check can trip over: the verdict and estimate are at their maximum. */
const UNIT_BRIEFING = {
  summary: "Unit check.",
  verdict: { level: "critical", reason: "Unit check." },
  estimatedReviewMinutes: limits.MAX_REVIEW_MINUTES,
  reviewPath: [],
  checkedOk: [],
  memoryApplied: [],
} as const;

/** `Unrepairable`: an issue outside the answer (a pipeline bug, never the model's to fix). */
export type UnitCheck = readonly string[] | "unrepairable";

const lineOf = (path: string, issue: SchemaIssue): string => `${path || "(root)"}: ${issue.code}`;

/** Rebases issues under `prefix` onto the answer; any other issue makes the check unrepairable. */
const rebase = (
  issues: readonly SchemaIssue[],
  map: (path: string) => string | undefined,
): UnitCheck => {
  const lines: string[] = [];
  for (const issue of issues) {
    const path = map(issue.path);
    if (path === undefined) return "unrepairable";
    lines.push(lineOf(path, issue));
  }
  return lines.slice(0, MAX_REPAIR_ISSUES);
};

export const fileLinesOption = (
  path: string,
  lines: readonly string[] | undefined,
): { newFileLines?: FileLines } =>
  lines === undefined ? {} : { newFileLines: Object.fromEntries([[path, lines]]) };

const unitDocument = (
  context: UnitContext,
  triage: TriagedFile,
  findings: readonly ReviewFinding[],
): Parsed<AnalysisDocument> =>
  parseAnalysisDocumentJson(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      provenance: { ...context.provenance, files: [context.file], unanalysed: [] },
      briefing: UNIT_BRIEFING,
      triage: { files: [triage], noise: [] },
      findings: findings.map((finding, index) => ({
        ...finding,
        id: `F${index + 1}`,
        path: context.file.path,
        memory: [],
      })),
    }),
    fileLinesOption(context.file.path, context.newFileLines),
  );

const TRIAGE_PREFIX = "triage.files[0]";

/** Checks a triage answer for one file. Issue paths are rebased onto the answer. */
export const checkTriage = (context: UnitContext, answer: TriageAnswer): UnitCheck => {
  const parsed = unitDocument(context, { ...answer, path: context.file.path }, []);
  if (parsed.ok) return [];
  return rebase(parsed.error.issues, (path) => {
    if (path === TRIAGE_PREFIX) return "";
    return path.startsWith(`${TRIAGE_PREFIX}.`) ? path.slice(TRIAGE_PREFIX.length + 1) : undefined;
  });
};

/** Checks a review answer against the file's (already valid) triage entry. */
export const checkReview = (
  context: UnitContext,
  triage: TriagedFile,
  findings: readonly ReviewFinding[],
): UnitCheck => {
  const parsed = unitDocument(context, triage, findings);
  if (parsed.ok) return [];
  // The answer is `{ findings: [...] }`, so a finding's path is the same in both documents.
  return rebase(parsed.error.issues, (path) =>
    path === "findings" || path.startsWith("findings[") ? path : undefined,
  );
};

export type DocumentPart = "graph" | "briefing";

const PIPELINE_OWNED_BRIEFING = ["briefing.estimatedReviewMinutes", "briefing.memoryApplied"];

/**
 * Splits a whole document's issues by the stage that can fix them. `other` holds everything a
 * model cannot repair from here: units were checked one by one, so an issue there means the
 * assembly broke a rule (a pipeline bug, a PR-wide limit) and the analysis fails closed.
 */
export const partitionIssues = (
  issues: readonly SchemaIssue[],
): Readonly<Record<DocumentPart, string[]>> & { readonly other: number } => {
  const parts = { graph: [] as string[], briefing: [] as string[] };
  let other = 0;
  for (const issue of issues) {
    const { path } = issue;
    const owned = PIPELINE_OWNED_BRIEFING.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`),
    );
    const part: DocumentPart | undefined = owned
      ? undefined
      : path === "graph" || path.startsWith("graph.")
        ? "graph"
        : path === "briefing" || path.startsWith("briefing.")
          ? "briefing"
          : undefined;
    if (part === undefined) {
      other++;
      continue;
    }
    const rest = path === part ? "" : path.slice(part.length + 1);
    if (parts[part].length < MAX_REPAIR_ISSUES) parts[part].push(lineOf(rest, issue));
  }
  return { ...parts, other };
};
