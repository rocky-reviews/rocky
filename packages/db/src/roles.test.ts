import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ROLE,
  WORKER_ROLE,
  checkServerLogin,
  ensureLoginRole,
  scramSha256Verifier,
} from "./roles.js";
import { CONTAINER_TIMEOUT_MS, startPostgres } from "./testing/index.js";

/** Review #9: check before changing, and never send a plaintext password to the server. */

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let superuser: pg.Pool;

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await superuser?.end();
  await pgs?.stop();
});

const VERIFIER = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$/;

describe("scramSha256Verifier", () => {
  it("produces a Postgres SCRAM-SHA-256 verifier (iterations, salt, StoredKey, ServerKey)", () => {
    const salt = Buffer.from("0123456789abcdef");
    const v = scramSha256Verifier("correct horse battery", { salt });
    const match = VERIFIER.exec(v);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1]!, "base64")).toEqual(salt);
    expect(Buffer.from(match![2]!, "base64")).toHaveLength(32);
    expect(Buffer.from(match![3]!, "base64")).toHaveLength(32);
    // Deterministic for a fixed salt, different for another salt or password.
    expect(scramSha256Verifier("correct horse battery", { salt })).toBe(v);
    expect(scramSha256Verifier("correct horse battery", { salt: Buffer.alloc(16, 1) })).not.toBe(v);
    expect(scramSha256Verifier("correct horse batterz", { salt })).not.toBe(v);
    expect(scramSha256Verifier("correct horse battery")).not.toBe(v);
  });

  it("refuses passwords that would need SASLprep or are too weak", () => {
    expect(() => scramSha256Verifier("short")).toThrow(/at least/);
    expect(() => scramSha256Verifier("pässword-with-umlaut")).toThrow(/ASCII/);
    expect(() => scramSha256Verifier("tab\tinside-password")).toThrow(/ASCII/);
  });
});

describe("ensureLoginRole", () => {
  it("stores only a SCRAM verifier and the real password logs in", async () => {
    await ensureLoginRole(pgs.migrator, { name: "scram_login", password: "scram-login-secret" });
    const stored = await superuser.query<{ rolpassword: string }>(
      "select rolpassword from pg_authid where rolname = 'scram_login'",
    );
    expect(stored.rows[0]?.rolpassword).toMatch(VERIFIER);
    expect(stored.rows[0]?.rolpassword).not.toContain("scram-login-secret");

    const url = new URL(pgs.appUrl);
    url.username = "scram_login";
    url.password = "scram-login-secret";
    const ok = new pg.Client({ connectionString: url.toString() });
    await ok.connect();
    expect((await ok.query("select current_user as u")).rows[0]).toEqual({ u: "scram_login" });
    await ok.end();

    url.password = "wrong-password-value";
    const bad = new pg.Client({ connectionString: url.toString() });
    await expect(bad.connect()).rejects.toMatchObject({ code: "28P01" });
    await bad.end().catch(() => undefined);
  });

  it("checks a pre-existing role before altering it or granting membership", async () => {
    await superuser.query("create role pre_privileged login createdb");
    await expect(
      ensureLoginRole(pgs.migrator, { name: "pre_privileged", password: "pre-privileged-pw" }),
    ).rejects.toThrow(/privileges/);
    const after = await superuser.query<{ rolpassword: string | null; groups: string[] }>(
      `select a.rolpassword,
              array(select m.roleid::regrole::text from pg_auth_members m where m.member = a.oid) as groups
         from pg_authid a where a.rolname = 'pre_privileged'`,
    );
    expect(after.rows[0]).toEqual({ rolpassword: null, groups: [] });

    await superuser.query("create role pre_member login in role pg_read_all_data");
    await expect(
      ensureLoginRole(pgs.migrator, { name: "pre_member", password: "pre-member-pw-value" }),
    ).rejects.toThrow(/privileges/);
    const member = await superuser.query<{ groups: string[] }>(
      `select array(select m.roleid::regrole::text from pg_auth_members m where m.member = a.oid) as groups
         from pg_authid a where a.rolname = 'pre_member'`,
    );
    expect(member.rows[0]?.groups).toEqual(["pg_read_all_data"]);
    expect(member.rows[0]?.groups).not.toContain(APP_ROLE);
  });

  it("is idempotent for a role it created", async () => {
    await ensureLoginRole(pgs.migrator, { name: "again_login", password: "again-login-secret" });
    await ensureLoginRole(pgs.migrator, { name: "again_login", password: "again-login-rotated" });
    const url = new URL(pgs.appUrl);
    url.username = "again_login";
    url.password = "again-login-rotated";
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    await c.end();
  });

  it("makes a worker login a member of rocky_app and rocky_worker, and nothing else (P3-3)", async () => {
    await ensureLoginRole(pgs.migrator, {
      name: "worker_login",
      password: "worker-login-secret",
      worker: true,
    });
    const groupsOf = async (name: string) =>
      (
        await superuser.query<{ groups: string[] }>(
          `select array(select m.roleid::regrole::text from pg_auth_members m where m.member = a.oid
                         order by 1) as groups
             from pg_authid a where a.rolname = $1`,
          [name],
        )
      ).rows[0]?.groups;
    expect(await groupsOf("worker_login")).toEqual([APP_ROLE, WORKER_ROLE]);
    // Idempotent.
    await ensureLoginRole(pgs.migrator, {
      name: "worker_login",
      password: "worker-login-rotated",
      worker: true,
    });
    expect(await groupsOf("worker_login")).toEqual([APP_ROLE, WORKER_ROLE]);
    // A server login must never carry the worker role: asking for a plain app login on a role
    // that has it is refused and changes nothing.
    await expect(
      ensureLoginRole(pgs.migrator, { name: "worker_login", password: "worker-login-plain" }),
    ).rejects.toThrow(/privileges/);
    expect(await groupsOf("worker_login")).toEqual([APP_ROLE, WORKER_ROLE]);
    // A plain app login does not get the worker role.
    await ensureLoginRole(pgs.migrator, { name: "plain_login", password: "plain-login-secret" });
    expect(await groupsOf("plain_login")).toEqual([APP_ROLE]);
  });
});

/**
 * Review round 6: the server's login check against a real Postgres. Round 5 looked only at the
 * login's direct memberships and three forbidden roles, so anything granted to `rocky_app`
 * itself, or set on it, passed. Every case undoes its change in `finally` (roles are
 * cluster-wide), and ends by proving the application login is accepted again.
 */
describe("checkServerLogin (review round 6)", () => {
  const checkAs = async (url: string, options?: string) => {
    const target = new URL(url);
    if (options !== undefined) target.searchParams.set("options", options);
    const client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
    try {
      return await checkServerLogin(client);
    } finally {
      await client.end();
    }
  };
  const loginUrl = (name: string) => {
    const url = new URL(pgs.appUrl);
    url.username = name;
    url.password = `${name}-only-pw`;
    return url.toString();
  };
  const makeLogin = async (name: string, grant = `grant ${APP_ROLE} to %`) => {
    await superuser.query(`create role ${name} login password '${name}-only-pw'`);
    await superuser.query(grant.replaceAll("%", name));
    return loginUrl(name);
  };
  /** Runs `change`, checks the application login, and always runs `undo`. */
  const refusalsAfter = async (change: string[], undo: string[]) => {
    try {
      for (const sql of change) await superuser.query(sql);
      return await checkAs(pgs.appUrl);
    } finally {
      for (const sql of undo) await superuser.query(sql);
    }
  };

  afterEach(async () => {
    expect(await checkAs(pgs.appUrl)).toEqual([]);
  });

  it("accepts the plain application login", async () => {
    expect(await checkAs(pgs.appUrl)).toEqual([]);
  });

  it("S-1: refuses when rocky_app itself is granted pg_write_all_data", async () => {
    const refusals = await refusalsAfter(
      [`grant pg_write_all_data to ${APP_ROLE}`],
      [`revoke pg_write_all_data from ${APP_ROLE}`],
    );
    expect(refusals).toEqual(["session_user:membership", "current_user:membership"]);
  });

  it("S-1: refuses when rocky_app is granted another BYPASSRLS role", async () => {
    const refusals = await refusalsAfter(
      ["create role rocky_evil_test nologin bypassrls", `grant rocky_evil_test to ${APP_ROLE}`],
      [`revoke rocky_evil_test from ${APP_ROLE}`, "drop role rocky_evil_test"],
    );
    expect(refusals).toEqual([
      "session_user:privileged",
      "session_user:membership",
      "current_user:privileged",
      "current_user:membership",
    ]);
  });

  it("S-1: refuses when rocky_app is altered to BYPASSRLS CREATEROLE", async () => {
    const refusals = await refusalsAfter(
      [`alter role ${APP_ROLE} bypassrls createrole`],
      [`alter role ${APP_ROLE} nobypassrls nocreaterole`],
    );
    expect(refusals).toEqual(["session_user:privileged", "current_user:privileged"]);
  });

  it("S-2: refuses a plain login that owns a table other than public.orgs", async () => {
    const url = await makeLogin("rocky_table_owner_test");
    try {
      await superuser.query("create table public.round6_owned (id int)");
      await superuser.query("alter table public.round6_owned owner to rocky_table_owner_test");
      expect(await checkAs(url)).toEqual(["session_user:owner", "current_user:owner"]);
    } finally {
      await superuser.query("drop table if exists public.round6_owned");
    }
  });

  it("S-2: refuses when a role the login reaches (rocky_app) owns a function", async () => {
    const refusals = await refusalsAfter(
      [
        "create function public.round6_fn() returns int language sql as 'select 1'",
        `alter function public.round6_fn() owner to ${APP_ROLE}`,
      ],
      ["drop function if exists public.round6_fn()"],
    );
    expect(refusals).toEqual(["session_user:owner", "current_user:owner"]);
  });

  it("N-2: refuses a login whose rocky_app grant carries ADMIN OPTION", async () => {
    const url = await makeLogin(
      "rocky_admin_option_test",
      `grant ${APP_ROLE} to % with admin option`,
    );
    expect(await checkAs(url)).toEqual(["session_user:admin_option", "current_user:admin_option"]);
  });

  it("N-1: a search_path that shadows the catalog cannot hide a privilege attribute", async () => {
    const url = await makeLogin("rocky_shadowed_test");
    await superuser.query("alter role rocky_shadowed_test bypassrls");
    try {
      // A lying copy of every catalog view the check reads, searched before pg_catalog.
      await superuser.query("create schema round6_shadow");
      await superuser.query(
        `create view round6_shadow.pg_roles as
           select oid, rolname, false as rolsuper, false as rolbypassrls, false as rolcreaterole,
                  false as rolcreatedb, false as rolreplication
             from pg_catalog.pg_roles`,
      );
      await superuser.query(
        "create view round6_shadow.pg_auth_members as select * from pg_catalog.pg_auth_members where false",
      );
      await superuser.query(
        "create view round6_shadow.pg_shdepend as select * from pg_catalog.pg_shdepend where false",
      );
      await superuser.query("grant usage on schema round6_shadow to public");
      await superuser.query("grant select on all tables in schema round6_shadow to public");
      expect(await checkAs(url, "-c search_path=round6_shadow,pg_catalog")).toEqual([
        "session_user:privileged",
        "current_user:privileged",
      ]);
    } finally {
      await superuser.query("drop schema if exists round6_shadow cascade");
      await superuser.query("drop role rocky_shadowed_test");
    }
  });

  it("still refuses the worker and the migrator logins", async () => {
    expect(await checkAs(pgs.workerUrl)).toEqual(
      expect.arrayContaining(["session_user:membership", "session_user:forbidden_role"]),
    );
    expect(await checkAs(pgs.migratorUrl)).toEqual(
      expect.arrayContaining(["session_user:privileged", "session_user:owner"]),
    );
  });
});
