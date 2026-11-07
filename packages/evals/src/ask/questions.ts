/**
 * The Ask eval's questions (P9-2), each with the code that answers it (`targets`: path and line
 * range in `ASK_REPO`). A target says where a good answer would point; the gate is on citation
 * validity, and target hits are reported beside it (`score.ts`). Synthetic, written for Rocky.
 */
import type { AskSelection } from "@rocky-reviews/core";
import { ASK_REPO } from "./repo.js";

export interface AskTarget {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export interface AskQuestion {
  readonly id: string;
  readonly question: string;
  readonly selection?: AskSelection;
  readonly targets: readonly AskTarget[];
}

const lines = (path: string, start: number, end: number): string =>
  (ASK_REPO[path] ?? []).slice(start - 1, end).join("\n");

export const ASK_QUESTIONS: readonly AskQuestion[] = [
  {
    id: "q01-hash",
    question: "Where are passwords hashed, and with which algorithm?",
    targets: [{ path: "src/auth/password.ts", start: 9, end: 13 }],
  },
  {
    id: "q02-session-ttl",
    question: "How long does a session last before it expires?",
    targets: [{ path: "src/auth/session.ts", start: 4, end: 14 }],
  },
  {
    id: "q03-webhook-signature",
    question: "How is the payment webhook's signature checked?",
    targets: [{ path: "src/billing/webhook.ts", start: 7, end: 14 }],
  },
  {
    id: "q04-retry",
    question: "How many times is a failed job retried, and how long does it wait between attempts?",
    targets: [{ path: "src/jobs/retry.ts", start: 1, end: 16 }],
  },
  {
    id: "q05-discount",
    question: "How is a discount applied to an invoice total?",
    targets: [{ path: "src/billing/invoice.ts", start: 12, end: 16 }],
  },
  {
    id: "q06-signed-in-routes",
    question: "Which API routes need a signed-in session?",
    targets: [{ path: "src/api/routes.ts", start: 6, end: 18 }],
  },
  {
    id: "q07-tenancy",
    question: "How are queries kept to one organisation's rows?",
    targets: [{ path: "src/db/tenancy.ts", start: 3, end: 21 }],
  },
  {
    id: "q08-revoke",
    question: "What happens when a session is revoked?",
    targets: [{ path: "src/auth/session.ts", start: 22, end: 25 }],
  },
  {
    id: "q09-selection-timing",
    question: "Is this comparison safe against timing attacks?",
    selection: {
      path: "src/auth/password.ts",
      startLine: 20,
      endLine: 20,
      text: lines("src/auth/password.ts", 20, 20).trim(),
    },
    targets: [{ path: "src/auth/password.ts", start: 15, end: 21 }],
  },
  {
    id: "q10-rounding",
    question: "How are invoice totals rounded?",
    targets: [{ path: "src/billing/invoice.ts", start: 6, end: 10 }],
  },
  {
    id: "q11-replay",
    question: "Can an old webhook request be replayed?",
    targets: [{ path: "src/billing/webhook.ts", start: 4, end: 14 }],
  },
  {
    id: "q12-callers",
    question: "Who calls verifySession?",
    targets: [
      { path: "src/api/routes.ts", start: 8, end: 12 },
      { path: "src/auth/session.ts", start: 16, end: 20 },
    ],
  },
];
