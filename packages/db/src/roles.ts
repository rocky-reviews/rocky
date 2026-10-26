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
