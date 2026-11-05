/**
 * The project-memory eval case (P8-2). Synthetic: written for Rocky's evals on 2026-11-05; not
 * taken from any repository. Two pull requests of one repository that share a pattern the team
 * keeps on purpose (a retry limit written as a constant in the job file), each with one real bug:
 *
 * - **pr-1301** "Nightly invoice export job": the pattern on line 4, an un-awaited upload on
 *   line 10.
 * - **pr-1302** "Weekly digest email job", in the same directory: the pattern on line 4, the
 *   recipient's email address logged on line 13.
 *
 * Run 1 analyses pr-1301; the reviewer dismisses the pattern as intentional and Rocky learns a
 * dismissal entry from it (core `learnedEntry`, then the store's own `prepareMemoryEntry`). Run 2
 * analyses pr-1302 with that entry: the pattern must not be raised again, the entry must be cited,
 * and the real bug must still be found. A control run of pr-1302 without memory shows the pattern
 * is raised when nothing says otherwise, so its absence in run 2 is the memory's doing.
 */
import { stageOf } from "@rocky-reviews/core";
import type { Script, ScriptedAnswer } from "@rocky-reviews/core/testing";
import type { SeededFinding } from "../score.js";
import { addedFile, fakeModel, type FakeFinding } from "../seeded/fake-model.js";

export interface MemoryCasePr {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly base: string;
  readonly head: string;
  readonly path: string;
  readonly lines: readonly string[];
  /** The pattern reviewers dismissed as intentional. */
  readonly pattern: SeededFinding;
  /** A real bug memory must not hide. */
  readonly bug: SeededFinding;
}

const PATTERN_KEYWORDS = [
  "hard-coded",
  "hardcoded",
  "hard coded",
  "constant",
  "config",
  "MAX_ATTEMPTS",
];
const PATTERN_TITLE = "Retry limit is hard-coded instead of read from config";

const NIGHTLY = "src/jobs/exportInvoicesNightly.ts";
const DIGEST = "src/jobs/sendWeeklyDigest.ts";

export const MEMORY_RUN_1: MemoryCasePr = {
  id: "pr-1301",
  number: 1301,
  title: "Nightly invoice export job",
  base: "1301".padEnd(40, "a"),
  head: "1301".padEnd(40, "b"),
  path: NIGHTLY,
  lines: [
    'import { exportInvoices } from "../billing/exportInvoices";',
    'import { upload } from "../storage";',
    "",
    "const MAX_ATTEMPTS = 5;",
    "",
    "export async function runNightlyExport(orgId: string) {",
    "  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {",
    "    try {",
    '      const csv = await exportInvoices(orgId, "issued_at");',
    "      upload(`exports/${orgId}.csv`, csv);",
    "      return;",
    "    } catch (error) {",
    "      if (attempt === MAX_ATTEMPTS) throw error;",
    "    }",
    "  }",
    "}",
  ],
  pattern: {
    id: "P1",
    path: NIGHTLY,
    severity: "low",
    range: { start: 4, end: 4 },
    title: PATTERN_TITLE,
    keywords: PATTERN_KEYWORDS,
  },
  bug: {
    id: "B1",
    path: NIGHTLY,
    severity: "high",
    range: { start: 10, end: 10 },
    title: "Upload is not awaited, so failures escape the retry",
    keywords: ["await", "upload"],
  },
};

export const MEMORY_RUN_2: MemoryCasePr = {
  id: "pr-1302",
  number: 1302,
  title: "Weekly digest email job",
  base: "1302".padEnd(40, "a"),
  head: "1302".padEnd(40, "b"),
  path: DIGEST,
  lines: [
    'import { buildDigest } from "../digest";',
    'import { sendEmail } from "../mailer";',
    "",
    "const MAX_ATTEMPTS = 3;",
    "",
    "export async function sendWeeklyDigest(userId: string) {",
    "  const digest = await buildDigest(userId);",
    "  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {",
    "    try {",
    "      await sendEmail(digest.to, digest.subject, digest.html);",
    "      return;",
    "    } catch (error) {",
    '      console.log("digest failed", digest.to, error);',
    "      if (attempt === MAX_ATTEMPTS) throw error;",
    "    }",
    "  }",
    "}",
  ],
  pattern: {
    id: "P2",
    path: DIGEST,
    severity: "low",
    range: { start: 4, end: 4 },
    title: PATTERN_TITLE,
    keywords: PATTERN_KEYWORDS,
  },
  bug: {
    id: "B2",
    path: DIGEST,
    severity: "medium",
    range: { start: 13, end: 13 },
    title: "Logs the recipient's email address",
    keywords: ["email", "address", "log", "personal"],
  },
};

export const memoryCaseDiff = (pr: MemoryCasePr): string => addedFile(pr.path, pr.lines).join("\n");

const fakeFinding = (finding: SeededFinding): FakeFinding => ({
  severity: finding.severity,
  lines: finding.range.start,
  title: finding.title,
});

const decentModel = (pr: MemoryCasePr): Script =>
  fakeModel({
    triage: { [pr.path]: { score: 60, level: "important", reason: "A new job with retries." } },
    findings: { [pr.path]: [fakeFinding(pr.pattern), fakeFinding(pr.bug)] },
    tldr: [`Adds ${pr.title.toLowerCase()}.`, `Start with \`${pr.path}\`.`],
    verdict: { level: "medium", reason: "A new background job." },
  });

interface MemoryBlock {
  readonly entries: readonly { id: string; kind: string; text: string }[];
}

const subjectOf = (text: string): string =>
  text
    .slice(text.indexOf(":") + 1)
    .trim()
    .toLowerCase();

/**
 * The `--fake` model for the memory case: the decent model above, and when a review carries
 * memory it does what the memory instructions ask, by role, labels and parts only: a finding
 * whose title a dismissal entry names is left out and that entry cited in `memoryApplied`.
 */
export const memoryFakeScript =
  (pr: MemoryCasePr): Script =>
  async (call) => {
    const answer: ScriptedAnswer = await decentModel(pr)(call);
    const memory = call.part("memory");
    if (memory === undefined || stageOf(call) !== "review" || !("value" in answer)) return answer;
    const block = JSON.parse(memory) as MemoryBlock;
    const dismissed = new Map(
      block.entries.filter((e) => e.kind === "dismissal").map((e) => [subjectOf(e.text), e.id]),
    );
    const findings = (answer.value as { findings: { title: string }[] }).findings;
    const applied: string[] = [];
    const kept = findings.filter((finding) => {
      const id = dismissed.get(finding.title.toLowerCase());
      if (id !== undefined) applied.push(id);
      return id === undefined;
    });
    return {
      value: { findings: kept.map((f) => ({ ...f, memory: [] })), memoryApplied: applied },
    };
  };
