/**
 * Project memory in the review prompt (P8-2, ADR 0037). The worker loads the
 * repository's current entries inside the analysis's tenant transaction and passes them in the
 * request; this module decides which reach each file's review call and how, and turns the
 * model's citations back into `MemoryRef`s.
 *
 * - Entries are persisted text derived from earlier PR content and model output: untrusted. They
 *   travel only as one untrusted part labelled `memory` (the adapters delimit it with the call's
 *   nonce and neutralise chat-template tokens), as JSON, behind `MEMORY_CANARY_MARKER`. Nothing
 *   from an entry ever reaches the instructions slot.
 * - An entry is re-checked here before any use (`usableMemory`): a malformed one, or one whose
 *   text or path holds a canary or a run of Rocky's prompt text, is dropped and counted.
 * - Each call gets at most `MAX_MEMORY_PER_FILE` entries, most relevant first (`selectMemory`),
 *   under per-call handles (`M1`, …). The model cites handles; the pipeline resolves them against
 *   the call's own selection, so an id the call was not given (another repository's, another
 *   file's, an invented one) can never be stored.
 */
import { MemoryRef, pathProblem, type MemoryRef as MemoryRefValue } from "@rocky-reviews/schema";
import { isDismissReason, type DismissReason } from "../drafts.js";
import type { LlmUntrustedText } from "../llm.js";
import { isMemoryKind, type MemoryKind } from "../memory.js";
import { MEMORY_CANARY_MARKER } from "../prompt.js";
import { instructionLeaks } from "./leak.js";
import { MAX_MEMORY_PER_FILE } from "./outputs.js";

export { MAX_MEMORY_PER_FILE };

/** One current entry of the analysed repository, as the review stage may use it. */
export interface AnalysisMemoryEntry {
  /** The stored entry's id (a uuid): what a `MemoryRef` cites and `last_used_at` touches. */
  readonly id: string;
  readonly kind: MemoryKind;
  /** The dismissal reason; `null` for conventions and decisions. */
  readonly reason: DismissReason | null;
  /** The stored, scrubbed text (one line, at most 300 characters). */
  readonly text: string;
  /** The evidence path the entry was decided on. */
  readonly path: string;
  /** `memorySourceLabel(entry)`: kind and source PR, never a person. */
  readonly source: string;
  /** 0..100. */
  readonly confidence: number;
}

/** Most entries one analysis takes from the request (the worker lists newest first). */
export const MAX_ANALYSIS_MEMORY = 200;
export const MEMORY_LABEL = "memory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const usable = (value: unknown): AnalysisMemoryEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const { id, kind, reason, text, path, source, confidence } = value;
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  if (!isMemoryKind(kind)) return undefined;
  if (kind === "dismissal" ? !isDismissReason(reason) : reason !== null) return undefined;
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
  return {
    id,
    kind,
    reason: kind === "dismissal" && isDismissReason(reason) ? reason : null,
    text: text as string,
    path,
    source: source as string,
    confidence,
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

const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const topLevel = (path: string): string | undefined =>
  path.includes("/") ? path.slice(0, path.indexOf("/")) : undefined;

/**
 * How close an entry's path is to the reviewed file: 3 the same file, 2 the same directory, 1
 * the same top-level directory, 0 otherwise.
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
 * The entries one file's review is given, most relevant first: path relevance, then kind
 * (dismissals, decisions, conventions), then confidence, then the given order (newest first).
 * A dismissal is only offered on its own top-level directory or closer: it can keep a finding
 * out of the review, so it applies near where reviewers took it, never across the repository.
 * At most `MAX_MEMORY_PER_FILE`.
 */
export const selectMemory = (
  entries: readonly AnalysisMemoryEntry[],
  filePath: string,
): readonly SelectedMemory[] =>
  entries
    .map((entry, index) => ({ entry, index, score: pathRelevance(entry.path, filePath) }))
    .filter(({ entry, score }) => entry.kind !== "dismissal" || score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        KIND_RANK[b.entry.kind] - KIND_RANK[a.entry.kind] ||
        b.entry.confidence - a.entry.confidence ||
        a.index - b.index,
    )
    .slice(0, MAX_MEMORY_PER_FILE)
    .map(({ entry }, index) => ({ handle: `M${index + 1}`, entry }));

/**
 * The untrusted part one review call carries: the marker, then the entries as JSON (handle,
 * kind, reason, path, text). JSON-escaped text cannot end the part; the adapters' per-call nonce
 * is what delimits it, and they refuse content that holds the nonce.
 */
export const memoryPart = (selection: readonly SelectedMemory[]): LlmUntrustedText => ({
  label: MEMORY_LABEL,
  text: JSON.stringify({
    marker: MEMORY_CANARY_MARKER,
    entries: selection.map(({ handle, entry }) => ({
      id: handle,
      kind: entry.kind,
      ...(entry.reason === null ? {} : { reason: entry.reason }),
      path: entry.path,
      text: entry.text,
    })),
  }),
});

/**
 * What a file's unit key must change with: the entries its review was given, in order (ids and
 * everything the prompt showed). `undefined` without memory, so a unit analysed without memory
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
          entry.path,
          entry.text,
        ]),
      );

export const memoryRefOf = (entry: AnalysisMemoryEntry): MemoryRefValue => ({
  entryId: entry.id,
  text: entry.text,
  source: entry.source,
});

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
