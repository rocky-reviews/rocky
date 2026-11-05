/**
 * The project-memory eval case (P8-2). Synthetic: written for Rocky's evals on 2026-11-05 and
 * redesigned the same day after the first live run; not taken from any repository. Two pull
 * requests of one repository's billing jobs (`src/billing/jobs/`) share a pattern the team keeps
 * on purpose, and each has one real, unmistakable bug:
 *
 * - **the pattern:** a per-item `catch` that swallows the error and moves on (`continue`), with no
 *   log or metric. A careful reviewer usually flags it (failures vanish); a team may keep it on
 *   purpose (a nightly job retries every unpaid item the next night).
 * - **pr-1301** "Retry failed charges nightly": the pattern on lines 12-14; the org id
 *   interpolated into SQL on line 6 (SQL injection).
 * - **pr-1302** "Send payment receipts": the pattern on lines 13-15; receipts sent only to
 *   customers who opted out, on line 11 (an inverted condition).
 *
 * Both files are payment code, which the triage instructions place at least at `important`, so
 * they are reviewed (the first live run's case, a small retry job, was most likely triaged
 * `normal` and never reviewed: ADR 0037 §6). Neither path takes a rule floor, so a suppression can
 * stand on run 2 unless triage calls the file critical.
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
  "swallow",
  "silent",
  "ignore",
  "discard",
  "hidden",
  "log",
  "catch",
  "continue",
];
const PATTERN_TITLE = "Errors are swallowed silently in the per-item catch";

const RETRY = "src/billing/jobs/retryFailedCharges.ts";
const RECEIPTS = "src/billing/jobs/sendPaymentReceipts.ts";

export const MEMORY_RUN_1: MemoryCasePr = {
  id: "pr-1301",
  number: 1301,
  title: "Retry failed charges nightly",
  base: "1301".padEnd(40, "a"),
  head: "1301".padEnd(40, "b"),
  path: RETRY,
  lines: [
    'import { db } from "../../db";',
    'import { payments } from "../../payments";',
    "",
    "export async function retryFailedCharges(orgId: string) {",
    "  const failed = await db.query(",
    "    `select id, customer_id, amount_cents from charges where org_id = '${orgId}' and status = 'failed'`,",
    "  );",
    "  for (const charge of failed.rows) {",
    "    try {",
    "      await payments.charge(charge.customer_id, charge.amount_cents);",
    "      await db.query(\"update charges set status = 'paid' where id = $1\", [charge.id]);",
    "    } catch {",
    "      continue;",
    "    }",
    "  }",
    "}",
  ],
  pattern: {
    id: "P1",
    path: RETRY,
    severity: "medium",
    range: { start: 12, end: 14 },
    title: PATTERN_TITLE,
    keywords: PATTERN_KEYWORDS,
  },
  bug: {
    id: "B1",
    path: RETRY,
    severity: "high",
    range: { start: 6, end: 6 },
    title: "The org id is interpolated into the SQL query (SQL injection)",
    keywords: ["sql", "inject", "interpolat", "parameter"],
  },
};

export const MEMORY_RUN_2: MemoryCasePr = {
  id: "pr-1302",
  number: 1302,
  title: "Send payment receipts",
  base: "1302".padEnd(40, "a"),
  head: "1302".padEnd(40, "b"),
  path: RECEIPTS,
  lines: [
    'import { db } from "../../db";',
    'import { mailer } from "../../mailer";',
    "",
    "export async function sendPaymentReceipts(orgId: string) {",
    "  const paid = await db.query(",
    "    \"select c.id, c.amount_cents, u.email, u.receipts_opt_out from charges c join customers u on u.id = c.customer_id where c.org_id = $1 and c.status = 'paid' and c.receipt_sent_at is null\",",
    "    [orgId],",
    "  );",
    "  for (const row of paid.rows) {",
    "    try {",
    '      if (row.receipts_opt_out) await mailer.send(row.email, "Your receipt", row.amount_cents);',
    '      await db.query("update charges set receipt_sent_at = now() where id = $1", [row.id]);',
    "    } catch {",
    "      continue;",
    "    }",
    "  }",
    "}",
  ],
  pattern: {
    id: "P2",
    path: RECEIPTS,
    severity: "medium",
    range: { start: 13, end: 15 },
    title: PATTERN_TITLE,
    keywords: PATTERN_KEYWORDS,
  },
  bug: {
    id: "B2",
    path: RECEIPTS,
    severity: "high",
    range: { start: 11, end: 11 },
    title: "Receipts go only to customers who opted out (inverted condition)",
    keywords: ["opt", "invert", "condition", "unsubscri", "negat"],
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
    triage: { [pr.path]: { score: 65, level: "important", reason: "A new payments job." } },
    findings: { [pr.path]: [fakeFinding(pr.pattern), fakeFinding(pr.bug)] },
    tldr: [`Adds ${pr.title.toLowerCase()}.`, `Start with \`${pr.path}\`.`],
    verdict: { level: "high", reason: "A new payments job with a real bug." },
  });

interface MemoryBlock {
  readonly entries: readonly { id: string; kind: string; text: string }[];
}

const subjectOf = (text: string): string =>
  text
    .slice(text.indexOf(":") + 1)
    .trim()
    .toLowerCase();

/** A finding as a suppressed one carries it: without a suggestion. */
const withoutSuggestion = <T extends object>(finding: T): Omit<T, "suggestion"> => {
  const copy: Record<string, unknown> = { ...(finding as Record<string, unknown>) };
  delete copy["suggestion"];
  return copy as Omit<T, "suggestion">;
};

/**
 * The `--fake` model for the memory case: the decent model above, and when a review carries
 * memory it does what the memory instructions ask, by role, labels and parts only: a finding
 * whose title a dismissal entry names goes in `suppressed` with that entry's id.
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
    const findings = (answer.value as { findings: { title: string; suggestion?: unknown }[] })
      .findings;
    const entryOf = (finding: { title: string }) => dismissed.get(finding.title.toLowerCase());
    return {
      value: {
        findings: findings
          .filter((finding) => entryOf(finding) === undefined)
          .map((f) => ({ ...f, memory: [] })),
        suppressed: findings.flatMap((finding) => {
          const entry = entryOf(finding);
          return entry === undefined ? [] : [{ ...withoutSuggestion(finding), entry }];
        }),
      },
    };
  };
