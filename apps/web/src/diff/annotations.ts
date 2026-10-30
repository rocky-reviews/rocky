/**
 * What the analysis says about one file, for the diff view (P6-3): hot lines (a marker on the
 * left edge, coloured by the worst finding's severity or else the flag's kind, as in the POC),
 * the AI flags under their lines, the file's triage, and the review order the footer follows.
 */
import type {
  AnalysisDocument,
  Flag,
  FlagKind,
  Severity,
  TriagedFileLevel,
} from "@rocky-reviews/schema";
import { noiseGroup, sidebarGroups } from "../shell/triage-model.js";

export type HotKind = Severity | FlagKind;

export type FileAnnotations = {
  /** New-side line number → marker. */
  readonly hot: ReadonlyMap<number, HotKind>;
  /** New-side line number → the flags shown under it (a flag sits under its range's end). */
  readonly flags: ReadonlyMap<number, readonly Flag[]>;
};

export const NO_ANNOTATIONS: FileAnnotations = { hot: new Map(), flags: new Map() };

/** Lower is stronger. Findings outrank flags; among flags, "look" outranks "question". */
const RANK: Record<HotKind, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  look: 4,
  question: 5,
  ok: 6,
};

/**
 * `dismissed`: drafts the reviewer dismissed (P6-4) no longer mark their lines, as in the POC.
 */
export const fileAnnotations = (
  doc: AnalysisDocument,
  path: string,
  dismissed: ReadonlySet<string> = new Set(),
): FileAnnotations => {
  const hot = new Map<number, HotKind>();
  const mark = (start: number, end: number, kind: HotKind) => {
    for (let n = start; n <= end; n++) {
      const current = hot.get(n);
      if (current === undefined || RANK[kind] < RANK[current]) hot.set(n, kind);
    }
  };
  const flags = new Map<number, Flag[]>();
  const triaged = doc.triage.files.find((f) => f.path === path);
  for (const flag of triaged?.flags ?? []) {
    mark(flag.range.start, flag.range.end, flag.kind);
    const list = flags.get(flag.range.end) ?? [];
    list.push(flag);
    flags.set(flag.range.end, list);
  }
  for (const finding of doc.findings) {
    if (finding.path === path && !dismissed.has(finding.id))
      mark(finding.range.start, finding.range.end, finding.severity);
  }
  return { hot, flags: new Map([...flags].sort(([a], [b]) => a - b)) };
};

export type FileTriage =
  | {
      readonly kind: "triaged";
      readonly level: TriagedFileLevel;
      readonly score: number;
      readonly whatChanged: string;
      readonly whyThisLevel: string;
      readonly findings: number;
    }
  | { readonly kind: "noise"; readonly summary: string };

export const fileTriage = (doc: AnalysisDocument, path: string): FileTriage | null => {
  const triaged = doc.triage.files.find((f) => f.path === path);
  if (triaged !== undefined)
    return {
      kind: "triaged",
      level: triaged.level,
      score: triaged.score,
      whatChanged: triaged.whatChanged,
      whyThisLevel: triaged.whyThisLevel,
      findings: doc.findings.filter((f) => f.path === path).length,
    };
  const noise = doc.triage.noise.find((n) => n.path === path);
  return noise === undefined ? null : { kind: "noise", summary: noise.summary };
};

/** The sidebar's order (risk level, then score), then the noise files: what "next" follows. */
export const reviewOrder = (doc: AnalysisDocument): string[] => [
  ...sidebarGroups(doc).flatMap((g) => g.files.map((f) => f.path)),
  ...noiseGroup(doc).files.map((f) => f.path),
];
