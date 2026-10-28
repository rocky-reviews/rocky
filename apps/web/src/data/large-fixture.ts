/**
 * A generated pull request with one 5,000-line diff (P6-3): the performance trace scrolls it
 * (`e2e/diff.perf.spec.ts`). Deterministic, built in code so the bundle carries a few lines of
 * generator rather than the text. Open it with `?fixture=large-diff`.
 */
import type { PullRef } from "./shell-data.js";

export const LARGE_PULL: PullRef = { owner: "acme", repo: "rocky-app", number: 5000 };
export const LARGE_PATH = "src/billing/ledger-rules.ts";
export const LARGE_HEAD_SHA = "5000000000000000000000000000000000000005";

const HUNKS = 50;
/** Per hunk: 30 context, 30 added, 10 deleted, 30 context lines. */
const LEAD = 30;
const ADDED = 30;
const DELETED = 10;
const TRAIL = 30;
/** Unchanged lines between hunks. */
const GAP = 20;
export const LARGE_DIFF_LINES = HUNKS * (LEAD + ADDED + DELETED + TRAIL);

const CODE: readonly ((n: number) => string)[] = [
  (n) => `export function rule${n}(entry: LedgerEntry, limit = ${n * 7}): boolean {`,
  (n) => `  // Rule ${n}: entries over the limit need a second approval from finance.`,
  () => `  if (entry.amount > limit && entry.currency === "USD") return false;`,
  (n) => `  const fee = Math.round(entry.amount * 0.0${(n % 9) + 1} * 100) / 100;`,
  (n) =>
    `  await audit.write({ id: entry.id, kind: "rule-${n}", fee, at: new Date().toISOString(), note: "a long line that wraps on narrow screens, so measured heights differ from the estimate" });`,
  () => "  return true;",
  () => "}",
  () => "",
];
const code = (n: number): string => CODE[n % CODE.length]?.(n) ?? "";

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number };

const build = (): { diff: string; hunks: Hunk[] } => {
  const lines = [
    `diff --git a/${LARGE_PATH} b/${LARGE_PATH}`,
    "index 5000001..5000002 100644",
    `--- a/${LARGE_PATH}`,
    `+++ b/${LARGE_PATH}`,
  ];
  const hunks: Hunk[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let h = 0; h < HUNKS; h++) {
    const hunk = {
      oldStart: oldNo,
      oldLines: LEAD + DELETED + TRAIL,
      newStart: newNo,
      newLines: LEAD + ADDED + TRAIL,
    };
    hunks.push(hunk);
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ export const rules${h}`,
    );
    let n = h * 100;
    for (let i = 0; i < LEAD; i++) lines.push(` ${code(n++)}`);
    for (let i = 0; i < ADDED; i++) lines.push(`+${code(n++)}`);
    for (let i = 0; i < DELETED; i++) lines.push(`-${code(n++)}`);
    for (let i = 0; i < TRAIL; i++) lines.push(` ${code(n++)}`);
    oldNo += hunk.oldLines + GAP;
    newNo += hunk.newLines + GAP;
  }
  return { diff: `${lines.join("\n")}\n`, hunks };
};

export const largeDiff = (): string => build().diff;

const KINDS = ["look", "question", "ok"] as const;

/** GitHub's facts and the analysis for the large PR, in the shapes the shell's port expects. */
export const largeShellData = () => {
  const { hunks } = build();
  const additions = HUNKS * ADDED;
  const deletions = HUNKS * DELETED;
  // A flag on an added line of every fourth hunk, cycling through the kinds.
  const flags = hunks
    .filter((_, h) => h % 4 === 0)
    .map((hunk, i) => ({
      range: { start: hunk.newStart + LEAD + 5, end: hunk.newStart + LEAD + 5 },
      kind: KINDS[i % KINDS.length],
      text: `Generated note ${i + 1}: the fee rounding changed here; check the \`Math.round\` call.`,
    }));
  const findingLine = (hunks[10]?.newStart ?? 1) + LEAD + 15;
  return {
    pull: {
      ...LARGE_PULL,
      title: "Ledger rules regenerated (5,000-line diff)",
      author: "perf-bot",
      state: "open",
      headRef: "perf/large-ledger",
      baseRef: "main",
      additions,
      deletions,
      changedFiles: 1,
      updatedAt: "2026-10-25T12:00:00.000Z",
      approvers: [],
      commentCount: 0,
    },
    myReview: null,
    analysis: {
      schemaVersion: "1.1.0",
      provenance: {
        repo: { owner: LARGE_PULL.owner, name: LARGE_PULL.repo },
        pullRequest: { number: LARGE_PULL.number },
        base: { sha: "5000000000000000000000000000000000000004", ref: "main" },
        head: { sha: LARGE_HEAD_SHA, ref: "perf/large-ledger" },
        files: [{ path: LARGE_PATH, status: "modified", additions, deletions, hunks }],
        unanalysed: [],
        readByHand: [],
        generatedAt: "2026-10-25T12:00:00.000Z",
        generator: { name: "rocky", roles: [] },
      },
      briefing: {
        summary: "Regenerates the ledger rules. A fixture for the diff view's performance trace.",
        verdict: { level: "medium", reason: "One generated file; fee rounding changed." },
        estimatedReviewMinutes: 40,
        reviewPath: [{ path: LARGE_PATH, why: "The only file." }],
        checkedOk: [],
        memoryApplied: [],
      },
      triage: {
        files: [
          {
            path: LARGE_PATH,
            score: 60,
            level: "important",
            reviewMinutes: 40,
            reason: "Fee rounding changed across fifty rules.",
            whatChanged: "Fifty ledger rules regenerated with a new fee rounding.",
            whyThisLevel: "Money moves through these rules.",
            flags,
          },
        ],
        noise: [],
      },
      findings: [
        {
          id: "L1",
          severity: "medium",
          confidence: 70,
          path: LARGE_PATH,
          range: { start: findingLine, end: findingLine },
          title: "Fee rounding drops sub-cent amounts",
          body: "`Math.round` on the fee loses fractions of a cent on every entry.",
          memory: [],
          agentPrompt: `In ${LARGE_PATH}, round fees with banker's rounding and add a test.`,
        },
      ],
    },
  };
};
