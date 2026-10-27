/**
 * A scripted "decent model" for a seeded PR (P4-7 `--fake`): fixed triage and findings per path,
 * a briefing whose review path follows the triage block, and a one-node graph. Like the other
 * scripts it answers by role and path only, so the pipeline's wiring decides what is stored.
 */
import type { Script } from "@rocky-reviews/core/testing";
import type { RiskLevel, TriagedFileLevel } from "@rocky-reviews/schema";
import type { Severity } from "../score.js";

export interface FakeTriage {
  readonly score: number;
  readonly level: Exclude<TriagedFileLevel, "noise">;
  readonly reason: string;
}

export interface FakeFinding {
  readonly severity: Severity;
  /** New-side line, or first and last line. */
  readonly lines: number | readonly [number, number];
  readonly title: string;
  readonly body?: string;
}

export interface FakeModelSpec {
  readonly triage: Readonly<Record<string, FakeTriage>>;
  readonly findings: Readonly<Record<string, readonly FakeFinding[]>>;
  readonly summary: string;
  readonly verdict: { readonly level: RiskLevel; readonly reason: string };
}

const GRAPH = {
  lanes: [{ id: "app", label: "App", order: 0 }],
  nodes: [{ id: "change", lane: "app", kind: "module", delta: "added", label: "Change" }],
};

export const fakeModel =
  (spec: FakeModelSpec): Script =>
  (call) => {
    const path = call.part("file_path");
    if (call.role === "triage") {
      const triage = path === undefined ? undefined : spec.triage[path];
      if (triage === undefined) return { status: "refused" };
      return {
        value: {
          score: triage.score,
          level: triage.level,
          reviewMinutes: 2,
          reason: triage.reason,
          whatChanged: "Adds the file.",
          whyThisLevel: `Scored ${triage.score}.`,
          flags: [],
        },
      };
    }
    if (call.role === "review" && path !== undefined) {
      return {
        value: {
          findings: (spec.findings[path] ?? []).map((finding) => {
            const [start, end] =
              typeof finding.lines === "number" ? [finding.lines, finding.lines] : finding.lines;
            return {
              severity: finding.severity,
              confidence: 70,
              range: { start, end },
              title: finding.title,
              body: finding.body ?? `${finding.title}.`,
              agentPrompt: `Fix: ${finding.title}.`,
            };
          }),
        },
      };
    }
    if (call.role === "review") {
      const triaged = (JSON.parse(call.part("triage") ?? "[]") as { path: string }[]).map(
        (file) => file.path,
      );
      return {
        value: {
          summary: spec.summary,
          verdict: spec.verdict,
          reviewPath: triaged.map((p) => ({ path: p, why: "In order of risk." })),
          checkedOk: [],
        },
      };
    }
    return { value: GRAPH };
  };

/** The lines of a new file as a unified diff. */
export const addedFile = (path: string, lines: readonly string[]): string[] => [
  `diff --git a/${path} b/${path}`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map((line) => `+${line}`),
];
