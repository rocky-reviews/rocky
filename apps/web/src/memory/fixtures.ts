/**
 * The memory page's fixture (P8-3): one repository's project memory, one entry per state the page
 * designs (learned and member-written; conventions, decisions and dismissals; a former member; a
 * switched-off entry; an edited entry with its earlier version; text that looks like markdown and
 * HTML; a long path). The same JSON is what the e2e tests serve as the API's answer.
 *
 * Plain data, no imports: the e2e tests load this file outside the app's bundler.
 */

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (seed: string): string => seed.repeat(40 / seed.length);

/** The fixture clock (the inbox's). */
export const MEMORY_FIXTURE_NOW = "2026-10-25T12:12:00.000Z";
export const MEMORY_FIXTURE_REPO = { owner: "acme", name: "rocky-app" } as const;

export const memoryEntryId = id;

export const MEMORY_FIXTURE = {
  repository: { ...MEMORY_FIXTURE_REPO, memoryEnabled: true },
  canEdit: true,
  truncated: false,
  entries: [
    {
      id: id(1),
      kind: "dismissal",
      origin: "learned",
      text: "Dismissed as intentional: Swallowed error in the nightly billing retry loop",
      reason: "intentional",
      severity: "medium",
      evidence: {
        path: "src/jobs/billing/retry-unpaid.ts",
        sha: sha("9b4e1d7a"),
        range: { start: 41, end: 48 },
        pullRequestNumber: 812,
      },
      confidence: 90,
      author: { kind: "member", login: "dana-k" },
      createdAt: "2026-10-20T09:30:00.000Z",
      lastUsedAt: "2026-10-25T11:40:00.000Z",
      supersededBy: null,
      disabledAt: null,
    },
    {
      id: id(2),
      kind: "convention",
      origin: "member",
      text: "Org-scoped routes use requireOrgRole(), never a hand-written role check",
      reason: null,
      severity: null,
      evidence: {
        path: "src/api/routes/invitations.ts",
        sha: sha("c3f0a2b1"),
        range: { start: 12, end: 14 },
        pullRequestNumber: 598,
      },
      confidence: 80,
      author: { kind: "member", login: "sam-r" },
      createdAt: "2026-10-18T15:00:00.000Z",
      lastUsedAt: "2026-10-24T08:00:00.000Z",
      supersededBy: null,
      disabledAt: null,
    },
    {
      id: id(3),
      kind: "convention",
      origin: "learned",
      text: "Accepted in review: Org-scoped routes check the role with a hand-written if",
      reason: null,
      severity: null,
      evidence: {
        path: "src/api/routes/invitations.ts",
        sha: sha("a1b2c3d4"),
        range: { start: 12, end: 13 },
        pullRequestNumber: 571,
      },
      confidence: 60,
      author: { kind: "member", login: "dana-k" },
      createdAt: "2026-10-02T10:00:00.000Z",
      lastUsedAt: "2026-10-12T10:00:00.000Z",
      supersededBy: id(2),
      disabledAt: null,
    },
    {
      id: id(4),
      kind: "decision",
      origin: "member",
      text: "Keep the legacy /v1/invite endpoint until the Q2 mobile release ships",
      reason: null,
      severity: null,
      evidence: {
        path: "src/api/v1/invite.ts",
        sha: sha("5e6f7a8b"),
        range: { start: 1, end: 30 },
        pullRequestNumber: 612,
      },
      confidence: 100,
      author: { kind: "former_member" },
      createdAt: "2026-09-30T12:00:00.000Z",
      lastUsedAt: null,
      supersededBy: null,
      disabledAt: null,
    },
    {
      id: id(5),
      kind: "dismissal",
      origin: "learned",
      text: "Dismissed as not an issue: Logging the request id in the <audit> helper (see `log()` | **ids only**)",
      reason: "not_an_issue",
      severity: null,
      evidence: {
        path: "src/lib/very/deeply/nested/module/path/that/keeps/going/audit-logger.helpers.ts",
        sha: sha("0f1e2d3c"),
        range: { start: 7, end: 7 },
        pullRequestNumber: 655,
      },
      confidence: 70,
      author: { kind: "member", login: "lee-ops" },
      createdAt: "2026-10-10T09:00:00.000Z",
      lastUsedAt: "2026-10-11T09:00:00.000Z",
      supersededBy: null,
      disabledAt: "2026-10-22T16:00:00.000Z",
    },
    {
      id: id(6),
      kind: "dismissal",
      origin: "learned",
      text: "Dismissed as handled elsewhere: Deleting an org won't remove its invitations",
      reason: "handled_elsewhere",
      severity: "high",
      evidence: {
        path: "src/db/org-deletion.ts",
        sha: sha("77aa88bb"),
        range: { start: 88, end: 102 },
        pullRequestNumber: 640,
      },
      confidence: 70,
      author: { kind: "member", login: "sam-r" },
      createdAt: "2026-10-08T14:00:00.000Z",
      lastUsedAt: null,
      supersededBy: null,
      disabledAt: null,
    },
  ],
};
