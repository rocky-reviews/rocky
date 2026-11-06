/** Shared by the test files; not part of the package's exports. */
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import type { AnalysisDocumentInput } from "./document.js";
import type { IssueCode } from "./errors.js";
import { parseAnalysisDocument, type ParseOptions } from "./parse.js";

export const FIXTURES = ["pr-847", "tiny", "large-60-files"] as const;
export type FixtureName = (typeof FIXTURES)[number];

export const loadFixture = (name: FixtureName): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

/** A fresh, mutable copy of the pr-847 fixture, typed as what a producer would send. */
export const pr847 = (): AnalysisDocumentInput => loadFixture("pr-847") as AnalysisDocumentInput;

/** The summary paragraph pr-847 carried before schema 1.4 gave it a TL;DR (H4-8). */
export const PR847_SUMMARY =
  "Adds **email invitations to orgs**. An admin creates an invite, a background job emails a 7-day link, and the invitee accepts it to join the org with the invited role.";

/**
 * pr-847 as a 1.4 document: without the restored finding that schema 1.5 (P8-2) added to F3,
 * which the 1.5 stamp follows (`v1-5.test.ts`).
 */
export const pr847v14 = (): AnalysisDocumentInput => {
  const doc = pr847();
  for (const finding of doc.findings) delete finding.restored;
  doc.schemaVersion = "1.4.0";
  return doc;
};

/**
 * pr-847 as a document written before 1.4: the summary paragraph instead of the TL;DR (and no
 * 1.5 field), so it needs nothing newer than 1.1. For tests about the other version stamps.
 */
export const pr847WithSummary = (): AnalysisDocumentInput => {
  const doc = pr847v14();
  delete doc.briefing.tldr;
  doc.briefing.summary = PR847_SUMMARY;
  doc.schemaVersion = "1.1.0";
  return doc;
};

/**
 * Asserts the input is rejected and that at least one issue carries the code (and, when
 * given, the exact JSON path). Returns the issues so tests can look further.
 */
export const expectRejected = (
  input: unknown,
  code: IssueCode,
  path?: string,
  options?: ParseOptions,
) => {
  const result = parseAnalysisDocument(input, options);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  const matching = result.error.issues.filter(
    (issue) => issue.code === code && (path === undefined || issue.path === path),
  );
  expect(
    matching,
    `expected ${code}${path ? ` at ${path}` : ""}, got:\n${result.error.message}`,
  ).not.toHaveLength(0);
  return result.error.issues;
};

export const expectAccepted = (input: unknown, options?: ParseOptions) => {
  const result = parseAnalysisDocument(input, options);
  expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

/** New-side content of `src/auth/invitations.ts` in pr-847, as the POC shows it. */
export const PR847_AUTH_LINES: readonly string[] = [
  'import { randomBytes } from "node:crypto";',
  'import { db } from "../db";',
  'import { addMembership } from "../orgs/memberships";',
  'import { enqueue } from "../jobs/queue";',
  'import { Gone, NotFound } from "../errors";',
  "",
  "const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;",
  "",
  "export async function createInvitation(orgId: string, email: string, role: Role, invitedBy: string) {",
  '  const token = randomBytes(32).toString("hex");',
  "  const invite = await db.invitations.insert({",
  "    orgId, email, role, token, invitedBy,",
  "    expiresAt: new Date(Date.now() + INVITE_TTL_MS),",
  "  });",
  '  await enqueue("send-invite-email", { inviteId: invite.id, token });',
  "  return invite;",
  "}",
  "",
  "export async function acceptInvitation(token: string, user: User, requestedRole?: Role) {",
  "  const invite = await db.invitations.findOne({ token });",
  '  if (!invite) throw new NotFound("invitation");',
  "",
  '  if (invite.expiresAt < new Date()) throw new Gone("invitation expired");',
  "",
  "  await addMembership({",
  "    orgId: invite.orgId,",
  "    userId: user.id,",
  "    role: requestedRole ?? invite.role,",
  "  });",
  "",
  "  await db.invitations.update(invite.id, { acceptedAt: new Date() });",
  "  return invite.orgId;",
  "}",
];
