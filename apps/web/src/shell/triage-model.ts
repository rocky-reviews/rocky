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
  reviewMinutes: number;
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
        reviewMinutes: file.reviewMinutes,
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
  /** Minutes of high-risk review left, from the analysis's per-file estimate. */
  minutesLeft: number;
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
    minutesLeft:
      left.length === 0
        ? 0
        : Math.max(
            1,
            left.reduce((s, f) => s + f.reviewMinutes, 0),
          ),
    done: left.length === 0,
  };
};
