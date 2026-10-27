/**
 * Incremental analysis (P4-3, ADR 0014 §6). A file's triage and review are a pure function of
 * what the pipeline sent: its path, previous path, status and patch (hunk headers included, so
 * line numbers are part of the key), under this pipeline version and the role configuration. The
 * key is a sha256 over exactly those inputs, so on a push only the files whose patch changed are
 * sent to a model again; every other file's triage and findings are taken from the pull
 * request's previous analysis.
 *
 * Reuse is conservative: same pull request only (the caller loads its previous analysis inside
 * the org's tenant transaction), same key, same known facts, and only units that succeeded (a
 * file that could not be analysed is tried again). Reused units go through the final document
 * validation like fresh ones.
 */
import { z } from "zod";
import {
  limits,
  RepositoryPath,
  type AnalysisDocument,
  type ChangedFile,
  type TriagedFile,
} from "@rocky-reviews/schema";
import type { DiffFile } from "./diff.js";
import type { ReviewFinding } from "./outputs.js";

/**
 * Bump when instructions, output contracts, rules or anything else that shapes a unit's answer
 * changes: no stored unit is reused across versions.
 */
export const PIPELINE_VERSION = "p4-3.1";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const FileUnit = z.strictObject({
  path: RepositoryPath,
  key: z.string().regex(SHA256_HEX),
  /**
   * The triage model's own estimate, before the document scales minutes to fit its cap (review
   * round 1, Fix E): a reused unit must not be scaled twice.
   */
  reviewMinutes: z.int().min(0).max(limits.MAX_REVIEW_MINUTES),
});
export type FileUnit = z.output<typeof FileUnit>;

/** How `analyses.file_units` is stored and read back. */
export const FileUnits = z.array(FileUnit).max(limits.MAX_FILES);

/** A pull request's last good analysis: what the next push may reuse. */
export interface PreviousAnalysis {
  readonly document: AnalysisDocument;
  readonly units: readonly FileUnit[];
}

export type Sha256Hex = (text: string) => string;

export const unitKey = (sha256Hex: Sha256Hex, salt: string, file: DiffFile): string => {
  const key = sha256Hex(
    JSON.stringify([
      PIPELINE_VERSION,
      salt,
      file.path,
      file.previousPath ?? null,
      file.status,
      file.patch,
    ]),
  );
  if (!SHA256_HEX.test(key)) throw new TypeError("sha256Hex must return lower-case hex");
  return key;
};

export interface ReusedUnit {
  readonly triage: TriagedFile;
  readonly findings: readonly ReviewFinding[];
}

const sameFacts = (a: ChangedFile, b: ChangedFile): boolean =>
  JSON.stringify([a.path, a.previousPath ?? null, a.status, a.additions, a.deletions, a.hunks]) ===
  JSON.stringify([b.path, b.previousPath ?? null, b.status, b.additions, b.deletions, b.hunks]);

/** The previous analysis's result for this file, when it can stand in for a fresh one. */
export const reusableUnit = (
  previous: PreviousAnalysis | undefined,
  facts: ChangedFile,
  key: string,
): ReusedUnit | undefined => {
  if (previous === undefined) return undefined;
  const { document, units } = previous;
  const unit = units.find((candidate) => candidate.path === facts.path && candidate.key === key);
  if (unit === undefined) return undefined;
  const before = document.provenance.files.find((file) => file.path === facts.path);
  if (before === undefined || !sameFacts(before, facts)) return undefined;
  if (document.provenance.unanalysed.some((file) => file.path === facts.path)) return undefined;
  const triage = document.triage.files.find((file) => file.path === facts.path);
  if (triage === undefined) return undefined;
  const findings = document.findings
    .filter((finding) => finding.path === facts.path)
    // Ids are per document and memory references belong to the briefing that quoted them.
    .map((finding): ReviewFinding => ({
      severity: finding.severity,
      confidence: finding.confidence,
      range: finding.range,
      title: finding.title,
      body: finding.body,
      ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
      agentPrompt: finding.agentPrompt,
    }));
  return { triage: { ...triage, reviewMinutes: unit.reviewMinutes }, findings };
};
