/**
 * pr-1205, "Retry failed webhook deliveries" (P4-7). Synthetic: written for Rocky's evals.
 */
import { addedFile, fakeModel } from "./fake-model.js";
import type { SeededPr } from "./types.js";

const SIGN = "src/webhooks/sign.ts";
const DELIVER = "src/webhooks/deliver.ts";
const JOB = "src/jobs/retryWebhooks.ts";

export const PR1205_FILES: Readonly<Record<string, readonly string[]>> = {
  [SIGN]: [
    'import { createHmac } from "node:crypto";',
    "",
    "export function sign(secret: string, body: string): string {",
    '  return createHmac("sha1", secret).update(body).digest("hex");',
    "}",
    "",
    "export function verify(secret: string, body: string, signature: string): boolean {",
    "  return sign(secret, body) === signature;",
    "}",
  ],
  [DELIVER]: [
    'import { sign } from "./sign";',
    "",
    "const MAX_ATTEMPTS = 5;",
    "",
    "export async function deliver(url: string, secret: string, body: string) {",
    "  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {",
    "    const res = await fetch(url, {",
    '      method: "POST",',
    '      headers: { "x-rocky-signature": sign(secret, body) },',
    "      body,",
    "    });",
    "    if (res.ok) return true;",
    "    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));",
    "  }",
    "  return false;",
    "}",
  ],
  [JOB]: [
    'import { db } from "../db";',
    'import { deliver } from "../webhooks/deliver";',
    "",
    "export async function retryWebhooks() {",
    '  const pending = await db.webhookDeliveries.find({ status: "failed" });',
    "  for (const d of pending) {",
    "    deliver(d.url, d.secret, d.body);",
    '    await db.webhookDeliveries.update(d.id, { status: "delivered" });',
    "  }",
    "}",
  ],
};

export const PR1205: SeededPr = {
  id: "pr-1205",
  number: 1205,
  title: "Retry failed webhook deliveries",
  base: "1205".padEnd(40, "a"),
  head: "1205".padEnd(40, "b"),
  provenance:
    "Synthetic, written for Rocky's evals (P4-7, 2026-10-27); not taken from any repository. Outgoing webhooks with retries and seven planted issues: SHA-1 signatures, a non-constant-time compare, an off-by-one retry loop, requests to any URL (SSRF), no request timeout, retrying client errors and a job that marks deliveries done without awaiting them.",
  diff: () =>
    `${Object.entries(PR1205_FILES)
      .flatMap(([path, lines]) => addedFile(path, lines))
      .join("\n")}\n`,
  expected: [
    {
      id: "W1",
      path: SIGN,
      severity: "low",
      range: { start: 4, end: 4 },
      title: "Signatures use HMAC-SHA1",
      keywords: ["sha1", "sha-1", "sha256", "sha-256", "weak"],
    },
    {
      id: "W2",
      path: SIGN,
      severity: "medium",
      range: { start: 8, end: 8 },
      title: "Signatures are compared in non-constant time",
      keywords: ["timing", "constant", "timingsafeequal"],
    },
    {
      id: "W3",
      path: DELIVER,
      severity: "low",
      range: { start: 6, end: 6 },
      title: "The loop makes six attempts, not five",
      keywords: ["off-by-one", "off by one", "six", "6 attempts", "extra attempt", "<="],
    },
    {
      id: "W4",
      path: DELIVER,
      severity: "high",
      range: { start: 7, end: 7 },
      title: "Requests go to any URL, including internal addresses (SSRF)",
      keywords: ["ssrf", "internal", "private", "metadata", "localhost"],
    },
    {
      id: "W5",
      path: DELIVER,
      severity: "medium",
      range: { start: 12, end: 12 },
      title: "Client errors (4xx) are retried although they will not succeed",
      keywords: ["4xx", "client error", "status code", "retryable", "400"],
    },
    {
      id: "W6",
      path: DELIVER,
      severity: "medium",
      range: { start: 7, end: 11 },
      title: "No timeout: a slow endpoint holds the worker",
      keywords: ["timeout", "hang", "abort", "slow"],
    },
    {
      id: "W7",
      path: JOB,
      severity: "high",
      range: { start: 7, end: 8 },
      title: "deliver() is not awaited, so every delivery is marked delivered",
      keywords: ["await", "result", "ignored", "unhandled", "marked delivered"],
    },
  ],
  tolerated: [
    {
      id: "T1",
      path: DELIVER,
      severity: "low",
      range: { start: 13, end: 13 },
      title: "Backoff has no jitter",
      keywords: ["jitter"],
    },
  ],
  fake: fakeModel({
    triage: {
      [DELIVER]: { score: 82, level: "critical", reason: "Sends signed requests to user URLs." },
      [JOB]: { score: 60, level: "important", reason: "Background job over deliveries." },
      [SIGN]: { score: 65, level: "important", reason: "Signs and verifies payloads." },
    },
    findings: {
      [SIGN]: [
        {
          severity: "medium",
          lines: 8,
          title: "Signature compared with ===, not in constant time",
        },
        { severity: "low", lines: 4, title: "HMAC uses SHA-1" },
      ],
      [DELIVER]: [
        { severity: "high", lines: 7, title: "Delivers to any URL (SSRF)" },
        { severity: "high", lines: 6, title: "Loop makes one extra attempt (off-by-one)" },
        { severity: "medium", lines: 12, title: "Retries 4xx responses that will never succeed" },
        { severity: "low", lines: 13, title: "Backoff has no jitter" },
      ],
      [JOB]: [
        { severity: "high", lines: 7, title: "deliver() is not awaited; all marked delivered" },
      ],
    },
    summary: "Adds retries for failed webhook deliveries.",
    verdict: { level: "high", reason: "Requests reach arbitrary URLs and failures are hidden." },
  }),
};
