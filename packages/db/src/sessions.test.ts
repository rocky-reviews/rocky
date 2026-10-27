import { createHash, randomBytes } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { scheduleOrgDeletion } from "./installations.js";
import { clearForgeToken, loadForgeToken, storeForgeToken } from "./secrets.js";
import {
  loadSessionMember,
  SESSION_PURGE_AFTER_MS,
  SessionStoreError,
  upsertLoginMember,
  type SessionStore,
} from "./sessions.js";
import { members } from "./schema.js";
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
 * P7-1 (migration 0013, ADR 0020): login attempts, users and sessions on a real Postgres as the
 * application role. What the database itself guarantees is tested here: only hashes stored,
 * single-use states, idle and absolute expiry, no revival, no extension, membership links that
 * follow member rows, and the cross-tenant org lookup's limits.
 */

const T0 = new Date("2026-10-27T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sha = (value: string) => createHash("sha256").update(value).digest();
const token = () => randomBytes(32).toString("base64url");

let pgs: TestPostgres;
let db: Db;
let store: SessionStore;
let appPool: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;
let C: SeededOrg;

beforeAll(async () => {
  pgs = await startPostgres();
  appPool = new pg.Pool({ connectionString: pgs.appUrl, max: 3 }).on("error", ignoreIdleError);
  db = createDb({ pool: appPool });
  store = db.sessions;
  [A, B, C] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 71 }),
    await seedOrg(w, newOrgId(), { installationId: 72 }),
    await seedOrg(w, newOrgId(), { installationId: 73 }),
  ]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await pgs?.stop();
});

const pgCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("expected the statement to fail");
};

const newSession = async (
  options: {
    forgeUserId?: number;
    orgs?: { orgId: OrgId; memberId: string }[];
    active?: OrgId | null;
    now?: Date;
    idle?: number;
    lifetimeMs?: number;
  } = {},
) => {
  const raw = token();
  const now = options.now ?? T0;
  const { userId } = await store.upsertUser("github", options.forgeUserId ?? 1001, now);
  const { sessionId } = await store.createSession({
    tokenSha256: sha(raw),
    userId,
    orgs: options.orgs ?? [{ orgId: A.orgId, memberId: A.memberId }],
    activeOrgId: options.active === undefined ? A.orgId : options.active,
    now,
    idleTimeoutSeconds: options.idle ?? 8 * 3600,
    expiresAt: new Date(now.getTime() + (options.lifetimeMs ?? 24 * HOUR)),
  });
  return { raw, sessionId, userId };
};

describe("login attempts (state)", () => {
  it("stores only sha256(state), and a state is consumed exactly once", async () => {
    const state = token();
    await store.createLoginAttempt({
      stateSha256: sha(state),
      returnTo: "/inbox?x=1",
      now: T0,
      ttlMs: 10 * MINUTE,
    });
    const dump = await pgs.dump();
    expect(dump).not.toContain(state);
    expect(await store.consumeLoginAttempt(sha(state), at(MINUTE))).toEqual({
      returnTo: "/inbox?x=1",
    });
    expect(await store.consumeLoginAttempt(sha(state), at(MINUTE))).toBeNull();
  });

  it("two concurrent consumptions of one state: exactly one wins", async () => {
    const state = token();
    await store.createLoginAttempt({
      stateSha256: sha(state),
      returnTo: "/",
      now: T0,
      ttlMs: MINUTE,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consumeLoginAttempt(sha(state), at(1000))),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("an expired state is refused and spent; a clock before its creation is refused", async () => {
    const late = token();
    await store.createLoginAttempt({
      stateSha256: sha(late),
      returnTo: "/",
      now: T0,
      ttlMs: MINUTE,
    });
    expect(await store.consumeLoginAttempt(sha(late), at(MINUTE))).toBeNull();
    expect(await store.consumeLoginAttempt(sha(late), at(1000))).toBeNull();
    const early = token();
    await store.createLoginAttempt({
      stateSha256: sha(early),
      returnTo: "/",
      now: T0,
      ttlMs: MINUTE,
    });
    expect(await store.consumeLoginAttempt(sha(early), at(-1))).toBeNull();
  });

  it("refuses bad input before SQL, and the database refuses what the store would never write", async () => {
    const base = { stateSha256: sha(token()), now: T0, ttlMs: MINUTE };
    for (const returnTo of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "/a b",
      "/a\nb",
      "x",
    ]) {
      await expect(store.createLoginAttempt({ ...base, returnTo })).rejects.toThrow(
        SessionStoreError,
      );
    }
    await expect(
      store.createLoginAttempt({ ...base, returnTo: "/", ttlMs: 16 * MINUTE }),
    ).rejects.toThrow(SessionStoreError);
    await expect(
      store.createLoginAttempt({ ...base, stateSha256: Buffer.alloc(31), returnTo: "/" }),
    ).rejects.toThrow(SessionStoreError);
    // Straight to the table as the app role: the CHECKs are the backstop.
    for (const returnTo of ["//evil.com", "/\\evil.com", "/a\tb", "https://evil.com"]) {
      expect(
        await pgCode(
          appPool.query(
            "insert into app.login_attempts values ($1, $2, now(), now() + interval '1 minute')",
            [sha(token()), returnTo],
          ),
        ),
        returnTo,
      ).toBe("23514");
    }
    expect(
      await pgCode(
        appPool.query(
          "insert into app.login_attempts values ($1, '/', now(), now() + interval '1 hour')",
          [sha(token())],
        ),
      ),
    ).toBe("23514");
    expect(
      await pgCode(
        appPool.query("update app.login_attempts set expires_at = now() + interval '1 day'"),
      ),
    ).toBe("42501");
  });
});

describe("sessions", () => {
  it("stores only sha256(token): neither the token nor anything derived from it but the hash", async () => {
    const { raw, sessionId } = await newSession();
    const dump = await pgs.dump();
    expect(dump).not.toContain(raw);
    expect(dump).toContain(sessionId);
    const live = await store.findSession(sha(raw), at(MINUTE));
    expect(live).toMatchObject({
      sessionId,
      forge: "github",
      forgeUserId: 1001,
      activeOrgId: A.orgId,
    });
    expect(live?.orgs).toEqual([{ orgId: A.orgId, memberId: A.memberId }]);
    // The raw token is not a key: only its hash finds the session.
    expect(await store.findSession(Buffer.from(raw.slice(0, 32)), at(MINUTE))).toBeNull();
  });

  it("idle expiry: unused for the idle timeout ends the session; activity keeps it alive", async () => {
    const { raw, sessionId } = await newSession({ idle: 3600 });
    expect(await store.findSession(sha(raw), at(HOUR - 1))).not.toBeNull();
    expect(await store.findSession(sha(raw), at(HOUR))).toBeNull();
    // Touching at 59 minutes moves the idle window.
    const other = await newSession({ idle: 3600 });
    await store.touchSession(other.sessionId, at(59 * MINUTE));
    expect(await store.findSession(sha(other.raw), at(HOUR + 30 * MINUTE))).not.toBeNull();
    expect(await store.findSession(sha(other.raw), at(2 * HOUR))).toBeNull();
    // Touches are throttled to one a minute.
    await store.touchSession(sessionId, at(30_000));
    const { rows } = await appPool.query<{ last_seen_at: Date }>(
      "select last_seen_at from app.sessions where id = $1",
      [sessionId],
    );
    expect(rows[0]?.last_seen_at.toISOString()).toBe(T0.toISOString());
  });

  it("absolute expiry: activity never extends a session past expires_at", async () => {
    const { raw, sessionId } = await newSession({ idle: 3600, lifetimeMs: 2 * HOUR });
    await store.touchSession(sessionId, at(HOUR));
    await store.touchSession(sessionId, at(2 * HOUR - MINUTE));
    expect(await store.findSession(sha(raw), at(2 * HOUR - 1))).not.toBeNull();
    expect(await store.findSession(sha(raw), at(2 * HOUR))).toBeNull();
    // A clock before the session's creation does not find it either.
    expect(await store.findSession(sha(raw), at(-1))).toBeNull();
  });

  it("the application role cannot extend, move or revive a session (column grants, policies, CHECKs)", async () => {
    const { raw, sessionId } = await newSession();
    for (const sql of [
      "update app.sessions set expires_at = expires_at + interval '1 day' where id = $1",
      "update app.sessions set idle_timeout_seconds = 86400 where id = $1",
      "update app.sessions set created_at = now() where id = $1",
      "update app.sessions set token_sha256 = sha256('x') where id = $1",
      "update app.sessions set user_id = gen_random_uuid() where id = $1",
    ]) {
      expect(await pgCode(appPool.query(sql, [sessionId])), sql).toBe("42501");
    }
    expect(await store.revokeSession(sessionId, "logout", at(MINUTE))).toMatchObject({ sessionId });
    expect(await store.findSession(sha(raw), at(2 * MINUTE))).toBeNull();
    // Revoked rows match no UPDATE policy: un-revoking changes nothing.
    const revive = await appPool.query(
      "update app.sessions set revoked_at = null, revoked_reason = null where id = $1",
      [sessionId],
    );
    expect(revive.rowCount).toBe(0);
    expect(await store.findSession(sha(raw), at(2 * MINUTE))).toBeNull();
    expect(await store.revokeSession(sessionId, "logout", at(3 * MINUTE))).toBeNull();
    // A lifetime over 7 days is refused by the store and by the database.
    await expect(newSession({ lifetimeMs: 8 * 24 * HOUR })).rejects.toThrow(SessionStoreError);
    const { userId } = await store.upsertUser("github", 1001, T0);
    expect(
      await pgCode(
        appPool.query(
          `insert into app.sessions (token_sha256, user_id, created_at, last_seen_at, idle_timeout_seconds, expires_at)
           values ($1, $2, now(), now(), 3600, now() + interval '8 days')`,
          [sha(token()), userId],
        ),
      ),
    ).toBe("23514");
    // Live sessions cannot be deleted by the application (only revoked).
    const live = await newSession();
    const deleted = await appPool.query("delete from app.sessions where id = $1", [live.sessionId]);
    expect(deleted.rowCount).toBe(0);
  });

  it("the active org must be one of the session's orgs; switching is refused otherwise", async () => {
    await expect(
      newSession({ orgs: [{ orgId: A.orgId, memberId: A.memberId }], active: B.orgId }),
    ).rejects.toThrow(SessionStoreError);
    const { raw, sessionId } = await newSession({
      orgs: [
        { orgId: A.orgId, memberId: A.memberId },
        { orgId: B.orgId, memberId: B.memberId },
      ],
      active: null,
    });
    expect((await store.findSession(sha(raw), T0))?.activeOrgId).toBeNull();
    expect(await store.setActiveOrg(sessionId, C.orgId)).toBe(false);
    expect(await store.setActiveOrg(sessionId, B.orgId)).toBe(true);
    expect((await store.findSession(sha(raw), T0))?.activeOrgId).toBe(B.orgId);
    // A member row of another org cannot be linked (composite FK).
    const { userId } = await store.upsertUser("github", 1001, T0);
    await expect(
      store.createSession({
        tokenSha256: sha(token()),
        userId,
        orgs: [{ orgId: A.orgId, memberId: B.memberId }],
        activeOrgId: null,
        now: T0,
        idleTimeoutSeconds: 3600,
        expiresAt: at(HOUR),
      }),
    ).rejects.toMatchObject({ name: "SessionStoreError", code: "23503" });
  });

  it("removing the member in Rocky removes the org from every session at once (cascade)", async () => {
    const extra = await db.withOrg(C.orgId, (tx) =>
      upsertLoginMember(tx, { forgeUserId: 5005, login: "erin" }),
    );
    const { raw } = await newSession({
      forgeUserId: 5005,
      orgs: [{ orgId: C.orgId, memberId: extra.memberId }],
      active: C.orgId,
    });
    expect((await store.findSession(sha(raw), T0))?.orgs).toHaveLength(1);
    await db.withOrg(C.orgId, async (tx) => {
      await tx.query("delete from members where id = $1", [extra.memberId]);
    });
    const after = await store.findSession(sha(raw), T0);
    expect(after?.orgs).toEqual([]);
    expect(after?.activeOrgId).toBeNull();
  });

  it("counts a user's other live sessions, and purges only sessions that ended a day ago", async () => {
    const one = await newSession({ forgeUserId: 6006, orgs: [], active: null });
    const two = await newSession({ forgeUserId: 6006, orgs: [], active: null });
    expect(await store.otherLiveSessions(one.userId, one.sessionId, at(MINUTE))).toBe(1);
    await store.revokeSession(two.sessionId, "logout", at(MINUTE));
    expect(await store.otherLiveSessions(one.userId, one.sessionId, at(2 * MINUTE))).toBe(0);
    const purged = await store.purgeEnded(at(MINUTE + SESSION_PURGE_AFTER_MS + 1));
    expect(purged.sessions).toBeGreaterThanOrEqual(1);
    const { rows } = await appPool.query("select id from app.sessions where id = $1", [
      two.sessionId,
    ]);
    expect(rows).toEqual([]);
  });

  it("refuses malformed input before any SQL", async () => {
    await expect(store.findSession(Buffer.alloc(8), T0)).rejects.toThrow(SessionStoreError);
    await expect(store.touchSession("not-a-uuid", T0)).rejects.toThrow(SessionStoreError);
    await expect(store.setActiveOrg("x", null)).rejects.toThrow(SessionStoreError);
    await expect(store.revokeSession(A.memberId, "nope" as "logout", T0)).rejects.toThrow(
      SessionStoreError,
    );
    await expect(store.upsertUser("github", 0, T0)).rejects.toThrow(SessionStoreError);
    await expect(store.upsertUser("bitbucket" as "github", 1, T0)).rejects.toThrow(
      SessionStoreError,
    );
    await expect(store.findSession(sha("x"), new Date(Number.NaN))).rejects.toThrow(
      SessionStoreError,
    );
    const { userId } = await store.upsertUser("github", 1001, T0);
    await expect(
      store.createSession({
        tokenSha256: sha(token()),
        userId,
        orgs: [],
        activeOrgId: null,
        now: T0,
        idleTimeoutSeconds: 30,
        expiresAt: at(HOUR),
      }),
    ).rejects.toThrow(SessionStoreError);
  });
});

describe("auth.login_orgs (the one cross-tenant read)", () => {
  it("returns only live orgs whose installation and account ids both match", async () => {
    const result = await store.loginOrgs("github", [
      { installationId: 71, accountId: 1_000_071 },
      { installationId: 72, accountId: 9 }, // wrong account: not B
      { installationId: 999, accountId: 1_000_999 },
    ]);
    expect(result).toEqual([{ orgId: A.orgId, installationId: 71 }]);
    expect(await store.loginOrgs("gitlab", [{ installationId: 71, accountId: 1_000_071 }])).toEqual(
      [],
    );
    expect(await store.loginOrgs("github", [])).toEqual([]);
  });

  it("does not offer an org scheduled for deletion", async () => {
    const D = await asWorker(pgs.workerUrl, async (w) => {
      const seeded = await seedOrg(w, newOrgId(), { installationId: 74 });
      await w.withOrg(seeded.orgId, (tx) => scheduleOrgDeletion(tx, 74));
      return seeded;
    });
    expect(await store.loginOrgs("github", [{ installationId: 74, accountId: 1_000_074 }])).toEqual(
      [],
    );
    // And its member is not a session member any more either.
    expect(
      await db.withOrg(D.orgId, (tx) =>
        loadSessionMember(tx, { memberId: D.memberId, forgeUserId: 1001 }),
      ),
    ).toBeNull();
  });

  it("is the only cross-tenant read of orgs the app role has: a direct select sees nothing", async () => {
    const direct = await appPool.query("select id from orgs where installation_id in (71, 72)");
    expect(direct.rows).toEqual([]);
    // The function's owner can read five columns and nothing else (no keys, no settings).
    expect(
      await pgCode(
        pgs.migrator.query("set role rocky_auth; select data_key_ciphertext from orgs; reset role"),
      ),
    ).toBe("42501");
    await pgs.migrator.query("reset role");
  });
});

describe("members at login (inside withOrg)", () => {
  it("creates a member with the default role and keeps an existing role; display login refreshed", async () => {
    const created = await db.withOrg(B.orgId, (tx) =>
      upsertLoginMember(tx, { forgeUserId: 7007, login: "frank" }),
    );
    const again = await db.withOrg(B.orgId, (tx) =>
      upsertLoginMember(tx, { forgeUserId: 7007, login: "frank-renamed" }),
    );
    expect(again.memberId).toBe(created.memberId);
    const seeded = await db.withOrg(A.orgId, (tx) =>
      upsertLoginMember(tx, { forgeUserId: 1001, login: "alice" }),
    );
    expect(seeded.memberId).toBe(A.memberId);
    const member = await db.withOrg(B.orgId, (tx) =>
      loadSessionMember(tx, { memberId: created.memberId, forgeUserId: 7007 }),
    );
    expect(member).toMatchObject({ login: "frank-renamed", role: "member", orgLogin: "org-72" });
    const admin = await db.withOrg(A.orgId, (tx) =>
      loadSessionMember(tx, { memberId: A.memberId, forgeUserId: 1001 }),
    );
    expect(admin?.role).toBe("admin");
    await expect(
      db.withOrg(B.orgId, (tx) => upsertLoginMember(tx, { forgeUserId: 7007, login: "bad login" })),
    ).rejects.toThrow(SessionStoreError);
  });

  it("a member is found only in its own org and only with its own forge user id", async () => {
    expect(
      await db.withOrg(B.orgId, (tx) =>
        loadSessionMember(tx, { memberId: A.memberId, forgeUserId: 1001 }),
      ),
    ).toBeNull();
    expect(
      await db.withOrg(A.orgId, (tx) =>
        loadSessionMember(tx, { memberId: A.memberId, forgeUserId: 9999 }),
      ),
    ).toBeNull();
  });

  it("stores the token's expiry with the ciphertext and clears both on logout", async () => {
    const ciphertext = `rk1:${Buffer.concat([Buffer.from([0, 0, 0, 1]), randomBytes(40)]).toString("base64url")}`;
    const expiresAt = at(8 * HOUR);
    await db.withOrg(A.orgId, (tx) =>
      storeForgeToken(tx, A.memberId, ciphertext, 1, { expiresAt }),
    );
    const row = await db.withOrg(A.orgId, async (tx) => {
      const [m] = await tx.db
        .select({ expires: members.forgeAccessExpiresAt })
        .from(members)
        .where(eqId(A.memberId));
      return m;
    });
    expect(row?.expires?.toISOString()).toBe(expiresAt.toISOString());
    await db.withOrg(A.orgId, (tx) => clearForgeToken(tx, A.memberId));
    expect(await db.withOrg(A.orgId, (tx) => loadForgeToken(tx, A.memberId))).toBeNull();
    await expect(db.withOrg(B.orgId, (tx) => clearForgeToken(tx, A.memberId))).rejects.toThrow(
      "no such member",
    );
    // An expiry without a token is refused by the database.
    expect(
      await pgCode(
        db.withOrg(A.orgId, (tx) =>
          tx.query("update members set forge_access_expires_at = now() where id = $1", [
            A.memberId,
          ]),
        ),
      ),
    ).toBe("23514");
  });
});

const eqId = (id: string) => eq(members.id, id);
