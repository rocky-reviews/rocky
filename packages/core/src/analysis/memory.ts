/**
 * Project memory in the review prompt (P8-2, ADR 0037). The worker loads the repository's
 * current entries inside the analysis's tenant transaction and passes them in the request; this
 * module decides which reach each file's review call and how, and turns the model's citations
 * back into `MemoryRef`s.
 *
 * - Entries are persisted text derived from earlier PR content and model output: untrusted. They
 *   travel only as one untrusted part labelled `memory` (the adapters delimit it with the call's
 *   nonce and neutralise chat-template tokens), as JSON, behind `MEMORY_CANARY_MARKER`. Nothing
 *   from an entry ever reaches the instructions slot.
 * - An entry is re-checked here before any use (`usableMemory`): a malformed one, or one whose
 *   text or path holds a canary, eight characters of one, or a run of Rocky's prompt text, is
 *   dropped and counted.
 * - Each call gets at most `MAX_MEMORY_PER_FILE` entries, chosen by relevance (`selectMemory`)
 *   and presented in a stable order under per-call handles (`M1`, …). The model cites handles;
 *   the pipeline resolves them against the call's own selection, so an id the call was not given
 *   (another repository's, another file's, an invented one) can never be stored.
 * - A dismissal covers findings up to its severity (`coversSeverity`), never a critical one.
 * - On a risky file no suppression stands, with one exception (P8-2b, `suppressionStands`): a
 *   dismissal the team took **on a file that was itself triaged critical** (`learnedLevel`,
 *   recorded by the learner from the document's triage, never from a model) may stand on a
 *   critical file within the same file or directory as its evidence. Never on a rule-floored
 *   file, never for a member-written entry, never above the severity cap. A covered suppression
 *   that does not stand is restored as a draft that says so (`restoredDismissalOf`,
 *   `Finding.restored`, schema 1.5), so the reviewer double-checks it against what the team
 *   dismissed. Only the pipeline writes it.
 * - A suppression that stands is not invisible: the finding goes in the document's `hidden`
 *   list with the entry that hid it (`hiddenByOf`, schema 1.6), where the page shows it
 *   collapsed and the reviewer can restore it as a draft.
 * - The learned level never travels in the memory part: the model cannot claim it.
 */
import {
  MemoryRef,
  pathProblem,
  Severity,
  TriagedFileLevel,
  type HiddenByDismissal,
  type MemoryRef as MemoryRefValue,
  type RESTORED_BECAUSE,
  type RestoredDismissal,
} from "@rocky-reviews/schema";
import { isDismissReason, type DismissReason } from "../drafts.js";
import type { LlmUntrustedText } from "../llm.js";
import { isMemoryKind, isMemoryOrigin, type MemoryKind, type MemoryOrigin } from "../memory.js";
import { MEMORY_CANARY_MARKER } from "../prompt.js";
import { containsPromptCanaryFragment, instructionLeaks } from "./leak.js";
import { MAX_MEMORY_PER_FILE } from "./outputs.js";

export { MAX_MEMORY_PER_FILE };

type FindingSeverity = Severity;

/** One current entry of the analysed repository, as the review stage may use it. */
export interface AnalysisMemoryEntry {
  /** The stored entry's id (a uuid): what a `MemoryRef` cites and `last_used_at` touches. */
  readonly id: string;
  readonly kind: MemoryKind;
  /** `member` (a person wrote it) or `learned` (from a posted review). */
  readonly origin: MemoryOrigin;
  /** The dismissal reason; `null` for conventions and decisions. */
  readonly reason: DismissReason | null;
  /**
   * For a dismissal: the severity of the finding it was learned from, the highest it covers.
   * `null` for other kinds, and for a dismissal that carries none (covers up to `medium`).
   */
  readonly severity: FindingSeverity | null;
  /** The stored, scrubbed text (one line, at most 300 characters). */
  readonly text: string;
  /** The evidence path the entry was decided on. */
  readonly path: string;
  /** `memorySourceLabel(entry)`: kind and source PR, never a person. */
  readonly source: string;
  /** 0..100. */
  readonly confidence: number;
  /**
   * For a learned dismissal: the triage level (after the rule floor) the dismissed finding's
   * file had in the analysis the team dismissed it on (P8-2b). `critical` is what lets the entry
   * stand on a critical file. Absent or `null` for entries learned before it was recorded and
   * for every other entry: they rank as non-critical. Never offered to the model.
   */
  readonly learnedLevel?: TriagedFileLevel | null | undefined;
}

/**
 * Most entries one analysis takes from the request. The worker loads member-written entries,
 * learned dismissals and other learned entries under separate bounds that add up to this.
 */
export const MAX_ANALYSIS_MEMORY = 250;
export const MEMORY_LABEL = "memory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
/** What a dismissal without a recorded severity covers. */
const DEFAULT_COVERED: FindingSeverity = "medium";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const usable = (value: unknown): AnalysisMemoryEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const { id, kind, origin, reason, severity, text, path, source, confidence, learnedLevel } =
    value;
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  if (!isMemoryKind(kind) || !isMemoryOrigin(origin)) return undefined;
  if (kind === "dismissal" ? !isDismissReason(reason) : reason !== null) return undefined;
  const level = severity === null ? null : Severity.safeParse(severity);
  if (level !== null && (!level.success || kind !== "dismissal")) return undefined;
  // The learned level is the store's (migration 0021): only on a learned dismissal, as the
  // database's CHECKs say. An entry that contradicts them is dropped, like one with a severity
  // on a convention.
  const learnedAt =
    learnedLevel === undefined || learnedLevel === null
      ? null
      : TriagedFileLevel.safeParse(learnedLevel);
  if (learnedAt !== null && (!learnedAt.success || kind !== "dismissal" || origin !== "learned"))
    return undefined;
  if (typeof path !== "string" || pathProblem(path) !== undefined) return undefined;
  if (typeof confidence !== "number" || !Number.isSafeInteger(confidence)) return undefined;
  if (confidence < 0 || confidence > 100) return undefined;
  // The same rules the document applies to a quoted entry (one line, no markup, no invisible
  // characters), so a ref built from it can always be stored.
  if (!MemoryRef.safeParse({ entryId: id, text, source }).success) return undefined;
  // Neither a canary (squashed: spacing, case and punctuation do not hide one) nor a run of
  // Rocky's prompt text, with nothing allowed: stored memory must not trip the leak guard on a
  // later, unrelated pull request (which would fail its analysis), nor carry the marker.
  if (instructionLeaks({ text, path, source }, []).length > 0) return undefined;
  // Nor eight characters of either canary: two entries quoted together must not rebuild one.
  if ([text, path, source].some((part) => containsPromptCanaryFragment(String(part))))
    return undefined;
  return {
    id,
    kind,
    origin,
    reason: kind === "dismissal" && isDismissReason(reason) ? reason : null,
    severity: level === null || !level.success ? null : level.data,
    text: text as string,
    path,
    source: source as string,
    confidence,
    learnedLevel: learnedAt === null || !learnedAt.success ? null : learnedAt.data,
  };
};

/**
 * The entries an analysis may use, in the given order, without duplicates, at most
 * `MAX_ANALYSIS_MEMORY`; `dropped` counts what was refused (for the log: a count only).
 */
export const usableMemory = (
  entries: readonly unknown[] | undefined,
): { readonly entries: readonly AnalysisMemoryEntry[]; readonly dropped: number } => {
  const kept: AnalysisMemoryEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const value of entries ?? []) {
    if (kept.length >= MAX_ANALYSIS_MEMORY) {
      dropped++;
      continue;
    }
    const entry = usable(value);
    if (entry === undefined || seen.has(entry.id)) {
      dropped++;
      continue;
    }
    seen.add(entry.id);
    kept.push(entry);
  }
  return { entries: kept, dropped };
};

/**
 * The directory of a path; root-level files share the directory `""` (so every root-level file
 * counts as one directory: docs/progress.md, N3).
 */
const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const topLevel = (path: string): string | undefined =>
  path.includes("/") ? path.slice(0, path.indexOf("/")) : undefined;

/**
 * How close an entry's path is to the reviewed file: 3 the same file, 2 the same directory, 1
 * the same top-level directory, 0 otherwise. Only entries scoring at least 1 are offered.
 */
export const pathRelevance = (entryPath: string, filePath: string): number => {
  if (entryPath === filePath) return 3;
  if (dirname(entryPath) === dirname(filePath)) return 2;
  const top = topLevel(entryPath);
  return top !== undefined && top === topLevel(filePath) ? 1 : 0;
};

const KIND_RANK: Readonly<Record<MemoryKind, number>> = {
  dismissal: 2,
  decision: 1,
  convention: 0,
};

export interface SelectedMemory {
  /** The per-call handle the model cites (`M1`, …). */
  readonly handle: string;
  readonly entry: AnalysisMemoryEntry;
}

/**
 * The entries one file's review is given. Only entries on the same top-level directory or
 * closer (path relevance ≥ 1) are offered at all: an entry elsewhere costs tokens and, through
 * the unit key, re-reviews of files it says nothing about (fix round, S2/M3). Which ones, when more
 * than `MAX_MEMORY_PER_FILE` qualify: path relevance, then kind (dismissals, decisions,
 * conventions), then member-written before learned, then confidence, then id. Handles follow the
 * entries' ids, so the prompt (and the unit key) depends only on which entries were chosen,
 * never on the order they came in or on a confidence that changed elsewhere.
 */
export const selectMemory = (
  entries: readonly AnalysisMemoryEntry[],
  filePath: string,
): readonly SelectedMemory[] =>
  entries
    .map((entry) => ({ entry, score: pathRelevance(entry.path, filePath) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        KIND_RANK[b.entry.kind] - KIND_RANK[a.entry.kind] ||
        Number(b.entry.origin === "member") - Number(a.entry.origin === "member") ||
        b.entry.confidence - a.entry.confidence ||
        (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
    )
    .slice(0, MAX_MEMORY_PER_FILE)
    .map(({ entry }) => entry)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry, index) => ({ handle: `M${index + 1}`, entry }));

/** The highest severity a dismissal covers: its own, `medium` without one, never critical. */
export const coveredSeverity = (entry: AnalysisMemoryEntry): FindingSeverity =>
  entry.severity === null || entry.severity === "critical" ? DEFAULT_COVERED : entry.severity;

/**
 * Whether `entry` may keep a finding of `severity` out of the review: only a dismissal, only up
 * to the severity it covers, and never a critical finding.
 */
export const coversSeverity = (entry: AnalysisMemoryEntry, severity: FindingSeverity): boolean =>
  entry.kind === "dismissal" &&
  severity !== "critical" &&
  SEVERITY_RANK[severity] <= SEVERITY_RANK[coveredSeverity(entry)];

/**
 * The untrusted part one review call carries: the marker, then the entries as JSON (handle,
 * kind, reason and covered severity for dismissals, path, text). JSON-escaped text cannot end the
 * part; the adapters' per-call nonce is what delimits it, and they refuse content that holds the
 * nonce.
 */
export const memoryPart = (selection: readonly SelectedMemory[]): LlmUntrustedText => ({
  label: MEMORY_LABEL,
  text: JSON.stringify({
    marker: MEMORY_CANARY_MARKER,
    entries: selection.map(({ handle, entry }) => ({
      id: handle,
      kind: entry.kind,
      ...(entry.reason === null ? {} : { reason: entry.reason }),
      ...(entry.kind === "dismissal" ? { coversUpTo: coveredSeverity(entry) } : {}),
      path: entry.path,
      text: entry.text,
    })),
  }),
});

/**
 * What a file's review must change with: the entries it was given (ids and everything the
 * prompt showed), in handle order. `undefined` without memory, so a unit analysed without memory
 * keeps the key it always had.
 */
export const memoryKeyOf = (selection: readonly SelectedMemory[]): string | undefined =>
  selection.length === 0
    ? undefined
    : JSON.stringify(
        selection.map(({ handle, entry }) => [
          handle,
          entry.id,
          entry.kind,
          entry.reason,
          entry.kind === "dismissal" ? coveredSeverity(entry) : null,
          entry.path,
          entry.text,
        ]),
      );

export const memoryRefOf = (entry: AnalysisMemoryEntry): MemoryRefValue => ({
  entryId: entry.id,
  text: entry.text,
  source: entry.source,
});

/** Why no suppression stands on a file: it is triaged critical, or its path takes a rule floor. */
export type RestoredBecause = (typeof RESTORED_BECAUSE)[number];

/**
 * What the pipeline knows about the reviewed file that memory must not override: whether its
 * path takes a rule floor (auth, migrations: always reviewed in full) and why, if at all, a
 * suppression would be restored (`critical_file` when triage, after the floor, is critical;
 * `rule_floor` for a floored file that is not; undefined on any other file).
 */
export interface FileRisk {
  readonly because: RestoredBecause | undefined;
  readonly ruleFloored: boolean;
}

/**
 * Whether a covered suppression stands on this file (P8-2b). Memory never decides this: the
 * pipeline does, from the file's triage (which never sees memory), its rule floor and what the
 * store recorded about the entry.
 *
 * - Not risky: it stands (the caller has already checked `coversSeverity`).
 * - A rule-floored file (auth, migrations): never, whatever the entry.
 * - A file triaged critical: only a **learned** dismissal the team took on a file that was
 *   itself triaged critical (`learnedLevel === "critical"`), and only within the same file or
 *   directory as its evidence (path relevance ≥ 2: tighter than the usual top-level scope).
 *   A member-written entry is not eligible: it records a person's rule, not a decision taken
 *   in critical context, and it carries no learned level by construction (migration 0021).
 *
 * `coversSeverity` stays the caller's check, so a critical-severity finding is never hidden.
 */
export const suppressionStands = (
  entry: AnalysisMemoryEntry,
  filePath: string,
  risk: FileRisk,
): boolean => {
  if (risk.ruleFloored) return false;
  if (risk.because === undefined) return true;
  return (
    entry.kind === "dismissal" &&
    entry.origin === "learned" &&
    entry.learnedLevel === "critical" &&
    pathRelevance(entry.path, filePath) >= 2
  );
};

/**
 * The document's marker on a hidden finding (schema 1.6): the dismissal that hid it as a ref,
 * the path the team took it on and its reason. Only a dismissal with a reason can hide.
 */
export const hiddenByOf = (entry: AnalysisMemoryEntry): HiddenByDismissal | undefined =>
  entry.kind !== "dismissal" || entry.reason === null
    ? undefined
    : { entry: memoryRefOf(entry), path: entry.path, dismissedAs: entry.reason };

/**
 * A covered suppression the pipeline restored because the file is risky (fix round 3): the
 * stored entry's id and why, as a unit carries it. `Finding.restored` is built from the stored
 * entry at the end (`restoredDismissalOf`), never from this or from model text.
 */
export interface RestoredByRisk {
  readonly entryId: string;
  readonly because: RestoredBecause;
}

/**
 * The document's "double-check" marker for a restored suppression: the dismissal as a ref, the
 * path the team took it on, its reason and why the finding is shown anyway. Only a dismissal
 * with a reason can be the entry (a convention named as a dismissal is restored without one).
 */
export const restoredDismissalOf = (
  entry: AnalysisMemoryEntry,
  because: RestoredBecause,
): RestoredDismissal | undefined =>
  entry.kind !== "dismissal" || entry.reason === null
    ? undefined
    : {
        entry: memoryRefOf(entry),
        path: entry.path,
        dismissedAs: entry.reason,
        shownBecause: because,
      };

/**
 * The stored entry ids behind `handles`, in order, without duplicates; handles the call was not
 * given are dropped and counted.
 */
export const resolveHandles = (
  selection: readonly SelectedMemory[],
  handles: readonly string[],
): { readonly ids: readonly string[]; readonly stripped: number } => {
  const byHandle = new Map(selection.map(({ handle, entry }) => [handle, entry.id] as const));
  const ids: string[] = [];
  let stripped = 0;
  for (const handle of handles) {
    const id = byHandle.get(handle);
    if (id === undefined) stripped++;
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, stripped };
};

/** The selected entry behind one handle, if the call was given it. */
export const entryOfHandle = (
  selection: readonly SelectedMemory[],
  handle: string,
): AnalysisMemoryEntry | undefined => selection.find((s) => s.handle === handle)?.entry;
