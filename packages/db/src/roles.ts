import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type pg from "pg";

/** Group role the application connects through (migration 0001). NOLOGIN, NOBYPASSRLS. */
export const APP_ROLE = "rocky_app";
/** Owner of the retention purge functions (migration 0005). NOLOGIN, owns nothing else. */
export const RETENTION_ROLE = "rocky_retention";
/**
 * Group role of the worker (migration 0007), held by worker logins in addition to `rocky_app`:
 * creates orgs, claims inbox rows, runs the deletion sweep. The server's login never has it.
 */
export const WORKER_ROLE = "rocky_worker";
/** Owner of the SECURITY DEFINER functions in schema `worker` (migration 0007). NOLOGIN. */
export const LIFECYCLE_ROLE = "rocky_lifecycle";

const ROLE_NAME = /^[a-z][a-z0-9_]{2,62}$/;
const MIN_PASSWORD_LENGTH = 12;
/** Printable ASCII only, so no SASLprep normalisation is needed to match what clients send. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const SCRAM_ITERATIONS = 4096;

/**
 * Computes the SCRAM-SHA-256 verifier Postgres stores for a password (RFC 7677 / RFC 5802):
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`. Sending this instead of the
 * password keeps the plaintext out of statement text and server logs.
 */
export const scramSha256Verifier = (
  password: string,
  options: { salt?: Buffer; iterations?: number } = {},
): string => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!PRINTABLE_ASCII.test(password)) {
    throw new Error("password must be printable ASCII (SASLprep is not implemented)");
  }
  const salt = options.salt ?? randomBytes(16);
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
};

interface RoleState {
  privileged: boolean;
  groups: string[];
}

const roleState = async (client: pg.PoolClient, name: string): Promise<RoleState | undefined> => {
  const { rows } = await client.query<RoleState>(
    `select (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) as privileged,
            array(select m.roleid::regrole::text from pg_auth_members m where m.member = r.oid
                   order by 1) as groups
       from pg_roles r where rolname = $1`,
    [name],
  );
  return rows[0];
};

const groupsFor = (worker: boolean): readonly string[] =>
  worker ? [APP_ROLE, WORKER_ROLE] : [APP_ROLE];

const acceptable = (state: RoleState, allowed: readonly string[]): boolean =>
  !state.privileged && state.groups.every((g) => allowed.includes(g));

/**
 * Roles the server's login must not reach by any grant option: `pg_has_role(..., 'MEMBER')`
 * sees ADMIN-only and SET-only grants, which `USAGE` misses (review round 5). Since review round
 * 6 the reached set must be exactly `rocky_app`, which already excludes these; they are still
 * probed so a refusal names them.
 */
export const SERVER_FORBIDDEN_ROLES = [WORKER_ROLE, LIFECYCLE_ROLE, RETENTION_ROLE] as const;

/** Which check refused a server login. Names the check, never the login. */
export type ServerLoginRefusal =
  | `${"session_user" | "current_user"}:${"privileged" | "membership" | "admin_option" | "owner" | "forbidden_role"}`
  | "unexpected_answer";

/** One row per identity, as the check query answers it. */
interface LoginRow {
  who: unknown;
  privileged: unknown;
  groups: unknown;
  admin: unknown;
  owner: unknown;
  reaches: unknown;
}

/*
 * Every catalog object, function and type is qualified with pg_catalog (review round 6, N-1),
 * so a search_path (a startup option, or `alter role ... set`) cannot shadow what is read.
 * `reached` is every role other than the login that the login is a member of, by any path and
 * grant option (`pg_has_role(..., 'MEMBER')`): privileges are ORed across the login and that
 * whole set, and ownership is looked for across both (S-1, S-2). `public.orgs` stays named so a
 * database that is not migrated fails the check (42P01) instead of passing it.
 */
const SERVER_LOGIN_CHECK = `
  select v.who,
         (select pg_catalog.bool_or(x.rolsuper or x.rolbypassrls or x.rolcreaterole
                                    or x.rolcreatedb or x.rolreplication)
            from pg_catalog.pg_roles x
           where pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')) as privileged,
         array(
           select x.rolname::pg_catalog.text from pg_catalog.pg_roles x
            where x.oid operator(pg_catalog.<>) r.oid
              and pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
            order by 1) as groups,
         exists(select from pg_catalog.pg_auth_members m
                 where m.member operator(pg_catalog.=) r.oid and m.admin_option) as admin,
         (pg_catalog.pg_has_role(r.oid, d.datdba, 'MEMBER')
            or pg_catalog.pg_has_role(r.oid, c.relowner, 'MEMBER')
            or exists(select from pg_catalog.pg_shdepend s
                       where s.dbid operator(pg_catalog.=) d.oid
                         and s.deptype operator(pg_catalog.=) 'o'
                         and s.refclassid operator(pg_catalog.=) 'pg_catalog.pg_authid'::pg_catalog.regclass
                         and pg_catalog.pg_has_role(r.oid, s.refobjid, 'MEMBER'))) as owner,
         (select pg_catalog.bool_or(pg_catalog.pg_has_role(r.oid, g::pg_catalog.name, 'MEMBER'))
            from pg_catalog.unnest($1::pg_catalog.text[]) g) as reaches
    from (values ('session_user', session_user::pg_catalog.text),
                 ('current_user', current_user::pg_catalog.text)) v(who, name)
    left join pg_catalog.pg_roles r on r.rolname operator(pg_catalog.=) v.name
    cross join pg_catalog.pg_database d
    cross join pg_catalog.pg_class c
   where d.datname operator(pg_catalog.=) pg_catalog.current_database()
     and c.oid operator(pg_catalog.=) 'public.orgs'::pg_catalog.regclass
   order by 1 desc`;

const IDENTITIES = ["session_user", "current_user"] as const;

/**
 * Checks, on an open connection, that the internet-facing server holds `rocky_app`'s privileges
 * and nothing more (ADR 0009, L28). An allow-list, for both `session_user` and `current_user`
 * (a `role=` startup option makes them differ): the roles it reaches by any path and grant
 * option are exactly `rocky_app`; no privilege attribute on it or on any of them; no grant with
 * ADMIN OPTION; neither it nor any of them owns the database or any object in it; not a member
 * of any of SERVER_FORBIDDEN_ROLES. Anything but two well-formed rows refuses. Returns the
 * refusals (empty when acceptable); a query error propagates, and callers treat it as a refusal
 * too.
 */
export const checkServerLogin = async (
  client: Pick<pg.ClientBase, "query">,
): Promise<ServerLoginRefusal[]> => {
  const { rows } = await client.query<LoginRow>(SERVER_LOGIN_CHECK, [[...SERVER_FORBIDDEN_ROLES]]);
  if (!Array.isArray(rows) || rows.length !== IDENTITIES.length) return ["unexpected_answer"];
  const refusals: ServerLoginRefusal[] = [];
  for (const [i, who] of IDENTITIES.entries()) {
    const row = rows[i];
    if (
      row?.who !== who ||
      typeof row.privileged !== "boolean" ||
      typeof row.admin !== "boolean" ||
      typeof row.owner !== "boolean" ||
      typeof row.reaches !== "boolean" ||
      !Array.isArray(row.groups) ||
      !row.groups.every((g): g is string => typeof g === "string")
    ) {
      return ["unexpected_answer"];
    }
    if (row.privileged) refusals.push(`${who}:privileged`);
    if (row.groups.length !== 1 || row.groups[0] !== APP_ROLE) refusals.push(`${who}:membership`);
    if (row.admin) refusals.push(`${who}:admin_option`);
    if (row.owner) refusals.push(`${who}:owner`);
    if (row.reaches) refusals.push(`${who}:forbidden_role`);
  }
  return refusals;
};

/**
 * Creates or updates a LOGIN role that is a member of `rocky_app` and nothing else (or, with
 * `worker: true`, of `rocky_app` and `rocky_worker` and nothing else), with every privilege
 * attribute switched off. Used by the dev seed and the test harness; production roles
 * are usually provisioned by the platform, with the same shape.
 *
 * Runs as the migrator. A pre-existing role is inspected first: if it carries any privilege
 * attribute or any membership other than rocky_app, nothing is changed and an error is thrown
 * (a non-superuser migrator could not strip those attributes anyway). The password is sent as a
 * SCRAM-SHA-256 verifier, never in plaintext.
 */
export const ensureLoginRole = async (
  pool: pg.Pool,
  options: { name: string; password: string; worker?: boolean },
): Promise<void> => {
  const groups = groupsFor(options.worker === true);
  if (!ROLE_NAME.test(options.name)) {
    throw new Error("ensureLoginRole: name must be 3-63 lowercase letters, digits or _");
  }
  const verifier = scramSha256Verifier(options.password);
  const client = await pool.connect();
  try {
    const before = await roleState(client, options.name);
    if (before !== undefined && !acceptable(before, groups)) {
      throw new Error(
        `ensureLoginRole: ${options.name} already exists with privileges beyond membership of ${groups.join(", ")}; fix the role before using it`,
      );
    }
    const role = client.escapeIdentifier(options.name);
    if (before === undefined) await client.query(`create role ${role}`);
    await client.query(
      `alter role ${role} login inherit password ${client.escapeLiteral(verifier)}`,
    );
    for (const group of groups) {
      if (!(before?.groups.includes(group) ?? false)) {
        await client.query(`grant ${group} to ${role}`);
      }
    }
    const after = await roleState(client, options.name);
    if (
      after === undefined ||
      !acceptable(after, groups) ||
      !groups.every((g) => after.groups.includes(g))
    ) {
      throw new Error(
        `ensureLoginRole: ${options.name} did not end up as a plain member of ${groups.join(", ")}`,
      );
    }
  } finally {
    client.release();
  }
};
