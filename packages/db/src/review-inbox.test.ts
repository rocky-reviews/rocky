import { createHash } from "node:crypto";
import type { ForgePullRequest, OrgId } from "@rocky-reviews/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type TenantTx } from "./client.js";
import { listInboxRows, loadInboxRows, memberLogin } from "./review-inbox.js";
import { insertInstallationOrg } from "./installations.js";
import { upsertLoginMember } from "./sessions.js";
import { recordRevision, upsertPullRequest, upsertRepository } from "./mirror.js";
import {
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  startPostgres,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P6-7: what the inbox reads (ADR 0029). Open pull requests of the org's enabled repositories,
 * most recently updated first, each with its head revision's size and diff reading and its
 * latest analysis (the head's first, else an older push's). Tenant data only inside withOrg, as
 * the application role: another org's pull requests are invisible (RLS).
 */

let pgs: TestPostgres;
let worker: Db;
let app: Db;
let nextInstallation = 70_000;

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

const repoOf = (tx: TenantTx, id: number, fullName: string) =>
  upsertRepository(tx, { id, fullName, private: true, defaultBranch: "main" });

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

const diff = (truncation: "max_bytes" | null = null) => ({
  bytes: 10,
  sha256: createHash("sha256").update("diff").digest("hex"),
  truncation,
});

const analyse = async (
  tx: TenantTx,
  pullRequestId: string,
  headSha: string,
  status: "queued" | "done" | "failed",
  document: unknown = null,
  createdAt = new Date("2026-10-25T10:05:00Z"),
) => {
  const revision = await tx.query<{ id: string }>(
    `insert into pr_revisions (pull_request_id, head_sha, base_sha) values ($1, $2, $3)
     on conflict (org_id, pull_request_id, head_sha) do update set base_sha = excluded.base_sha
     returning id`,
    [pullRequestId, headSha, sha("b")],
  );
  await tx.query(
    `insert into analyses (revision_id, status, document, created_at, completed_at)
     values ($1, $2, $3::jsonb, $4, $5)`,
    [
      revision.rows[0]!.id,
      status,
      document === null ? null : JSON.stringify(document),
      createdAt,
      status === "queued" ? null : createdAt,
    ],
  );
};

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

describe("listInboxRows", () => {
  it("lists open PRs of enabled repositories, newest first, with size and analysis", async () => {
    const orgId = await newOrg();
    const ids = await worker.withOrg(orgId, async (tx) => {
      const api = await repoOf(tx, 501, "acme/api");
      const web = await repoOf(tx, 502, "acme/web");
      const off = await repoOf(tx, 503, "acme/off");
      await tx.query("update repos set enabled = false where id = $1", [off]);

      const current = await upsertPullRequest(tx, api, forgePr(501, 1));
      await recordRevision(tx, current.id, forgePr(501, 1), diff());
      await analyse(tx, current.id, sha("a"), "done", { schemaVersion: "1.1.0" });

      const movedPr = forgePr(502, 2, {
        headSha: sha("c"),
        updatedAt: new Date("2026-10-25T11:00:00Z"),
        additions: 400,
      });
      const moved = await upsertPullRequest(tx, web, movedPr);
      await recordRevision(tx, moved.id, movedPr, diff("max_bytes"));
      await analyse(tx, moved.id, sha("a"), "done", { old: true });

      const unread = await upsertPullRequest(
        tx,
        web,
        forgePr(502, 3, { updatedAt: new Date("2026-10-25T09:00:00Z"), authorLogin: null }),
      );
      await upsertPullRequest(tx, api, forgePr(501, 4, { state: "closed", closedAt: new Date() }));
      await upsertPullRequest(tx, off, forgePr(503, 5));
      return { current: current.id, moved: moved.id, unread: unread.id };
    });

    const { rows, truncated } = await app.withOrg(orgId, (tx) => listInboxRows(tx, { limit: 10 }));
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.pullRequestId)).toEqual([ids.moved, ids.current, ids.unread]);

    const [moved, current, unread] = rows;
    expect(current).toEqual({
      pullRequestId: ids.current,
      forgeRepoId: 501,
      repoFullName: "acme/api",
      number: 1,
      title: "PR 1",
      authorLogin: "dana-k",
      state: "open",
      headSha: sha("a"),
      updatedAt: new Date("2026-10-25T10:00:00Z"),
      size: { additions: 10, deletions: 3, files: 2 },
      diffIncomplete: false,
      analysis: { status: "done", headSha: sha("a"), document: { schemaVersion: "1.1.0" } },
    });
    // An older push's analysis, the head's truncated diff.
    expect(moved).toMatchObject({
      headSha: sha("c"),
      size: { additions: 400, deletions: 3, files: 2 },
      diffIncomplete: true,
      analysis: { status: "done", headSha: sha("a"), document: { old: true } },
    });
    // No revision, no analysis.
    expect(unread).toMatchObject({
      authorLogin: null,
      size: null,
      diffIncomplete: true,
      analysis: null,
    });
  });

  it("prefers the head's latest analysis over an older push's newer one", async () => {
    const orgId = await newOrg();
    await worker.withOrg(orgId, async (tx) => {
      const repo = await repoOf(tx, 601, "acme/api");
      const pr = await upsertPullRequest(tx, repo, forgePr(601, 1));
      await analyse(tx, pr.id, sha("a"), "failed", null, new Date("2026-10-25T10:00:00Z"));
      await analyse(tx, pr.id, sha("a"), "queued", null, new Date("2026-10-25T10:10:00Z"));
      await analyse(tx, pr.id, sha("e"), "done", { x: 1 }, new Date("2026-10-25T10:20:00Z"));
    });
    const { rows } = await app.withOrg(orgId, (tx) => listInboxRows(tx, { limit: 10 }));
    expect(rows[0]?.analysis).toEqual({ status: "queued", headSha: sha("a"), document: null });
  });

  it("stops at the limit and says more exist", async () => {
    const orgId = await newOrg();
    await worker.withOrg(orgId, async (tx) => {
      const repo = await repoOf(tx, 701, "acme/api");
      for (const n of [1, 2, 3]) {
        await upsertPullRequest(
          tx,
          repo,
          forgePr(701, n, { updatedAt: new Date(Date.UTC(2026, 9, 20 + n)) }),
        );
      }
    });
    const { rows, truncated } = await app.withOrg(orgId, (tx) => listInboxRows(tx, { limit: 2 }));
    expect(truncated).toBe(true);
    expect(rows.map((r) => r.number)).toEqual([3, 2]);
  });

  it("never shows another org's pull requests (RLS)", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await worker.withOrg(a, async (tx) => {
      const repo = await repoOf(tx, 801, "acme/secret");
      await upsertPullRequest(tx, repo, forgePr(801, 1));
    });
    const { rows } = await app.withOrg(b, (tx) => listInboxRows(tx, { limit: 10 }));
    expect(rows).toEqual([]);
  });

  it("refuses a limit outside 1..1000", async () => {
    const orgId = await newOrg();
    for (const limit of [0, -1, 1001, 1.5]) {
      await expect(app.withOrg(orgId, (tx) => listInboxRows(tx, { limit }))).rejects.toThrow(
        /^inbox: invalid limit$/,
      );
    }
  });
});

describe("loadInboxRows", () => {
  it("loads the named PRs whatever their state, and nothing of another org", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const ids = await worker.withOrg(a, async (tx) => {
      const repo = await repoOf(tx, 901, "acme/api");
      const open = await upsertPullRequest(tx, repo, forgePr(901, 1));
      const closed = await upsertPullRequest(
        tx,
        repo,
        forgePr(901, 2, { state: "merged", closedAt: new Date() }),
      );
      return [open.id, closed.id];
    });
    const rows = await app.withOrg(a, (tx) => loadInboxRows(tx, ids));
    expect(rows.map((r) => [r.number, r.state]).toSorted()).toEqual([
      [1, "open"],
      [2, "merged"],
    ]);
    expect(await app.withOrg(b, (tx) => loadInboxRows(tx, ids))).toEqual([]);
    expect(await app.withOrg(a, (tx) => loadInboxRows(tx, []))).toEqual([]);
  });

  it("refuses ids that are not uuids", async () => {
    const orgId = await newOrg();
    await expect(app.withOrg(orgId, (tx) => loadInboxRows(tx, ["1 or 1=1"]))).rejects.toThrow(
      /^inbox: invalid pull request id$/,
    );
  });
});

describe("member login", () => {
  it("is read inside the org", async () => {
    const orgId = await newOrg();
    const memberId = await worker.withOrg(orgId, async (tx) => {
      const row = await upsertLoginMember(tx, { forgeUserId: 4242, login: "Sam-R" });
      return row!.memberId;
    });
    expect(await app.withOrg(orgId, (tx) => memberLogin(tx, memberId))).toBe("Sam-R");
    expect(await app.withOrg(await newOrg(), (tx) => memberLogin(tx, memberId))).toBeNull();
  });
});
