/**
 * The pr-847 seeded pull request (P1-3's fixture, "team invitations") as the unified diff GitHub
 * would serve for it. File contents follow the design POC; the diff reproduces the fixture's
 * known facts exactly (paths, statuses, line counts, hunk ranges), which `pr-847.test.ts` checks.
 * The lockfile and generated-file bodies are filler with the fixture's line counts.
 */

export const AUTH = [
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

export const ROUTES = [
  'import { Router } from "express";',
  'import { z } from "zod";',
  'import { requireSession } from "../middleware/session";',
  'import { createInvitation, acceptInvitation } from "../../auth/invitations";',
  "",
  "export const invitations = Router();",
  "",
  "const CreateBody = z.object({",
  "  email: z.string().email(),",
  '  role: z.enum(["member", "admin"]).default("member"),',
  "});",
  "",
  'invitations.post("/orgs/:orgId/invitations", requireSession, async (req, res) => {',
  "  const body = CreateBody.parse(req.body);",
  "  const invite = await createInvitation(req.params.orgId, body.email, body.role, req.user.id);",
  "  res.status(201).json({ id: invite.id, expiresAt: invite.expiresAt });",
  "});",
  "",
  'invitations.post("/invitations/:token/accept", requireSession, async (req, res) => {',
  "  const orgId = await acceptInvitation(req.params.token, req.user, req.body.role);",
  "  res.json({ orgId });",
  "});",
];

/** The second push: the accept route stops passing the caller's role (one line, same count). */
export const ROUTES_PUSH_2 = ROUTES.map((line, index) =>
  index === 19 ? "  const orgId = await acceptInvitation(req.params.token, req.user);" : line,
);

const MIGRATION = [
  "CREATE TABLE invitations (",
  "  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),",
  "  org_id      uuid NOT NULL REFERENCES organizations(id),",
  "  email       text NOT NULL,",
  "  role        text NOT NULL DEFAULT 'member',",
  "  token       text NOT NULL,",
  "  invited_by  uuid NOT NULL REFERENCES users(id),",
  "  expires_at  timestamptz NOT NULL,",
  "  accepted_at timestamptz,",
  "  created_at  timestamptz NOT NULL DEFAULT now()",
  ");",
  "",
  "CREATE INDEX invitations_org_id_idx ON invitations (org_id);",
  "",
  "ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;",
  "CREATE POLICY tenant_isolation ON invitations",
  "  USING (org_id = current_setting('app.org_id')::uuid);",
];

const JOB = [
  'import { mailer } from "../email/mailer";',
  'import { db } from "../db";',
  'import { log } from "../log";',
  "",
  "export async function sendInviteEmail({ inviteId, token }: { inviteId: string; token: string }) {",
  "  const invite = await db.invitations.get(inviteId);",
  "  const org = await db.organizations.get(invite.orgId);",
  "",
  "  log.info(`sending invite to ${invite.email} for ${org.name}`);",
  "",
  "  await mailer.send({",
  "    to: invite.email,",
  '    template: "invite",',
  "    data: { orgName: org.name, link: `${process.env.APP_URL}/invite/${token}` },",
  "  });",
  "}",
];

const PAGE = [
  'import { useState } from "react";',
  'import { useNavigate, useParams } from "react-router-dom";',
  'import { api } from "../lib/api";',
  'import { Button, Card } from "../ui";',
  "",
  "export function InvitePage() {",
  "  const { token } = useParams();",
  "  const navigate = useNavigate();",
  "  const [busy, setBusy] = useState(false);",
  "",
  "  async function accept() {",
  "    setBusy(true);",
  "    const res = await api.post(`/invitations/${token}/accept`);",
  "    navigate(`/orgs/${res.orgId}`);",
  "  }",
  "",
  "  return (",
  '    <Card title="You\'re invited">',
  "      <p>Join your team on Rocky to start reviewing.</p>",
  "      <Button onClick={accept} loading={busy}>Accept invitation</Button>",
  "    </Card>",
  "  );",
  "}",
];

const TESTS = [
  'import { describe, it, expect, vi } from "vitest";',
  'import { acceptInvitation, createInvitation } from "./invitations";',
  'import { makeOrg, makeUser } from "../../test/factories";',
  "",
  "const setup = async () => {",
  "  const org = await makeOrg();",
  '  const invite = await createInvitation(org.id, "a@b.co", "member", org.ownerId);',
  "  return { org, invite, user: await makeUser() };",
  "};",
  "",
  'describe("acceptInvitation", () => {',
  '  it("adds the user to the org with the invited role", async () => {',
  "    const { org, invite, user } = await setup();",
  "    await acceptInvitation(invite.token, user);",
  '    expect(await org.roleOf(user.id)).toBe("member");',
  "  });",
  "",
  '  it("rejects expired invitations", async () => { /* … */ });',
  "});",
  "",
];

const added = (path: string, lines: readonly string[], index: string): string[] => [
  `diff --git a/${path} b/${path}`,
  "new file mode 100644",
  `index 0000000..${index}`,
  "--- /dev/null",
  `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map((line) => `+${line}`),
];

const modifiedHeader = (path: string, index: string): string[] => [
  `diff --git a/${path} b/${path}`,
  `index ${index} 100644`,
  `--- a/${path}`,
  `+++ b/${path}`,
];

const API_INDEX = [
  ...modifiedHeader("src/api/index.ts", "1111111..2222222"),
  '@@ -3,3 +3,4 @@ import express from "express";',
  ' import { orgs } from "./routes/orgs";',
  '+import { invitations } from "./routes/invitations";',
  ' import { health } from "./routes/health";',
  ' import { users } from "./routes/users";',
  "@@ -18,4 +19,5 @@ const app = express();",
  ' app.use("/api", health);',
  ' app.use("/api", orgs);',
  '+app.use("/api", invitations);',
  " ",
  " export { app };",
];

const LOCKFILE = [
  ...modifiedHeader("pnpm-lock.yaml", "3333333..4444444"),
  "@@ -1180,9 +1180,40 @@ packages:",
  "   /yaml@2.8.1:",
  "     dev: false",
  "",
  "-  /zod@4.6.5:",
  "-    dev: false",
  "-",
  ...Array.from({ length: 34 }, (_, i) => `+  filler-line-${i + 1}: patch bump`),
  "   /zwitch@2.0.4:",
  "     dev: false",
  "",
];

const GENERATED = [
  ...modifiedHeader("src/generated/api-types.ts", "5555555..6666666"),
  "@@ -210,3 +210,51 @@ export interface Org {",
  "   id: string;",
  "   name: string;",
  " }",
  ...Array.from({ length: 48 }, (_, i) => `+export type InvitationField${i + 1} = string;`),
];

/** The pr-847 diff; `routes` swaps the routes file (the second push). */
export const pr847Diff = (routes: readonly string[] = ROUTES): string =>
  [
    ...added("src/auth/invitations.ts", AUTH, "1000001"),
    ...added("src/api/routes/invitations.ts", routes, "2000002"),
    ...added("db/migrations/20261020_add_invitations.sql", MIGRATION, "3000003"),
    ...added("src/jobs/sendInviteEmail.ts", JOB, "4000004"),
    ...added("web/src/pages/InvitePage.tsx", PAGE, "5000005"),
    ...added("src/auth/invitations.test.ts", TESTS, "6000006"),
    ...API_INDEX,
    ...LOCKFILE,
    ...GENERATED,
  ].join("\n") + "\n";
