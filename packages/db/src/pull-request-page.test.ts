import { createHash, randomUUID } from "node:crypto";
import type { ForgePullRequest, OrgId } from "@rocky-reviews/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type TenantTx } from "./client.js";
import { insertInstallationOrg } from "./installations.js";
import { recordRevision, upsertPullRequest, upsertRepository } from "./mirror.js";
import {
  loadPullRequestDiffTarget,
  loadPullRequestPage,
  PullRequestPageError,
} from "./pull-request-page.js";
import { upsertLoginMember } from "./sessions.js";
import {
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  startPostgres,
  type TestPostgres,
} from "./testing/index.js";

/**
 * H4-2: what the PR page reads. One pull request of an enabled repository, found by
 * `owner/name` (any case) and number, with the head's size, the head revision's latest analysis
 * row, the latest finished analysis (the head's, else an older push's) and the member's latest
 * posted review. Tenant data only inside withOrg, as the application role: another org's pull
 * requests are invisible (RLS).
 */

let pgs: TestPostgres;
let worker: Db;
let app: Db;
let nextInstallation = 90_000;

const sha = (c: string) => c.repeat(40);

const newOrg = async (): Promise<OrgId> => {
  const orgId = newOrgId();
  const installationId = nextInstallation++;
  await worker.withOrg(orgId, (tx) =>
    insertInstallationOrg(tx, {
      forge: "github",
      installationId,
      accountId: installationId + 1,
      login: `acct-${installationId}`,
      kind: "organization",
      installerForgeUserId: null,
    }),
  );
  return orgId;
};

const forgePr = (
  repositoryId: number,
  number: number,
  overrides: Partial<ForgePullRequest> = {},
): ForgePullRequest => ({
  ref: { installationId: 1, repositoryId, number },
  title: `PR ${number}`,
  authorLogin: "dana-k",
  state: "open",
  headSha: sha("a"),
  baseSha: sha("b"),
  openedAt: new Date("2026-10-20T09:00:00Z"),
  closedAt: null,
  updatedAt: new Date("2026-10-25T10:00:00Z"),
  changedFiles: 2,
  additions: 10,
  deletions: 3,
  ...overrides,
});

const DIFF = {
  bytes: 10,
  sha256: createHash("sha256").update("d").digest("hex"),
  truncation: null,
};

const revisionOf = async (tx: TenantTx, pullRequestId: string, headSha: string) => {
  const { rows } = await tx.query<{ id: string }>(
    `insert into pr_revisions (pull_request_id, head_sha, base_sha) values ($1, $2, $3)
     on conflict (org_id, pull_request_id, head_sha) do update set base_sha = excluded.base_sha
     returning id`,
    [pullRequestId, headSha, sha("b")],
  );
  return rows[0]!.id;
};

type Row = {
  status: "queued" | "running" | "awaiting_approval" | "done" | "failed";
  document?: unknown;
  errorCode?: string;
  createdAt?: string;
  completedAt?: string;
};

const analyse = async (tx: TenantTx, revisionId: string, row: Row): Promise<string> => {
  const created = new Date(row.createdAt ?? "2026-10-25T10:05:00Z");
  const finished = ["done", "failed"].includes(row.status)
    ? new Date(row.completedAt ?? created.toISOString())
    : null;
  const { rows } = await tx.query<{ id: string }>(
    `insert into analyses
       (revision_id, status, document, error_code, created_at, completed_at,
        estimated_tokens, limit_tokens, lease_id, lease_until, claimed_at)
     values ($1, $2, $3::jsonb, $4, $5, $6,
             case when $2 = 'awaiting_approval' then 210000 end,
             case when $2 = 'awaiting_approval' then 150000 end,
             case when $2 = 'running' then gen_random_uuid() end,
             case when $2 = 'running' then now() + interval '1 hour' end,
             case when $2 = 'running' then now() end)
     returning id`,
    [
      revisionId,
      row.status,
      row.status === "done" ? JSON.stringify(row.document ?? { doc: true }) : null,
      row.errorCode ?? null,
      created,
      finished,
    ],
  );
  return rows[0]!.id;
};

const posted = async (
  tx: TenantTx,
  target: { pullRequestId: string; revisionId: string; memberId: string },
  verdict: "approve" | "request_changes" | "comment",
  status: "posted" | "failed",
  createdAt: string,
) => {
  await tx.query(
    `insert into review_submissions
       (pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict,
        content_sha256, body_sha256, draft_count, comment_count, status, forge_review_id,
        error_code, created_at, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7, 0, 0, $8, $9, $10, $11, $11)`,
    [
      target.pullRequestId,
      target.revisionId,
      target.memberId,
      randomUUID(),
      sha("a"),
      verdict,
      Buffer.alloc(32),
      status,
      status === "posted" ? 77 : null,
      status === "failed" ? "forge_refused" : null,
      new Date(createdAt),
    ],
  );
};

const memberIn = (orgId: OrgId, forgeUserId: number, login: string) =>
  worker.withOrg(
    orgId,
    async (tx) => (await upsertLoginMember(tx, { forgeUserId, login }))!.memberId,
  );

const load = (orgId: OrgId, owner: string, repo: string, number: number, memberId: string) =>
  app.withOrg(orgId, (tx) => loadPullRequestPage(tx, { owner, repo, number, memberId }));

beforeAll(async () => {
  pgs = await startPostgres();
  worker = createDb({ connectionString: pgs.workerUrl, max: 4 });
  app = createDb({ connectionString: pgs.appUrl, max: 4 });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await worker?.close();
  await pgs?.stop();
});

describe("loadPullRequestPage", () => {
  it("finds the PR by owner/name in any case and number, with its size and nothing analysed", async () => {
    const orgId = await newOrg();
    const me = await memberIn(orgId, 501, "dana-k");
    const id = await worker.withOrg(orgId, async (tx) => {
      const repo = await upsertRepository(tx, {
        id: 7001,
        fullName: "Acme/Rocky-App",
        private: true,
        defaultBranch: "main",
      });
      const pr = await upsertPullRequest(tx, repo, forgePr(7001, 847));
      await recordRevision(tx, pr.id, forgePr(7001, 847), DIFF);
      return pr.id;
    });
    const row = await load(orgId, "acme", "rocky-app", 847, me);
    expect(row).toEqual({
      pullRequestId: id,
      forgeRepoId: 7001,
      repoFullName: "Acme/Rocky-App",
      number: 847,
      title: "PR 847",
      authorLogin: "dana-k",
      state: "open",
      headSha: sha("a"),
      updatedAt: new Date("2026-10-25T10:00:00Z"),
      size: { additions: 10, deletions: 3, files: 2 },
      headRun: null,
      done: null,
      myVerdict: null,
    });
  });

  it("answers null for an unknown number or repository, a disabled repository and impossible names", async () => {
    const orgId = await newOrg();
    const me = await memberIn(orgId, 502, "sam-r");
    await worker.withOrg(orgId, async (tx) => {
      const on = await upsertRepository(tx, {
        id: 7002,
        fullName: "acme/api",
        private: true,
        defaultBranch: "main",
      });
      const off = await upsertRepository(tx, {
        id: 7003,
        fullName: "acme/off",
        private: true,
        defaultBranch: "main",
      });
      await tx.query("update repos set enabled = false where id = $1", [off]);
      await upsertPullRequest(tx, on, forgePr(7002, 1));
      await upsertPullRequest(tx, off, forgePr(7003, 1));
    });
    expect(await load(orgId, "acme", "api", 1, me)).not.toBeNull();
    expect(await load(orgId, "acme", "api", 2, me)).toBeNull();
    expect(await load(orgId, "acme", "web", 1, me)).toBeNull();
    expect(await load(orgId, "acme", "off", 1, me)).toBeNull();
    // `_` and `%` are not LIKE wildcards here, and names outside the forge's rules match nothing.
    expect(await load(orgId, "acme", "a_i", 1, me)).toBeNull();
    expect(await load(orgId, "acme", "api/x", 1, me)).toBeNull();
    expect(await load(orgId, "-acme", "api", 1, me)).toBeNull();
    // The head has no revision: no size.
    expect((await load(orgId, "acme", "api", 1, me))?.size).toBeNull();
  });

  it("refuses a malformed member id or number before querying", async () => {
    const orgId = await newOrg();
    await expect(load(orgId, "acme", "api", 1, "nope")).rejects.toBeInstanceOf(
      PullRequestPageError,
    );
    await expect(load(orgId, "acme", "api", 0, randomUUID())).rejects.toThrow("invalid number");
    await expect(load(orgId, "acme", "api", 1.5, randomUUID())).rejects.toThrow("invalid number");
    await expect(
      app.withOrg(orgId, (tx) =>
        loadPullRequestPage(tx, {
          owner: 1 as unknown as string,
          repo: "api",
          number: 1,
          memberId: randomUUID(),
        }),
      ),
    ).rejects.toThrow("invalid repository");
  });

  it("reports the head revision's latest row: its status, code and token estimate", async () => {
    const orgId = await newOrg();
    const me = await memberIn(orgId, 503, "lee");
    const cases: [
      number,
      Row[],
      Partial<NonNullable<Awaited<ReturnType<typeof load>>>["headRun"]>,
    ][] = [
      [1, [{ status: "queued" }], { status: "queued", errorCode: null }],
      [2, [{ status: "running" }], { status: "running" }],
      [
        3,
        [{ status: "awaiting_approval" }],
        { status: "awaiting_approval", estimatedTokens: 210_000, limitTokens: 150_000 },
      ],
      [
        4,
        [
          { status: "failed", errorCode: "provider_error", createdAt: "2026-10-25T10:00:00Z" },
          { status: "failed", errorCode: "superseded", createdAt: "2026-10-25T10:10:00Z" },
        ],
        { status: "failed", errorCode: "superseded" },
      ],
    ];
    for (const [number, rows] of cases) {
      await worker.withOrg(orgId, async (tx) => {
        const repo = await upsertRepository(tx, {
          id: 7010,
          fullName: "acme/runs",
          private: true,
          defaultBranch: "main",
        });
        const pr = await upsertPullRequest(tx, repo, forgePr(7010, number));
        const revision = await revisionOf(tx, pr.id, sha("a"));
        for (const row of rows) await analyse(tx, revision, row);
      });
    }
    for (const [number, , expected] of cases) {
      const row = await load(orgId, "acme", "runs", number, me);
      expect(row?.headRun, `#${number}`).toMatchObject(expected!);
      expect(row?.done, `#${number}`).toBeNull();
    }
  });

  it("serves the head's latest finished document, else an older push's", async () => {
    const orgId = await newOrg();
    const me = await memberIn(orgId, 504, "kim");
    const ids = await worker.withOrg(orgId, async (tx) => {
      const repo = await upsertRepository(tx, {
        id: 7020,
        fullName: "acme/docs",
        private: true,
        defaultBranch: "main",
      });
      // #1: the head was analysed twice and is being analysed again.
      const one = await upsertPullRequest(tx, repo, forgePr(7020, 1));
      const oneHead = await revisionOf(tx, one.id, sha("a"));
      await analyse(tx, oneHead, {
        status: "done",
        document: { n: "first" },
        createdAt: "2026-10-25T09:00:00Z",
      });
      const second = await analyse(tx, oneHead, {
        status: "done",
        document: { n: "second" },
        createdAt: "2026-10-25T09:30:00Z",
      });
      const rerun = await analyse(tx, oneHead, { status: "queued" });
      // #2: pushed since; only the older push has a document, the head waits for approval.
      const two = await upsertPullRequest(tx, repo, forgePr(7020, 2, { headSha: sha("c") }));
      const older = await revisionOf(tx, two.id, sha("a"));
      const olderDoc = await analyse(tx, older, { status: "done", document: { n: "older" } });
      const twoHead = await revisionOf(tx, two.id, sha("c"));
      const waiting = await analyse(tx, twoHead, { status: "awaiting_approval" });
      // #3: an older push's document beats nothing, and the head has no row at all.
      const three = await upsertPullRequest(tx, repo, forgePr(7020, 3, { headSha: sha("d") }));
      const threeOld = await revisionOf(tx, three.id, sha("e"));
      const threeDoc = await analyse(tx, threeOld, { status: "done", document: { n: "e" } });
      return { second, rerun, olderDoc, waiting, threeDoc };
    });
    const one = await load(orgId, "acme", "docs", 1, me);
    expect(one?.done).toEqual({
      analysisId: ids.second,
      headSha: sha("a"),
      document: { n: "second" },
    });
    expect(one?.headRun).toMatchObject({ analysisId: ids.rerun, status: "queued" });
    const two = await load(orgId, "acme", "docs", 2, me);
    expect(two?.done).toEqual({
      analysisId: ids.olderDoc,
      headSha: sha("a"),
      document: { n: "older" },
    });
    expect(two?.headRun).toMatchObject({ analysisId: ids.waiting, status: "awaiting_approval" });
    const three = await load(orgId, "acme", "docs", 3, me);
    expect(three?.done?.analysisId).toBe(ids.threeDoc);
    expect(three?.headRun).toBeNull();
  });

  it("carries the member's own latest posted review, never a failed one or someone else's", async () => {
    const orgId = await newOrg();
    const me = await memberIn(orgId, 505, "pat");
    const other = await memberIn(orgId, 506, "ren");
    const target = await worker.withOrg(orgId, async (tx) => {
      const repo = await upsertRepository(tx, {
        id: 7030,
        fullName: "acme/reviews",
        private: true,
        defaultBranch: "main",
      });
      const pr = await upsertPullRequest(tx, repo, forgePr(7030, 9));
      return { pullRequestId: pr.id, revisionId: await revisionOf(tx, pr.id, sha("a")) };
    });
    expect((await load(orgId, "acme", "reviews", 9, me))?.myVerdict).toBeNull();
    await worker.withOrg(orgId, async (tx) => {
      const mine = { ...target, memberId: me };
      await posted(tx, mine, "comment", "posted", "2026-10-25T10:00:00Z");
      await posted(tx, mine, "request_changes", "posted", "2026-10-25T11:00:00Z");
      await posted(tx, mine, "approve", "failed", "2026-10-25T12:00:00Z");
      await posted(tx, { ...target, memberId: other }, "approve", "posted", "2026-10-25T13:00:00Z");
    });
    expect((await load(orgId, "acme", "reviews", 9, me))?.myVerdict).toBe("request_changes");
    expect((await load(orgId, "acme", "reviews", 9, other))?.myVerdict).toBe("approve");
  });

  it("never reads another org's pull request (RLS)", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const meB = await memberIn(b, 507, "bo");
    await worker.withOrg(a, async (tx) => {
      const repo = await upsertRepository(tx, {
        id: 7040,
        fullName: "shared/name",
        private: true,
        defaultBranch: "main",
      });
      await upsertPullRequest(tx, repo, forgePr(7040, 5));
    });
    expect(await load(b, "shared", "name", 5, meB)).toBeNull();
  });
});

describe("loadPullRequestDiffTarget (H4-3)", () => {
  it("resolves what the diff endpoint needs: ids, the head and its recorded base, the installation", async () => {
    const org = await newOrg();
    const installationId = nextInstallation - 1;
    const { pullRequestId } = await worker.withOrg(org, async (tx) => {
      const repo = await upsertRepository(tx, {
        id: 7100,
        fullName: "Acme/Diff-App",
        private: true,
        defaultBranch: "main",
      });
      const created = await upsertPullRequest(tx, repo, forgePr(7100, 12));
      await recordRevision(tx, created.id, forgePr(7100, 12), DIFF);
      return { pullRequestId: created.id };
    });
    const target = await app.withOrg(org, (tx) =>
      loadPullRequestDiffTarget(tx, { owner: "acme", repo: "diff-app", number: 12 }),
    );
    expect(target).toEqual({
      pullRequestId,
      forgeRepoId: 7100,
      installationId,
      headSha: sha("a"),
      baseSha: sha("b"),
    });
  });

  it("a PR without a recorded head revision takes the pull request's own base, never GitHub's", async () => {
    const org = await newOrg();
    await worker.withOrg(org, async (tx) => {
      const repo = await upsertRepository(tx, {
        id: 7101,
        fullName: "acme/no-revision",
        private: true,
        defaultBranch: "main",
      });
      await upsertPullRequest(tx, repo, forgePr(7101, 3, { headSha: sha("c"), baseSha: sha("e") }));
    });
    const target = await app.withOrg(org, (tx) =>
      loadPullRequestDiffTarget(tx, { owner: "acme", repo: "no-revision", number: 3 }),
    );
    expect(target).toMatchObject({ forgeRepoId: 7101, headSha: sha("c"), baseSha: sha("e") });
  });

  it("answers null for an unknown PR, a disabled repository, impossible names and another org's PR (RLS)", async () => {
    const org = await newOrg();
    const other = await newOrg();
    const repoId = await worker.withOrg(org, async (tx) => {
      const repo = await upsertRepository(tx, {
        id: 7102,
        fullName: "acme/gated",
        private: true,
        defaultBranch: "main",
      });
      await upsertPullRequest(tx, repo, forgePr(7102, 4));
      return repo;
    });
    const target = (o: OrgId, owner: string, repo: string, number: number) =>
      app.withOrg(o, (tx) => loadPullRequestDiffTarget(tx, { owner, repo, number }));
    expect(await target(org, "acme", "gated", 4)).not.toBeNull();
    expect(await target(org, "acme", "gated", 5)).toBeNull();
    expect(await target(org, "acme", "other", 4)).toBeNull();
    expect(await target(org, "acme", "..", 4)).toBeNull();
    expect(await target(org, "a c", "gated", 4)).toBeNull();
    expect(await target(other, "acme", "gated", 4)).toBeNull();
    await worker.withOrg(org, (tx) =>
      tx.query("update repos set enabled = false where id = $1", [repoId]),
    );
    expect(await target(org, "acme", "gated", 4)).toBeNull();
  });

  it("refuses a malformed number before querying", async () => {
    const org = await newOrg();
    for (const number of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      await expect(
        app.withOrg(org, (tx) =>
          loadPullRequestDiffTarget(tx, { owner: "acme", repo: "gated", number }),
        ),
      ).rejects.toThrow(PullRequestPageError);
    }
  });
});
