import type { OrgId } from "@rocky-reviews/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccessInputError,
  loadRepositoryAccessContext,
  resolveRepositoryForAccess,
} from "./access.js";
import { createDb, type Db } from "./client.js";
import { markMemberRemoved } from "./sessions.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P3-6 review round 1 (ADR 0011 §6): the narrow reads a route makes before the access check,
 * against a real Postgres as the application role (RLS).
 */

let pgs: TestPostgres;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 61 }));
  B = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 62 }));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await pgs?.stop();
});

const UNKNOWN = "5d1e9f00-dddd-4bcd-9e00-000000000009";

describe("resolveRepositoryForAccess", () => {
  it("resolves the forge repository id from a repository or a pull request of the org", async () => {
    await db.withOrg(A.orgId, async (tx) => {
      expect(await resolveRepositoryForAccess(tx, { repoId: A.repoId })).toEqual({
        forgeRepoId: 2001,
      });
      expect(await resolveRepositoryForAccess(tx, { pullRequestId: A.pullRequestId })).toEqual({
        forgeRepoId: 2001,
      });
    });
  });

  it("another org's repository or pull request, or an unknown id, is null (explicit org filter)", async () => {
    await db.withOrg(A.orgId, async (tx) => {
      expect(await resolveRepositoryForAccess(tx, { repoId: B.repoId })).toBeNull();
      expect(await resolveRepositoryForAccess(tx, { pullRequestId: B.pullRequestId })).toBeNull();
      expect(await resolveRepositoryForAccess(tx, { repoId: UNKNOWN })).toBeNull();
      expect(await resolveRepositoryForAccess(tx, { pullRequestId: UNKNOWN })).toBeNull();
    });
  });

  it("RLS alone hides another org's rows (no org_id predicate in the query)", async () => {
    await db.withOrg(A.orgId, async (tx) => {
      const repos = await tx.query("select id, forge_repo_id from repos where id = $1", [B.repoId]);
      const pulls = await tx.query(
        `select r.forge_repo_id from pull_requests p join repos r on r.id = p.repo_id
          where p.id = $1`,
        [B.pullRequestId],
      );
      const members = await tx.query("select id from members where id = $1", [B.memberId]);
      expect([repos.rowCount, pulls.rowCount, members.rowCount]).toEqual([0, 0, 0]);
      // Positive control: the same queries see the org's own rows.
      const own = await tx.query("select id from repos where id = $1", [A.repoId]);
      expect(own.rowCount).toBe(1);
    });
  });

  it("refuses malformed or ambiguous input before any query", async () => {
    await db.withOrg(A.orgId, async (tx) => {
      for (const bad of [
        { repoId: "not-a-uuid" },
        { pullRequestId: `${A.pullRequestId}' or 1=1 --` },
        { repoId: A.repoId, pullRequestId: A.pullRequestId },
        {},
        { repoId: 1 },
      ]) {
        await expect(
          resolveRepositoryForAccess(tx, bad as { repoId: string }),
        ).rejects.toBeInstanceOf(AccessInputError);
      }
    });
  });
});

describe("loadRepositoryAccessContext", () => {
  it("returns the member's forge user id with the context", async () => {
    const context = await db.withOrg(A.orgId, (tx) =>
      loadRepositoryAccessContext(tx, { memberId: A.memberId, forgeRepoId: 2001 }),
    );
    expect(context).toMatchObject({
      member: true,
      forgeUserId: 1001,
      installationId: 61,
      repositoryFullName: "org-61/api",
      token: null,
    });
    const other = await db.withOrg(A.orgId as OrgId, (tx) =>
      loadRepositoryAccessContext(tx, { memberId: B.memberId, forgeRepoId: 2001 }),
    );
    expect(other).toMatchObject({ member: false, forgeUserId: null });
  });

  it("a member removed in Rocky is not a member any more (P7-1 review round 1)", async () => {
    const C = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 63 }));
    expect(await db.withOrg(C.orgId, (tx) => markMemberRemoved(tx, C.memberId))).toBe(true);
    const context = await db.withOrg(C.orgId, (tx) =>
      loadRepositoryAccessContext(tx, { memberId: C.memberId, forgeRepoId: 2001 }),
    );
    expect(context).toMatchObject({ member: false, forgeUserId: null, token: null });
  });
});
