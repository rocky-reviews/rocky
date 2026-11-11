import { randomBytes } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import {
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  generateLocalKek,
  generateWrappedDataKey,
  LocalKeyWrapper,
  OrgKeyring,
} from "@rocky-reviews/crypto";
import { assertNoPlaintextLeaks, findPlaintextLeaks } from "@rocky-reviews/crypto/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { claimFirstOwner } from "./members.js";
import { upsertRepository } from "./mirror.js";
import { storeForgeToken, storeOrgDataKey } from "./secrets.js";
import { upsertLoginMember } from "./sessions.js";
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
import {
  createTokenOrg,
  refreshTokenOrgLogin,
  disableRepository,
  enableRepository,
  findConnectionRepository,
  lastSyncedAt,
  listConnectionRepositories,
  loadTokenConnection,
  markRepositorySynced,
  recordTokenConnection,
  TokenConnectionError,
  tokenOrgOf,
} from "./token-connection.js";

/**
 * P10-4 (ADR 0045, migration 0024) against a real Postgres, as the application login: the server
 * creates exactly a token org, the token org is a tenant like any other (RLS both ways), the
 * installation and login lookups never see it, and the token is stored only as ciphertext.
 */

const OWNER = { id: 7_001, login: "solo-dev" };
let pgs: TestPostgres;
/** The superuser sees every row (the migrator is under FORCE RLS like any owner). */
let superuser: pg.Pool;
let db: Db;
let appOrg: SeededOrg;
let tokenOrgId: OrgId;
let ownerMemberId: string;
const keys = new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]);
/** Assembled at runtime so no token-shaped literal exists in the source (as in the dump test). */
const TOKEN = ["github", "pat", `${"11AAAAAA".repeat(3)}_${randomBytes(30).toString("hex")}`].join(
  "_",
);

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  db = createDb({ connectionString: pgs.appUrl, max: 4 });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await superuser?.end();
  await db?.close();
  await pgs?.stop();
});

describe("creating the token org (as the application login)", () => {
  it("there is none before setup, and none is created outside a tenant transaction", async () => {
    expect(await db.tokenOrg("github")).toBeNull();
    // The function inserts for the current tenant only: no tenant, no row.
    const pool = new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on("error", ignoreIdleError);
    try {
      await expect(
        pool.query("select auth.create_token_org('github', 7002, 'other')"),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23502)$/) });
    } finally {
      await pool.end();
    }
    expect(
      await tokenOrgOf(
        new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on("error", ignoreIdleError),
        "github",
      ),
    ).toBeNull();
  });

  it("creates exactly a token org for the chosen tenant id, bound to the owner's account", async () => {
    tokenOrgId = newOrgId();
    await db.withOrg(tokenOrgId, (tx) =>
      createTokenOrg(tx, { forge: "github", accountId: OWNER.id, login: OWNER.login }),
    );
    const found = await db.tokenOrg("github");
    expect(found).toEqual({ orgId: tokenOrgId, accountId: OWNER.id });
    const { rows } = await superuser.query(
      "select connection, installation_id, account_id::text, kind, login from orgs where id = $1",
      [tokenOrgId],
    );
    expect(rows[0]).toEqual({
      connection: "token",
      installation_id: null,
      account_id: String(OWNER.id),
      kind: "user",
      login: OWNER.login,
    });
  });

  it("refuses a second token org, for the same or another account", async () => {
    for (const account of [OWNER, { id: 7_002, login: "someone-else" }]) {
      await expect(
        db.withOrg(newOrgId(), (tx) =>
          createTokenOrg(tx, { forge: "github", accountId: account.id, login: account.login }),
        ),
      ).rejects.toMatchObject({ name: "TokenConnectionError", message: /org not created/ });
    }
    expect(await db.tokenOrg("github")).toEqual({ orgId: tokenOrgId, accountId: OWNER.id });
  });

  it("refreshes the token org's display login when the owner's GitHub login changes, nothing else", async () => {
    const loginOf = async () =>
      (
        await superuser.query<{ login: string }>("select login from orgs where id = $1", [
          tokenOrgId,
        ])
      ).rows[0]?.login;
    expect(
      await db.withOrg(tokenOrgId, (tx) =>
        refreshTokenOrgLogin(tx, { accountId: OWNER.id, login: "solo-renamed" }),
      ),
    ).toBe(true);
    expect(await loginOf()).toBe("solo-renamed");
    // Another account's login, or the same login again: nothing changes.
    expect(
      await db.withOrg(tokenOrgId, (tx) =>
        refreshTokenOrgLogin(tx, { accountId: 9_999, login: "intruder" }),
      ),
    ).toBe(false);
    expect(
      await db.withOrg(tokenOrgId, (tx) =>
        refreshTokenOrgLogin(tx, { accountId: OWNER.id, login: "solo-renamed" }),
      ),
    ).toBe(false);
    // From another tenant: not this org.
    expect(
      await db.withOrg(newOrgId(), (tx) =>
        refreshTokenOrgLogin(tx, { accountId: OWNER.id, login: "elsewhere" }),
      ),
    ).toBe(false);
    await expect(
      db.withOrg(tokenOrgId, (tx) =>
        refreshTokenOrgLogin(tx, { accountId: OWNER.id, login: "x y" }),
      ),
    ).rejects.toThrow(/invalid login/);
    expect(await loginOf()).toBe("solo-renamed");
    await db.withOrg(tokenOrgId, (tx) =>
      refreshTokenOrgLogin(tx, { accountId: OWNER.id, login: OWNER.login }),
    );
    expect(await loginOf()).toBe(OWNER.login);
  });

  it("at most one live token org, even for two saves at once (a unique index, not only the check)", async () => {
    // A direct second insert, past the function's check (the race it would lose): refused.
    await asWorker(pgs.workerUrl, async (w) => {
      await expect(
        w.withOrg(newOrgId(), (tx) =>
          tx.query(
            "insert into orgs (id, connection, installation_id, account_id, login, kind) values ($1, 'token', null, 7_003, 'racer', 'user')",
            [tx.orgId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
    // Two saves at once: neither creates a second org; both are refused the usual way.
    const racers = await Promise.allSettled(
      [7_010, 7_011].map((id) =>
        db.withOrg(newOrgId(), (tx) =>
          createTokenOrg(tx, { forge: "github", accountId: id, login: `racer-${id}` }),
        ),
      ),
    );
    for (const r of racers) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/org not created/);
    }
  });

  it("the application login still cannot insert an org itself, nor an App-shaped one through the function", async () => {
    await expect(
      db.withOrg(newOrgId(), (tx) =>
        tx.query(
          "insert into orgs (id, connection, account_id, login, kind) values ($1, 'token', 7003, 'x', 'user')",
          [tx.orgId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Only token orgs come out of the function: the kind, the connection and the missing
    // installation are pinned by its body, and the database checks the pair.
    const { rows } = await superuser.query(
      "select count(*)::int as n from orgs where connection = 'token'",
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("validates its input before any SQL", async () => {
    for (const bad of [
      { forge: "svn", accountId: 1, login: "a" },
      { forge: "github", accountId: 0, login: "a" },
      { forge: "github", accountId: 1, login: "-bad" },
      { forge: "github", accountId: 1, login: "a".repeat(40) },
    ]) {
      await expect(
        db.withOrg(newOrgId(), (tx) => createTokenOrg(tx, bad as never)),
      ).rejects.toBeInstanceOf(TokenConnectionError);
    }
  });
});

describe("an instance connected through the App never gains a token org", () => {
  it("refuses one while any App org exists (Rocky Cloud), whatever the server asks", async () => {
    appOrg = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 91 }));
    // Without the token org (removed inside a transaction that is rolled back), the App org alone
    // still stops the function: it inserts nothing and answers NULL.
    const client = await superuser.connect();
    try {
      await client.query("begin");
      await client.query("delete from orgs where id = $1", [tokenOrgId]);
      await client.query("set local role rocky_app_test");
      const candidate = newOrgId();
      await client.query("select set_config('app.org_id', $1, true)", [candidate]);
      const { rows } = await client.query<{ id: string | null }>(
        "select auth.create_token_org('github', 7010, 'cloud-user') as id",
      );
      expect(rows[0]?.id).toBeNull();
      await client.query("reset role");
      const count = await client.query<{ n: number }>(
        "select count(*)::int as n from orgs where id = $1",
        [candidate],
      );
      expect(count.rows[0]?.n).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(await db.tokenOrg("github")).toEqual({ orgId: tokenOrgId, accountId: OWNER.id });
  });
});

describe("the database pins the shape", () => {
  it("a token org never carries an installation and an App org always does (CHECK), even for the worker", async () => {
    await asWorker(pgs.workerUrl, async (w) => {
      await expect(
        w.withOrg(newOrgId(), (tx) =>
          tx.query(
            "insert into orgs (id, connection, installation_id, account_id, login, kind) values ($1, 'token', 5, 7004, 'x', 'user')",
            [tx.orgId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        w.withOrg(newOrgId(), (tx) =>
          tx.query(
            "insert into orgs (id, connection, installation_id, account_id, login, kind) values ($1, 'app', null, 7005, 'x', 'organization')",
            [tx.orgId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        w.withOrg(newOrgId(), (tx) =>
          tx.query(
            "insert into orgs (id, connection, installation_id, account_id, login, kind) values ($1, 'token', null, 7006, 'x', 'organization')",
            [tx.orgId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("the connection kind is immutable, for the worker too", async () => {
    await asWorker(pgs.workerUrl, async (w) => {
      await expect(
        w.withOrg(tokenOrgId, (tx) =>
          tx.query("update orgs set connection = 'app', installation_id = 99 where id = $1", [
            tx.orgId,
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        w.withOrg(appOrg.orgId, (tx) =>
          tx.query("update orgs set connection = 'token', installation_id = null where id = $1", [
            tx.orgId,
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});

describe("the token org is a tenant like any other", () => {
  it("gets its owner member and the token as ciphertext under its own data key", async () => {
    expect(await db.withOrg(tokenOrgId, loadTokenConnection)).toBeNull();
    const wrapped = await generateWrappedDataKey(keys, tokenOrgId, 1);
    ownerMemberId = await db.withOrg(tokenOrgId, async (tx) => {
      const member = await upsertLoginMember(tx, { forgeUserId: OWNER.id, login: OWNER.login });
      if (member === null) throw new Error("no member");
      expect(await claimFirstOwner(tx, member.memberId)).toBe(true);
      await storeOrgDataKey(tx, encodeWrappedDataKey(wrapped), wrapped.version);
      return member.memberId;
    });
    const keyring = await OrgKeyring.open(keys, tokenOrgId, [wrapped]);
    const ciphertext = keyring.encrypt(TOKEN, { purpose: "github_token", recordId: ownerMemberId });
    keyring.destroy();
    const savedAt = new Date("2026-11-11T10:00:00Z");
    await db.withOrg(tokenOrgId, async (tx) => {
      await storeForgeToken(tx, ownerMemberId, ciphertext, 1, {
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      });
      await recordTokenConnection(tx, { kind: "fine_grained", savedAt });
    });
    const connection = await db.withOrg(tokenOrgId, loadTokenConnection);
    expect(connection).toMatchObject({
      memberId: ownerMemberId,
      forgeUserId: OWNER.id,
      login: OWNER.login,
      tokenKind: "fine_grained",
      savedAt,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    expect(connection?.token?.ciphertext.startsWith("rk1:")).toBe(true);
    expect(connection?.dataKey?.ciphertext.startsWith("rkw1:")).toBe(true);
    // The description never carries the token; the dump never carries it either.
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
    const dump = await pgs.dump();
    expect(findPlaintextLeaks(dump, [TOKEN])).toEqual([]);
    assertNoPlaintextLeaks(dump, [TOKEN]);
    // The decrypt path the access check and the poster use reads it back.
    const again = await OrgKeyring.open(keys, tokenOrgId, [
      decodeWrappedDataKey(connection!.dataKey!.ciphertext),
    ]);
    expect(
      again.decryptToString(connection!.token!.ciphertext, {
        purpose: "github_token",
        recordId: ownerMemberId,
      }),
    ).toBe(TOKEN);
    again.destroy();
  });

  it("forgetting the description and clearing the token leaves a connection without a token", async () => {
    await db.withOrg(tokenOrgId, (tx) => recordTokenConnection(tx, null));
    const connection = await db.withOrg(tokenOrgId, loadTokenConnection);
    expect(connection?.tokenKind).toBeNull();
    expect(connection?.savedAt).toBeNull();
    await db.withOrg(tokenOrgId, (tx) =>
      recordTokenConnection(tx, { kind: "classic", savedAt: new Date() }),
    );
    expect((await db.withOrg(tokenOrgId, loadTokenConnection))?.tokenKind).toBe("classic");
    await expect(
      db.withOrg(tokenOrgId, (tx) =>
        recordTokenConnection(tx, { kind: "oauth", savedAt: new Date() } as never),
      ),
    ).rejects.toBeInstanceOf(TokenConnectionError);
  });

  it("is isolated by RLS exactly like an App org, both ways", async () => {
    await db.withOrg(tokenOrgId, async (tx) => {
      await upsertRepository(tx, {
        id: 3001,
        fullName: `${OWNER.login}/notes`,
        private: true,
        defaultBranch: "main",
      });
    });
    // The App org sees none of the token org's rows, and the token org none of the App org's.
    const fromApp = await db.withOrg(appOrg.orgId, async (tx) => ({
      orgs: (await tx.query("select id from orgs")).rows,
      members: (await tx.query("select id from members where forge_user_id = $1", [OWNER.id])).rows,
      repos: (await tx.query("select id from repos where forge_repo_id = 3001")).rows,
      connection: await loadTokenConnection(tx),
    }));
    expect(fromApp.orgs).toEqual([{ id: appOrg.orgId }]);
    expect(fromApp.members).toEqual([]);
    expect(fromApp.repos).toEqual([]);
    expect(fromApp.connection).toBeNull();
    const fromToken = await db.withOrg(tokenOrgId, async (tx) => ({
      orgs: (await tx.query("select id from orgs")).rows,
      repos: (await tx.query("select id from repos")).rows.length,
      pulls: (await tx.query("select id from pull_requests")).rows,
      analyses: (await tx.query("select id from analyses")).rows,
      members: (await tx.query("select id from members")).rows,
    }));
    expect(fromToken.orgs).toEqual([{ id: tokenOrgId }]);
    expect(fromToken.repos).toBe(1);
    expect(fromToken.pulls).toEqual([]);
    expect(fromToken.analyses).toEqual([]);
    expect(fromToken.members).toEqual([{ id: ownerMemberId }]);
    // An update aimed at the other org's row changes nothing.
    const crossed = await db.withOrg(appOrg.orgId, (tx) =>
      tx.query("update members set login = 'pwned' where id = $1", [ownerMemberId]),
    );
    expect(crossed.rowCount).toBe(0);
    const crossedBack = await db.withOrg(tokenOrgId, (tx) =>
      tx.query("update repos set enabled = false where id = $1", [appOrg.repoId]),
    );
    expect(crossedBack.rowCount).toBe(0);
  });

  it("is never offered to a GitHub sign-in nor seen by the installation lifecycle", async () => {
    // auth.login_orgs matches installation ids GitHub lists for a user: a token org has none,
    // and the function keeps to App orgs besides.
    const offered = await db.sessions.loginOrgs("github", [
      { installationId: 91, accountId: appOrg.orgId === tokenOrgId ? 0 : 1_000_091 },
    ]);
    expect(offered.map((o) => o.orgId)).toEqual([appOrg.orgId]);
    // As the application login (the only role that may execute it): nothing by account id either,
    // whatever installation id a sign-in could claim.
    expect(
      await db.sessions.loginOrgs("github", [{ installationId: 1, accountId: OWNER.id }]),
    ).toEqual([]);
    await asWorker(pgs.workerUrl, async (w) => {
      // By the account id alone (a reinstall lookup) the token org still stays out of sight.
      expect(await w.installationOrgs("github", 1, OWNER.id)).toEqual([]);
      expect((await w.installationOrgs("github", 91, null)).map((o) => o.orgId)).toEqual([
        appOrg.orgId,
      ]);
    });
  });

  it("lists, stamps, stops and resumes following repositories inside the org only", async () => {
    const [repo] = await db.withOrg(tokenOrgId, (tx) =>
      listConnectionRepositories(tx, { limit: 50 }),
    );
    expect(repo).toMatchObject({
      forgeRepoId: 3001,
      fullName: `${OWNER.login}/notes`,
      private: true,
      openPullRequests: 0,
      syncedAt: null,
    });
    expect(await db.withOrg(tokenOrgId, lastSyncedAt)).toBeNull();
    const at = new Date("2026-11-11T11:00:00Z");
    expect(await db.withOrg(tokenOrgId, (tx) => markRepositorySynced(tx, repo!.id, at))).toBe(true);
    expect(await db.withOrg(tokenOrgId, lastSyncedAt)).toEqual(at);
    expect(
      (await db.withOrg(tokenOrgId, (tx) => findConnectionRepository(tx, repo!.id)))?.syncedAt,
    ).toEqual(at);
    // Another org's repository: absent (RLS), so nothing is stamped or disabled.
    expect(await db.withOrg(appOrg.orgId, (tx) => markRepositorySynced(tx, repo!.id, at))).toBe(
      false,
    );
    expect(await db.withOrg(appOrg.orgId, (tx) => disableRepository(tx, repo!.id))).toBe(false);
    expect(
      await db.withOrg(appOrg.orgId, (tx) => findConnectionRepository(tx, repo!.id)),
    ).toBeNull();
    expect(await db.withOrg(tokenOrgId, (tx) => disableRepository(tx, repo!.id))).toBe(true);
    expect(
      await db.withOrg(tokenOrgId, (tx) => listConnectionRepositories(tx, { limit: 50 })),
    ).toEqual([]);
    expect(await db.withOrg(tokenOrgId, (tx) => disableRepository(tx, repo!.id))).toBe(false);
    expect(await db.withOrg(tokenOrgId, (tx) => enableRepository(tx, repo!.id))).toBe(true);
    expect(
      (await db.withOrg(tokenOrgId, (tx) => listConnectionRepositories(tx, { limit: 50 }))).length,
    ).toBe(1);
    await expect(
      db.withOrg(tokenOrgId, (tx) => markRepositorySynced(tx, "not-a-uuid", at)),
    ).rejects.toBeInstanceOf(TokenConnectionError);
    await expect(
      db.withOrg(tokenOrgId, (tx) => listConnectionRepositories(tx, { limit: 0 })),
    ).rejects.toBeInstanceOf(TokenConnectionError);
  });

  it("an App org has no token connection", async () => {
    expect(await db.withOrg(appOrg.orgId, loadTokenConnection)).toBeNull();
  });
});
