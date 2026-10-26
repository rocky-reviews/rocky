import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLE, WORKER_ROLE, ensureLoginRole, scramSha256Verifier } from "./roles.js";
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
