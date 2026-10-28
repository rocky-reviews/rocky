import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, type TenantTx } from "./client.js";
import { beginOrgErasure, scheduleOrgDeletion } from "./installations.js";
import {
  changeMemberRole,
  claimFirstOwner,
  listMembers,
  memberLeftForge,
  MemberStoreError,
  removeMember,
  restoreMember,
  transferOwnership,
} from "./members.js";
import { loadForgeToken, storeForgeToken } from "./secrets.js";
import { loadSessionMember, upsertLoginMember } from "./sessions.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P7-2 (migration 0014, ADR 0024): roles and membership changes on a real Postgres as the
 * application role. What the database guarantees is tested here: an org with an owner keeps one
 * (trigger, serialised by the owner lock, so concurrent demotions cannot both win), the first
 * owner is made once, changes stay inside the tenant (RLS), every change is audited in its own
 * transaction, removal and "left the GitHub org" cut sessions and delete the stored token.
 */

const sha = (value: string) => createHash("sha256").update(value).digest();
const CIPHERTEXT = `rk1:${Buffer.concat([Buffer.from([0, 0, 0, 1]), randomBytes(40)]).toString("base64url")}`;

let pgs: TestPostgres;
let db: Db;
let pool: pg.Pool;
let superuser: pg.Pool;
let worker: Db;
let A: SeededOrg;
let B: SeededOrg;
let nextForgeId = 50_000;

beforeAll(async () => {
  pgs = await startPostgres();
  pool = new pg.Pool({ connectionString: pgs.appUrl, max: 6 }).on("error", ignoreIdleError);
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  db = createDb({ pool });
  worker = createDb({ connectionString: pgs.workerUrl, max: 2 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 61 }),
    await seedOrg(w, newOrgId(), { installationId: 62 }),
  ]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

const installations = new Map<string, number>();
/** A fresh org (so owner state never leaks between tests). */
const freshOrg = async () => {
  const installationId = nextForgeId++;
  const org = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId }));
  installations.set(org.orgId, installationId);
  return org;
};

const addMember = (org: SeededOrg, role: "owner" | "admin" | "member" = "member") =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into members (forge_user_id, login, role) values ($1, $2, $3) returning id",
      [nextForgeId++, `user-${nextForgeId}`, role],
    );
    return rows[0]!.id;
  });

const roleOf = (org: SeededOrg, memberId: string) =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ role: string; removed: boolean }>(
      "select role, removed_at is not null as removed from members where id = $1",
      [memberId],
    );
    return rows[0];
  });

const auditOf = async (orgId: string, action: string) =>
  (
    await superuser.query<{
      actor_type: string;
      actor_id: string;
      target_id: string;
      metadata: unknown;
    }>(
      "select actor_type, actor_id, target_id, metadata from audit_events where org_id = $1 and action = $2 order by id",
      [orgId, action],
    )
  ).rows;

const pgCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
};

/** A live session linked to `memberId` in `org` (what removal must cut). */
const sessionFor = async (org: SeededOrg, memberId: string, forgeUserId: number) => {
  const now = new Date();
  const { userId } = await db.sessions.upsertUser("github", forgeUserId, now);
  const { sessionId } = await db.sessions.createSession({
    tokenSha256: sha(randomBytes(32).toString("base64url")),
    userId,
    orgs: [{ orgId: org.orgId, memberId }],
    activeOrgId: org.orgId,
    now,
    idleTimeoutSeconds: 3600,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return sessionId;
};

const linksOf = async (memberId: string) =>
  Number(
    (
      await superuser.query<{ n: string }>(
        "select count(*)::text as n from app.session_orgs where member_id = $1",
        [memberId],
      )
    ).rows[0]?.n,
  );

const forgeIdOf = (org: SeededOrg, memberId: string) =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ f: string }>(
      "select forge_user_id::text as f from members where id = $1",
      [memberId],
    );
    return Number(rows[0]!.f);
  });

describe("an org with an owner always keeps one (trigger members_keep_an_owner)", () => {
  it("refuses demoting, removing or deleting the only owner, for the application", async () => {
    const org = await freshOrg();
    const owner = await addMember(org, "owner");
    for (const sql of [
      "update members set role = 'admin' where id = $1",
      "update members set removed_at = now() where id = $1",
      "delete from members where id = $1",
    ]) {
      expect(await pgCode(db.withOrg(org.orgId, (tx) => tx.query(sql, [owner]))), sql).toBe(
        "23514",
      );
    }
    expect(await roleOf(org, owner)).toEqual({ role: "owner", removed: false });
  });

  it("allows it once another owner exists, and never across tenants", async () => {
    const org = await freshOrg();
    const first = await addMember(org, "owner");
    const second = await addMember(org, "owner");
    await db.withOrg(org.orgId, (tx) =>
      tx.query("update members set role = 'admin' where id = $1", [first]),
    );
    expect(await roleOf(org, first)).toEqual({ role: "admin", removed: false });
    // B's owner does not count for this org (RLS shows the trigger this org only).
    await addMember(B, "owner");
    expect(
      await pgCode(
        db.withOrg(org.orgId, (tx) =>
          tx.query("update members set role = 'member' where id = $1", [second]),
        ),
      ),
    ).toBe("23514");
  });

  it("serialises concurrent demotions: of two owners demoting each other, exactly one wins (race)", async () => {
    for (let round = 0; round < 5; round++) {
      const org = await freshOrg();
      const one = await addMember(org, "owner");
      const two = await addMember(org, "owner");
      // Both transactions read "two owners" before either writes; only the lock decides.
      const demote = (memberId: string) =>
        db.withOrg(org.orgId, async (tx: TenantTx) => {
          await tx.query("select count(*) from members where role = 'owner'");
          await new Promise((r) => setTimeout(r, 20));
          await tx.query("update members set role = 'admin' where id = $1", [memberId]);
        });
      const results = await Promise.allSettled([demote(one), demote(two)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect((rejected?.reason as { code?: string }).code).toBe("23514");
      const owners = await db.withOrg(org.orgId, (tx) =>
        tx.query("select 1 from members where role = 'owner' and removed_at is null"),
      );
      expect(owners.rowCount).toBe(1);
    }
  });

  it("does not stand in the way of erasing the org (retention.delete_org)", async () => {
    const org = await freshOrg();
    await addMember(org, "owner");
    const installationId = installations.get(org.orgId)!;
    expect(await worker.withOrg(org.orgId, (tx) => scheduleOrgDeletion(tx, installationId))).toBe(
      "scheduled",
    );
    // Time travel past the grace period, as the deletion suite does (triggers out of the way).
    await superuser.query("alter table orgs disable trigger user");
    try {
      await superuser.query(
        "update orgs set delete_after = now() - interval '1 second' where id = $1",
        [org.orgId],
      );
    } finally {
      await superuser.query("alter table orgs enable trigger user");
    }
    expect(await worker.withOrg(org.orgId, (tx) => beginOrgErasure(tx))).toBe("started");
    const deleted = await worker.deleteOrg(org.orgId);
    expect(deleted.find((d) => d.table === "orgs")?.deleted).toBe(1);
  });
});

describe("the first owner (claimFirstOwner)", () => {
  it("makes an owner only while the org has none, once, audited", async () => {
    const org = await freshOrg();
    const first = await addMember(org);
    const second = await addMember(org);
    expect(await db.withOrg(org.orgId, (tx) => claimFirstOwner(tx, first))).toBe(true);
    expect(await db.withOrg(org.orgId, (tx) => claimFirstOwner(tx, second))).toBe(false);
    expect(await db.withOrg(org.orgId, (tx) => claimFirstOwner(tx, first))).toBe(false);
    expect((await roleOf(org, second))?.role).toBe("member");
    expect(await auditOf(org.orgId, "member.first_owner")).toEqual([
      { actor_type: "system", actor_id: "sign_in", target_id: first, metadata: {} },
    ]);
  });

  it("two first sign-ins at once make exactly one owner (owner lock)", async () => {
    for (let round = 0; round < 5; round++) {
      const org = await freshOrg();
      const ids = await Promise.all([addMember(org), addMember(org), addMember(org)]);
      const won = await Promise.all(
        ids.map((id) => db.withOrg(org.orgId, (tx) => claimFirstOwner(tx, id))),
      );
      expect(won.filter(Boolean)).toHaveLength(1);
    }
  });

  it("never makes a removed member or another org's member the owner", async () => {
    const org = await freshOrg();
    const gone = await addMember(org);
    await db.withOrg(org.orgId, (tx) =>
      tx.query("update members set removed_at = now() where id = $1", [gone]),
    );
    expect(await db.withOrg(org.orgId, (tx) => claimFirstOwner(tx, gone))).toBe(false);
    expect(await db.withOrg(org.orgId, (tx) => claimFirstOwner(tx, B.memberId))).toBe(false);
    expect((await roleOf(B, B.memberId))?.role).toBe("admin");
  });
});

describe("role changes (changeMemberRole)", () => {
  let org: SeededOrg;
  let owner: string;
  beforeEach(async () => {
    org = await freshOrg();
    owner = await addMember(org, "owner");
  });

  it("promotes and demotes between member and admin, audited with from and to", async () => {
    const target = await addMember(org);
    expect(
      await db.withOrg(org.orgId, (tx) =>
        changeMemberRole(tx, { actorMemberId: owner, targetMemberId: target, role: "admin" }),
      ),
    ).toEqual({ outcome: "changed", from: "member", to: "admin" });
    expect(
      await db.withOrg(org.orgId, (tx) =>
        changeMemberRole(tx, { actorMemberId: owner, targetMemberId: target, role: "admin" }),
      ),
    ).toEqual({ outcome: "unchanged" });
    await db.withOrg(org.orgId, (tx) =>
      changeMemberRole(tx, { actorMemberId: owner, targetMemberId: target, role: "member" }),
    );
    expect(await auditOf(org.orgId, "member.role_changed")).toEqual([
      {
        actor_type: "user",
        actor_id: owner,
        target_id: target,
        metadata: { from: "member", to: "admin" },
      },
      {
        actor_type: "user",
        actor_id: owner,
        target_id: target,
        metadata: { from: "admin", to: "member" },
      },
    ]);
  });

  it("never makes or unmakes an owner: owner is not assignable, and an owner target is refused", async () => {
    const target = await addMember(org);
    for (const role of ["owner", "Owner", "root", null, 1]) {
      await expect(
        db.withOrg(org.orgId, (tx) =>
          changeMemberRole(tx, { actorMemberId: owner, targetMemberId: target, role }),
        ),
      ).rejects.toBeInstanceOf(MemberStoreError);
    }
    // The last owner demoting themselves (or anyone demoting an owner) is refused.
    expect(
      await db.withOrg(org.orgId, (tx) =>
        changeMemberRole(tx, { actorMemberId: owner, targetMemberId: owner, role: "admin" }),
      ),
    ).toEqual({ outcome: "target_is_owner" });
    expect((await roleOf(org, owner))?.role).toBe("owner");
  });

  it("does not find a removed member or another org's member (RLS)", async () => {
    const removed = await addMember(org);
    await db.withOrg(org.orgId, (tx) =>
      removeMember(tx, { actorMemberId: owner, targetMemberId: removed }),
    );
    for (const target of [removed, B.memberId, A.memberId]) {
      expect(
        await db.withOrg(org.orgId, (tx) =>
          changeMemberRole(tx, { actorMemberId: owner, targetMemberId: target, role: "admin" }),
        ),
      ).toEqual({ outcome: "not_found" });
    }
    expect((await roleOf(B, B.memberId))?.role).toBe("admin");
  });

  it("refuses ids that are not uuids before any SQL", async () => {
    await expect(
      db.withOrg(org.orgId, (tx) =>
        changeMemberRole(tx, {
          actorMemberId: owner,
          targetMemberId: "x' or 1=1 --",
          role: "admin",
        }),
      ),
    ).rejects.toThrow(/member id must be a uuid/);
  });
});

describe("removal and re-adding (removeMember, restoreMember)", () => {
  it("removes durably, deletes the token, cuts every live session, audits; sign-in does not revive", async () => {
    const org = await freshOrg();
    const admin = await addMember(org, "admin");
    const target = await addMember(org);
    const forgeUserId = await forgeIdOf(org, target);
    await db.withOrg(org.orgId, (tx) => storeForgeToken(tx, target, CIPHERTEXT, 1));
    await sessionFor(org, target, forgeUserId);
    await sessionFor(org, target, forgeUserId);
    expect(await linksOf(target)).toBe(2);
    expect(
      await db.withOrg(org.orgId, (tx) =>
        removeMember(tx, { actorMemberId: admin, targetMemberId: target }),
      ),
    ).toEqual({ outcome: "removed", sessionsCut: 2 });
    expect(await linksOf(target)).toBe(0);
    expect(await db.withOrg(org.orgId, (tx) => loadForgeToken(tx, target))).toBeNull();
    expect(await roleOf(org, target)).toEqual({ role: "member", removed: true });
    expect(
      await db.withOrg(org.orgId, (tx) => loadSessionMember(tx, { memberId: target, forgeUserId })),
    ).toBeNull();
    expect(
      await db.withOrg(org.orgId, (tx) => upsertLoginMember(tx, { forgeUserId, login: "back" })),
    ).toBeNull();
    expect(await auditOf(org.orgId, "member.removed")).toEqual([
      {
        actor_type: "user",
        actor_id: admin,
        target_id: target,
        metadata: { role: "member", sessionsCut: 2 },
      },
    ]);
    expect(
      await db.withOrg(org.orgId, (tx) =>
        removeMember(tx, { actorMemberId: admin, targetMemberId: target }),
      ),
    ).toEqual({ outcome: "already_removed" });
  });

  it("never removes an owner or oneself, nor another org's member", async () => {
    const org = await freshOrg();
    const owner = await addMember(org, "owner");
    const admin = await addMember(org, "admin");
    expect(
      await db.withOrg(org.orgId, (tx) =>
        removeMember(tx, { actorMemberId: admin, targetMemberId: owner }),
      ),
    ).toEqual({ outcome: "target_is_owner" });
    expect(
      await db.withOrg(org.orgId, (tx) =>
        removeMember(tx, { actorMemberId: admin, targetMemberId: admin }),
      ),
    ).toEqual({ outcome: "self" });
    expect(
      await db.withOrg(org.orgId, (tx) =>
        removeMember(tx, { actorMemberId: admin, targetMemberId: B.memberId }),
      ),
    ).toEqual({ outcome: "not_found" });
    expect(await roleOf(B, B.memberId)).toEqual({ role: "admin", removed: false });
  });

  it("re-adds a removed member as a plain member, audited; their next sign-in works again", async () => {
    const org = await freshOrg();
    const admin = await addMember(org, "admin");
    const target = await addMember(org, "admin");
    const forgeUserId = await forgeIdOf(org, target);
    await db.withOrg(org.orgId, (tx) =>
      removeMember(tx, { actorMemberId: admin, targetMemberId: target }),
    );
    expect(
      await db.withOrg(org.orgId, (tx) =>
        restoreMember(tx, { actorMemberId: admin, targetMemberId: target }),
      ),
    ).toEqual({ outcome: "restored" });
    expect(await roleOf(org, target)).toEqual({ role: "member", removed: false });
    expect(
      await db.withOrg(org.orgId, (tx) => upsertLoginMember(tx, { forgeUserId, login: "back" })),
    ).toEqual({ memberId: target });
    expect(
      await db.withOrg(org.orgId, (tx) =>
        restoreMember(tx, { actorMemberId: admin, targetMemberId: target }),
      ),
    ).toEqual({ outcome: "not_removed" });
    expect(
      await db.withOrg(org.orgId, (tx) =>
        restoreMember(tx, { actorMemberId: admin, targetMemberId: B.memberId }),
      ),
    ).toEqual({ outcome: "not_found" });
    expect(await auditOf(org.orgId, "member.restored")).toHaveLength(1);
  });
});

describe("ownership transfer (transferOwnership)", () => {
  it("moves ownership in one step: the target owns, the old owner is an admin, audited", async () => {
    const org = await freshOrg();
    const owner = await addMember(org, "owner");
    const target = await addMember(org);
    expect(
      await db.withOrg(org.orgId, (tx) =>
        transferOwnership(tx, { actorMemberId: owner, targetMemberId: target }),
      ),
    ).toEqual({ outcome: "transferred" });
    expect((await roleOf(org, target))?.role).toBe("owner");
    expect((await roleOf(org, owner))?.role).toBe("admin");
    expect(await auditOf(org.orgId, "org.ownership_transferred")).toEqual([
      {
        actor_type: "user",
        actor_id: owner,
        target_id: target,
        metadata: { previousRole: "member" },
      },
    ]);
    // The old owner can no longer transfer (re-checked with the rows locked).
    expect(
      await db.withOrg(org.orgId, (tx) =>
        transferOwnership(tx, { actorMemberId: owner, targetMemberId: target }),
      ),
    ).toEqual({ outcome: "not_owner" });
  });

  it("refuses oneself, a removed member and another org's member", async () => {
    const org = await freshOrg();
    const owner = await addMember(org, "owner");
    const gone = await addMember(org);
    await db.withOrg(org.orgId, (tx) =>
      removeMember(tx, { actorMemberId: owner, targetMemberId: gone }),
    );
    expect(
      await db.withOrg(org.orgId, (tx) =>
        transferOwnership(tx, { actorMemberId: owner, targetMemberId: owner }),
      ),
    ).toEqual({ outcome: "self" });
    for (const target of [gone, B.memberId]) {
      expect(
        await db.withOrg(org.orgId, (tx) =>
          transferOwnership(tx, { actorMemberId: owner, targetMemberId: target }),
        ),
      ).toEqual({ outcome: "not_found" });
    }
    expect((await roleOf(org, owner))?.role).toBe("owner");
  });

  it("two concurrent transfers by the same owner: one wins, the org has exactly one owner", async () => {
    const org = await freshOrg();
    const owner = await addMember(org, "owner");
    const [x, y] = [await addMember(org), await addMember(org)];
    const results = await Promise.all(
      [x, y].map((target) =>
        db.withOrg(org.orgId, (tx) =>
          transferOwnership(tx, { actorMemberId: owner, targetMemberId: target }),
        ),
      ),
    );
    expect(results.map((r) => r.outcome).toSorted()).toEqual(["not_owner", "transferred"]);
    const owners = await db.withOrg(org.orgId, (tx) =>
      tx.query("select 1 from members where role = 'owner'"),
    );
    expect(owners.rowCount).toBe(1);
  });
});

describe("leaving the GitHub organization (memberLeftForge)", () => {
  it("deletes the token and cuts the sessions, keeps the row and role, audits the forge as actor", async () => {
    const org = await freshOrg();
    const target = await addMember(org, "admin");
    const forgeUserId = await forgeIdOf(org, target);
    await db.withOrg(org.orgId, (tx) => storeForgeToken(tx, target, CIPHERTEXT, 1));
    await sessionFor(org, target, forgeUserId);
    expect(
      await db.withOrg(org.orgId, (tx) =>
        memberLeftForge(tx, { forgeUserId, source: "webhook", actorId: "delivery-1" }),
      ),
    ).toEqual({ memberId: target, sessionsCut: 1 });
    expect(await linksOf(target)).toBe(0);
    expect(await db.withOrg(org.orgId, (tx) => loadForgeToken(tx, target))).toBeNull();
    expect(await roleOf(org, target)).toEqual({ role: "admin", removed: false });
    expect(await auditOf(org.orgId, "member.left_forge")).toEqual([
      {
        actor_type: "forge",
        actor_id: "delivery-1",
        target_id: target,
        metadata: { source: "webhook", sessionsCut: 1 },
      },
    ]);
    // Signing in again (GitHub has them back) works: the row was never marked removed.
    expect(
      await db.withOrg(org.orgId, (tx) => upsertLoginMember(tx, { forgeUserId, login: "back" })),
    ).toEqual({ memberId: target });
  });

  it("touches only the transaction's org: the same person in another org keeps everything", async () => {
    const forgeUserId = 1001; // seedOrg's alice, in A and B
    await db.withOrg(B.orgId, (tx) => storeForgeToken(tx, B.memberId, CIPHERTEXT, 1));
    await sessionFor(B, B.memberId, forgeUserId);
    await db.withOrg(A.orgId, (tx) =>
      memberLeftForge(tx, { forgeUserId, source: "webhook", actorId: "delivery-2" }),
    );
    expect(await db.withOrg(B.orgId, (tx) => loadForgeToken(tx, B.memberId))).not.toBeNull();
    expect(await linksOf(B.memberId)).toBeGreaterThan(0);
  });

  it("is null for someone with no member row, and refuses a bad id or source", async () => {
    const org = await freshOrg();
    expect(
      await db.withOrg(org.orgId, (tx) =>
        memberLeftForge(tx, { forgeUserId: 987_654, source: "sign_in", actorId: "sign_in" }),
      ),
    ).toBeNull();
    for (const forgeUserId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        db.withOrg(org.orgId, (tx) =>
          memberLeftForge(tx, { forgeUserId, source: "webhook", actorId: "x" }),
        ),
      ).rejects.toBeInstanceOf(MemberStoreError);
    }
    await expect(
      db.withOrg(org.orgId, (tx) =>
        memberLeftForge(tx, { forgeUserId: 5, source: "other" as "webhook", actorId: "x" }),
      ),
    ).rejects.toBeInstanceOf(MemberStoreError);
  });

  it("the application can delete session links of the current tenant only", async () => {
    const before = await linksOf(B.memberId);
    expect(before).toBeGreaterThan(0);
    const deleted = await db.withOrg(A.orgId, (tx) =>
      tx.query("delete from app.session_orgs where member_id = $1", [B.memberId]),
    );
    expect(deleted.rowCount).toBe(0);
    expect(await linksOf(B.memberId)).toBe(before);
    // Outside withOrg there is no tenant: nothing matches.
    const bare = await pool.query("delete from app.session_orgs where member_id = $1", [
      B.memberId,
    ]);
    expect(bare.rowCount).toBe(0);
  });
});

describe("listing (listMembers)", () => {
  it("lists this org's members, owners first, removed last, without any token", async () => {
    const org = await freshOrg();
    const owner = await addMember(org, "owner");
    const gone = await addMember(org);
    await db.withOrg(org.orgId, (tx) => storeForgeToken(tx, owner, CIPHERTEXT, 1));
    await db.withOrg(org.orgId, (tx) =>
      removeMember(tx, { actorMemberId: owner, targetMemberId: gone }),
    );
    const listed = await db.withOrg(org.orgId, (tx) => listMembers(tx));
    expect(listed[0]).toMatchObject({ memberId: owner, role: "owner", removed: false });
    expect(listed.at(-1)).toMatchObject({ memberId: gone, removed: true });
    expect(listed.map((m) => m.memberId)).not.toContain(B.memberId);
    expect(JSON.stringify(listed)).not.toContain("rk1:");
    for (const m of listed) {
      expect(Object.keys(m).toSorted()).toEqual([
        "createdAt",
        "forgeUserId",
        "login",
        "memberId",
        "removed",
        "role",
      ]);
    }
  });
});
