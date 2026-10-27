/**
 * pr-847 and pr-912 as seeded PRs (P4-7). Their diffs and scripts are P4-3's and P4-4's; this
 * adds the eval expectations (keywords per seeded finding) and the provenance notes.
 */
import { pr847Diff } from "../pr-847/diff.js";
import { PR847, pr847Script } from "../pr-847/script.js";
import { PR912_BASE, PR912_HEAD, PR912_TITLE, pr912Diff, pr912Script } from "../pr-912/fixture.js";
import type { SeededFinding } from "../score.js";
import type { SeededPr } from "./types.js";

const PR847_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  F1: ["role", "admin", "escalat", "privilege"],
  F2: ["permission", "authoriz", "any logged-in", "member", "access"],
  F3: ["reuse", "reused", "accepted", "single-use", "replay", "more than once"],
  F4: ["plaintext", "plain text", "hash"],
  F5: ["cascade", "delet", "orphan"],
  F6: ["log", "pii", "personal"],
  F7: ["url", "path", "referer", "access log"],
  F8: ["atomic", "transaction", "race", "concurren"],
  F9: ["spinner", "spinning", "loading", "busy", "error"],
  F10: ["test"],
};

export const PR847_SEEDED: SeededPr = {
  id: "pr-847",
  number: 847,
  title: "Team invitations",
  base: PR847.provenance.base.sha,
  head: PR847.provenance.head.sha,
  provenance:
    "Synthetic, written for Rocky (P1-3 fixture, file contents from the design POC). Team invitations with 10 planted issues across auth, the API route, the migration, the email job, the page and the tests. F9 and F10 sit in files triaged normal, which the pipeline does not review by design, so recall tops out at 0.8 here.",
  diff: () => pr847Diff(),
  expected: PR847.findings.map((finding): SeededFinding => ({
    id: finding.id,
    path: finding.path,
    severity: finding.severity,
    range: finding.range,
    title: finding.title,
    keywords: PR847_KEYWORDS[finding.id] ?? [],
  })),
  tolerated: [],
  fake: pr847Script,
};

export const PR912_SEEDED: SeededPr = {
  id: "pr-912",
  number: 912,
  title: PR912_TITLE,
  base: PR912_BASE,
  head: PR912_HEAD,
  provenance:
    "Synthetic, written for Rocky (P4-4 review round 1). One-off Stripe charges: a payment path triaged critical whose planted issues are only medium and low (no idempotency key, an unenforced cap, an unvalidated amount).",
  diff: pr912Diff,
  expected: [
    {
      id: "C1",
      path: "src/billing/charge.ts",
      severity: "medium",
      range: { start: 6, end: 6 },
      title: "Payment intent is created without an idempotency key",
      keywords: ["idempot", "duplicate", "double", "retry"],
    },
    {
      id: "C2",
      path: "src/billing/charge.ts",
      severity: "low",
      range: { start: 11, end: 11 },
      title: "MAX_CHARGE_CENTS is never enforced",
      keywords: ["max_charge_cents", "maximum", "enforce", "cap", "limit"],
    },
    {
      id: "C3",
      path: "src/api/routes/billing.ts",
      severity: "low",
      range: { start: 6, end: 6 },
      title: "amountCents is not validated",
      keywords: ["validat", "negative", "integer", "amountcents"],
    },
  ],
  tolerated: [],
  fake: pr912Script,
};
