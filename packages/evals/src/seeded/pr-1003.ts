/**
 * pr-1003, "Password reset by emailed code" (P4-7). Synthetic: written for Rocky's evals.
 */
import { addedFile, fakeModel } from "./fake-model.js";
import type { SeededPr } from "./types.js";

const AUTH = "src/auth/passwordReset.ts";
const ROUTE = "src/api/routes/passwordReset.ts";
const MIGRATION = "db/migrations/20261105_add_password_resets.sql";
const TEMPLATE = "src/email/templates/reset.ts";

export const PR1003_FILES: Readonly<Record<string, readonly string[]>> = {
  [AUTH]: [
    'import { randomInt } from "node:crypto";',
    'import { db } from "../db";',
    'import { Forbidden, NotFound } from "../errors";',
    'import { hashPassword } from "./hash";',
    'import { log } from "../log";',
    'import { mailer } from "../email/mailer";',
    "",
    "export async function requestReset(email: string) {",
    "  const user = await db.users.findOne({ email });",
    '  if (!user) throw new NotFound("no account with that email");',
    '  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");',
    "  await db.passwordResets.insert({ userId: user.id, code });",
    "  log.info(`reset code ${code} for ${email}`);",
    '  await mailer.send({ to: email, template: "reset", data: { code } });',
    "}",
    "",
    "export async function resetPassword(email: string, code: string, password: string) {",
    "  const user = await db.users.findOne({ email });",
    "  const reset = await db.passwordResets.findOne({ userId: user.id });",
    '  if (reset.code !== code) throw new Forbidden("wrong code");',
    "  await db.users.update(user.id, { passwordHash: await hashPassword(password) });",
    "}",
  ],
  [ROUTE]: [
    'import { Router } from "express";',
    'import { requestReset, resetPassword } from "../../auth/passwordReset";',
    "",
    "export const passwordReset = Router();",
    "",
    'passwordReset.post("/password-reset", async (req, res) => {',
    "  await requestReset(req.body.email);",
    "  res.status(204).end();",
    "});",
    "",
    'passwordReset.post("/password-reset/confirm", async (req, res) => {',
    "  await resetPassword(req.body.email, req.body.code, req.body.password);",
    "  res.status(204).end();",
    "});",
  ],
  [MIGRATION]: [
    "create table password_resets (",
    "  id uuid primary key default gen_random_uuid(),",
    "  user_id uuid not null references users(id),",
    "  code text not null,",
    "  created_at timestamptz not null default now()",
    ");",
  ],
  [TEMPLATE]: [
    "export const reset = (code: string) => ({",
    '  subject: "Your Rocky reset code",',
    "  text: `Your code is ${code}. It expires in 15 minutes.`,",
    "});",
  ],
};

export const PR1003: SeededPr = {
  id: "pr-1003",
  number: 1003,
  title: "Password reset by emailed code",
  base: "1003".padEnd(40, "a"),
  head: "1003".padEnd(40, "b"),
  provenance:
    "Synthetic, written for Rocky's evals (P4-7, 2026-10-27); not taken from any repository. A six-digit emailed reset code with six planted issues: account enumeration, the code in the logs, codes that never expire or get used up, no attempt limit, plaintext codes and no password policy.",
  diff: () =>
    `${Object.entries(PR1003_FILES)
      .flatMap(([path, lines]) => addedFile(path, lines))
      .join("\n")}\n`,
  expected: [
    {
      id: "R1",
      path: AUTH,
      severity: "medium",
      range: { start: 10, end: 10 },
      title: "The error tells an attacker which emails have an account",
      keywords: ["enumerat", "exists", "no account", "reveal", "which email"],
    },
    {
      id: "R2",
      path: AUTH,
      severity: "high",
      range: { start: 13, end: 13 },
      title: "The reset code is written to the logs",
      keywords: ["log"],
    },
    {
      id: "R3",
      path: AUTH,
      severity: "high",
      range: { start: 19, end: 21 },
      title: "Reset codes never expire and stay valid after use",
      keywords: ["expir", "reuse", "reused", "single-use", "one-time", "invalidat", "delete"],
    },
    {
      id: "R4",
      path: ROUTE,
      severity: "high",
      range: { start: 11, end: 12 },
      title: "No limit on code attempts: a six-digit code can be brute-forced",
      keywords: ["brute", "attempt", "rate limit", "rate-limit", "guess", "throttl"],
    },
    {
      id: "R5",
      path: MIGRATION,
      severity: "medium",
      range: { start: 4, end: 4 },
      title: "Reset codes are stored in plaintext",
      keywords: ["plaintext", "plain text", "hash"],
    },
    {
      id: "R6",
      path: ROUTE,
      severity: "low",
      range: { start: 12, end: 12 },
      title: "The new password is not checked against any policy",
      keywords: ["strength", "length", "policy", "weak", "validat"],
    },
  ],
  tolerated: [],
  fake: fakeModel({
    triage: {
      [AUTH]: { score: 88, level: "critical", reason: "Resets passwords: account takeover risk." },
      [ROUTE]: { score: 65, level: "important", reason: "Public endpoints for password reset." },
      [MIGRATION]: { score: 55, level: "important", reason: "New table for reset codes." },
      [TEMPLATE]: { score: 25, level: "normal", reason: "Email text." },
    },
    findings: {
      [AUTH]: [
        { severity: "high", lines: 13, title: "Reset code is written to the logs" },
        { severity: "critical", lines: 18, title: "Reset codes never expire and can be reused" },
        { severity: "medium", lines: 4, title: "hashPassword may hash with a weak algorithm" },
      ],
      [ROUTE]: [{ severity: "high", lines: 11, title: "No rate limit on code guesses" }],
      [MIGRATION]: [{ severity: "low", lines: 4, title: "Reset code stored in plaintext" }],
    },
    summary: "Adds password reset by a six-digit emailed code.",
    verdict: { level: "critical", reason: "Reset codes can be guessed, reused and read in logs." },
  }),
};
