/**
 * P10-1 (ADR 0043 S5): the migration step of the self-host compose file creates the server's
 * and the worker's login roles from `ROCKY_DB_*` variables, as the migrator, through
 * `ensureLoginRole` (ADR 0005). Against a real Postgres provisioned like production (a
 * non-superuser `CREATEROLE` owner, the revokes, the migrations).
 */
import {
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  startPostgres,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loginProvisioningFromEnv, provisionLogins } from "./provision-logins.js";

let pgs: TestPostgres;

const connectAs = async (name: string, password: string) => {
  const url = new URL(pgs.superUrl);
  url.username = name;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() }).on("error", ignoreIdleError);
  await client.connect();
  return client;
};

const roleFacts = async (name: string) => {
  const { rows } = await pgs.migrator.query<{
    login: boolean;
    bypass: boolean;
    superuser: boolean;
    createrole: boolean;
    groups: string[];
  }>(
    `select r.rolcanlogin as login, r.rolbypassrls as bypass, r.rolsuper as superuser,
            r.rolcreaterole as createrole,
            coalesce((select array_agg(g.rolname::text order by g.rolname)
                        from pg_auth_members m join pg_roles g on g.oid = m.roleid
                       where m.member = r.oid), '{}'::text[]) as groups
       from pg_roles r where r.rolname = $1`,
    [name],
  );
  return rows[0];
};

beforeAll(async () => {
  pgs = await startPostgres();
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pgs?.stop();
});

describe("loginProvisioningFromEnv", () => {
  const app = { ROCKY_DB_APP_USER: "rocky_app_user", ROCKY_DB_APP_PASSWORD: "a".repeat(32) };
  const worker = {
    ROCKY_DB_WORKER_USER: "rocky_worker_user",
    ROCKY_DB_WORKER_PASSWORD: "b".repeat(32),
  };

  it("is empty when nothing is set (a platform-provisioned database)", () => {
    expect(loginProvisioningFromEnv({})).toEqual([]);
    expect(loginProvisioningFromEnv({ ROCKY_DB_APP_USER: "", ROCKY_DB_APP_PASSWORD: "" })).toEqual(
      [],
    );
  });

  it("takes each pair, both or neither", () => {
    expect(loginProvisioningFromEnv({ ...app, ...worker })).toEqual([
      { name: "rocky_app_user", password: "a".repeat(32), worker: false },
      { name: "rocky_worker_user", password: "b".repeat(32), worker: true },
    ]);
    expect(loginProvisioningFromEnv(worker)).toEqual([
      { name: "rocky_worker_user", password: "b".repeat(32), worker: true },
    ]);
    expect(() => loginProvisioningFromEnv({ ROCKY_DB_APP_USER: "rocky_app_user" })).toThrow(
      /ROCKY_DB_APP_USER and ROCKY_DB_APP_PASSWORD/,
    );
    expect(() => loginProvisioningFromEnv({ ROCKY_DB_WORKER_PASSWORD: "x".repeat(32) })).toThrow(
      /ROCKY_DB_WORKER_USER and ROCKY_DB_WORKER_PASSWORD/,
    );
  });

  it("refuses a short, non-ASCII or non-printable password and a bad or reserved name", () => {
    expect(() => loginProvisioningFromEnv({ ...app, ROCKY_DB_APP_PASSWORD: "short" })).toThrow(
      /ROCKY_DB_APP_PASSWORD/,
    );
    expect(() =>
      loginProvisioningFromEnv({ ...app, ROCKY_DB_APP_PASSWORD: "ü".repeat(32) }),
    ).toThrow(/ROCKY_DB_APP_PASSWORD/);
    expect(() =>
      loginProvisioningFromEnv({ ...app, ROCKY_DB_APP_PASSWORD: `${"a".repeat(31)}\n` }),
    ).toThrow(/ROCKY_DB_APP_PASSWORD/);
    expect(() => loginProvisioningFromEnv({ ...app, ROCKY_DB_APP_USER: "Rocky App" })).toThrow(
      /ROCKY_DB_APP_USER/,
    );
    for (const reserved of ["rocky_app", "rocky_worker", "rocky", "postgres", "rocky_retention"]) {
      expect(() => loginProvisioningFromEnv({ ...app, ROCKY_DB_APP_USER: reserved })).toThrow(
        /ROCKY_DB_APP_USER/,
      );
    }
    expect(() =>
      loginProvisioningFromEnv({ ...app, ...worker, ROCKY_DB_WORKER_USER: "rocky_app_user" }),
    ).toThrow(/same role/);
  });

  it("never puts the password in the error", () => {
    const password = "tooshort";
    let message = "";
    try {
      loginProvisioningFromEnv({ ...app, ROCKY_DB_APP_PASSWORD: password });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(password);
  });
});

describe("provisionLogins (migrator, real Postgres)", () => {
  const appPassword = "app-password-for-the-test-only-1";
  const workerPassword = "worker-password-for-the-test-only";

  it("creates both logins as plain members of their groups, and they can connect", async () => {
    await provisionLogins(pgs.migrator, [
      { name: "rocky_app_user", password: appPassword, worker: false },
      { name: "rocky_worker_user", password: workerPassword, worker: true },
    ]);
    expect(await roleFacts("rocky_app_user")).toEqual({
      login: true,
      bypass: false,
      superuser: false,
      createrole: false,
      groups: ["rocky_app"],
    });
    expect(await roleFacts("rocky_worker_user")).toEqual({
      login: true,
      bypass: false,
      superuser: false,
      createrole: false,
      groups: ["rocky_app", "rocky_worker"],
    });
    const app = await connectAs("rocky_app_user", appPassword);
    try {
      const { rows } = await app.query<{ worker: boolean }>(
        "select pg_has_role(current_user, 'rocky_worker', 'USAGE') as worker",
      );
      expect(rows[0]?.worker).toBe(false);
    } finally {
      await app.end();
    }
  });

  it("re-running rotates the password: the new one connects, the old one is refused", async () => {
    const rotated = "rotated-password-for-the-test-only";
    await provisionLogins(pgs.migrator, [
      { name: "rocky_app_user", password: rotated, worker: false },
    ]);
    const client = await connectAs("rocky_app_user", rotated);
    await client.end();
    await expect(connectAs("rocky_app_user", appPassword)).rejects.toMatchObject({
      code: "28P01",
    });
    expect((await roleFacts("rocky_app_user"))?.groups).toEqual(["rocky_app"]);
  });

  it("refuses a login that already carries a privilege, and changes nothing about it", async () => {
    const superuser = new pg.Client({ connectionString: pgs.superUrl }).on(
      "error",
      ignoreIdleError,
    );
    await superuser.connect();
    try {
      await superuser.query("create role planted_bypass login bypassrls password 'planted-pw'");
    } finally {
      await superuser.end();
    }
    await expect(
      provisionLogins(pgs.migrator, [
        { name: "planted_bypass", password: "x".repeat(32), worker: false },
      ]),
    ).rejects.toThrow(/planted_bypass/);
    expect(await roleFacts("planted_bypass")).toMatchObject({ bypass: true, groups: [] });
  });
});
