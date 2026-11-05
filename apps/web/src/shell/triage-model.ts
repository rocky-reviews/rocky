/**
 * The sidebar's view of an analysis document: files grouped by risk level in triage order,
 * their findings' severities, the noise group, and review coverage. Pure, so it is tested
 * without a DOM.
 */
import type { AnalysisDocument, Severity, TriagedFileLevel } from "@rocky-reviews/schema";

export const LEVELS: readonly TriagedFileLevel[] = ["critical", "important", "normal", "low"];

export const LEVEL_LABEL: Record<TriagedFileLevel, string> = {
  critical: "Critical",
  important: "Important",
  normal: "Normal",
  low: "Low",
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export type SidebarFile = {
  path: string;
  level: TriagedFileLevel;
  score: number;
  /** One entry per finding on the file, worst first. */
  findings: readonly { id: string; severity: Severity }[];
};

export type SidebarGroup = { level: TriagedFileLevel; files: readonly SidebarFile[] };

export type NoiseGroup = {
  files: readonly { path: string; summary: string }[];
  /** Added plus deleted lines across the noise files. */
  lines: number;
};

export const sidebarGroups = (doc: AnalysisDocument): SidebarGroup[] => {
  const findings = new Map<string, { id: string; severity: Severity }[]>();
  for (const f of doc.findings) {
    const list = findings.get(f.path) ?? [];
    list.push({ id: f.id, severity: f.severity });
    findings.set(f.path, list);
  }
  return LEVELS.map((level) => ({
    level,
    files: doc.triage.files
      .filter((file) => file.level === level)
      .toSorted((a, b) => b.score - a.score)
      .map((file) => ({
        path: file.path,
        level,
        score: file.score,
        findings: (findings.get(file.path) ?? []).toSorted(
          (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
        ),
      })),
  })).filter((group) => group.files.length > 0);
};

export const noiseGroup = (doc: AnalysisDocument): NoiseGroup => {
  const changed = new Map(doc.provenance.files.map((f) => [f.path, f.additions + f.deletions]));
  return {
    files: doc.triage.noise.map((n) => ({ path: n.path, summary: n.summary })),
    lines: doc.triage.noise.reduce((sum, n) => sum + (changed.get(n.path) ?? 0), 0),
  };
};

export type Coverage = {
  reviewed: number;
  total: number;
  done: boolean;
};

/** Critical and important files are the ones a reviewer must open. */
export const coverage = (
  groups: readonly SidebarGroup[],
  viewed: ReadonlySet<string>,
): Coverage => {
  const must = groups
    .filter((g) => g.level === "critical" || g.level === "important")
    .flatMap((g) => g.files);
  const left = must.filter((f) => !viewed.has(f.path));
  return {
    reviewed: must.length - left.length,
    total: must.length,
    done: left.length === 0,
  };
};

/** The coverage card's note: a count, not a time (H4-9 hid the model's review-time estimate). */
export const coverageNote = (c: Coverage): string => {
  if (c.done) return "All high-risk files reviewed ✓";
  const left = c.total - c.reviewed;
  return `${left} high-risk ${left === 1 ? "file" : "files"} left`;
};
