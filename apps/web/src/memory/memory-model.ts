/**
 * What the memory page shows about entries (P8-3): labels, the filter, the chain an entry heads
 * (deleting it removes its earlier versions too, ADR 0039 §1) and the evidence line. Pure.
 */
import type { MemoryEntryView } from "@rocky-reviews/core";

export type MemoryKind = MemoryEntryView["kind"];
export type DismissReason = NonNullable<MemoryEntryView["reason"]>;

export const KIND_LABEL: Readonly<Record<MemoryKind, string>> = {
  convention: "Convention",
  decision: "Decision",
  dismissal: "Dismissal",
};
export const KIND_PLURAL: Readonly<Record<MemoryKind, string>> = {
  convention: "Conventions",
  decision: "Decisions",
  dismissal: "Dismissals",
};
export const KINDS: readonly MemoryKind[] = ["convention", "decision", "dismissal"];

export const REASON_LABEL: Readonly<Record<DismissReason, string>> = {
  intentional: "intentional",
  not_an_issue: "not an issue",
  handled_elsewhere: "handled elsewhere",
  not_worth_it: "not worth it",
};
export const REASONS: readonly DismissReason[] = [
  "intentional",
  "not_an_issue",
  "handled_elsewhere",
  "not_worth_it",
];

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

export interface MemoryFilter {
  readonly kind: MemoryKind | null;
  /** Show earlier versions (entries an edit or a newer decision replaced). */
  readonly history: boolean;
}
export const NO_MEMORY_FILTER: MemoryFilter = { kind: null, history: false };

/** The entries the filter shows, in the server's order (newest first). */
export const visibleEntries = (
  entries: readonly MemoryEntryView[],
  filter: MemoryFilter,
): MemoryEntryView[] =>
  entries.filter(
    (e) =>
      (filter.kind === null || e.kind === filter.kind) &&
      (filter.history || e.supersededBy === null),
  );

/** How many earlier versions were replaced into `entryId`, transitively (they go with it). */
export const earlierVersions = (entries: readonly MemoryEntryView[], entryId: string): number => {
  const chain = new Set([entryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entries) {
      if (e.supersededBy !== null && chain.has(e.supersededBy) && !chain.has(e.id)) {
        chain.add(e.id);
        grew = true;
      }
    }
  }
  return chain.size - 1;
};

export const linesLabel = (range: MemoryEntryView["evidence"]["range"]): string =>
  range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`;

/** What a dismissal keeps out: findings up to its severity (`medium` without one), never critical. */
export const coversLabel = (entry: MemoryEntryView): string | null =>
  entry.kind === "dismissal" ? `covers up to ${entry.severity ?? "medium"}` : null;

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const authorLabel = (entry: MemoryEntryView): string =>
  entry.author.kind === "member" ? entry.author.login : "former member";

export const counts = (entries: readonly MemoryEntryView[]) => {
  const current = entries.filter((e) => e.supersededBy === null);
  return {
    current: current.length,
    off: current.filter((e) => e.disabledAt !== null).length,
    history: entries.length - current.length,
  };
};
