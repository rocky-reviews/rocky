import type pg from "pg";

/** Group role the application connects through (migration 0001). NOLOGIN, NOBYPASSRLS. */
export const APP_ROLE = "rocky_app";
/** Owner of the retention purge functions (migration 0005). NOLOGIN, owns nothing else. */
export const RETENTION_ROLE = "rocky_retention";

const ROLE_NAME = /^[a-z][a-z0-9_]{2,62}$/;
const MIN_PASSWORD_LENGTH = 12;

/**
 * Creates or updates a LOGIN role that is a member of `rocky_app` and nothing else, with every
 * privilege attribute switched off. Used by the dev seed and the test harness; production roles
 * are usually provisioned by the platform, with the same shape.
 *
 * Runs as the migrator. Postgres has no parameter binding for role statements, so the password
 * is escaped with the driver's literal escaper; keep `log_statement` below `all` on servers
 * where this runs, or the statement text (with the password) lands in the server log.
 */
export const ensureLoginRole = async (
  pool: pg.Pool,
  options: { name: string; password: string },
): Promise<void> => {
  if (!ROLE_NAME.test(options.name)) {
    throw new Error("ensureLoginRole: name must be 3-63 lowercase letters, digits or _");
  }
  if (options.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ensureLoginRole: password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const client = await pool.connect();
  try {
    const role = client.escapeIdentifier(options.name);
    const password = client.escapeLiteral(options.password);
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [options.name]);
    if (exists.rowCount === 0) await client.query(`create role ${role}`);
    // A non-superuser migrator cannot touch SUPERUSER/BYPASSRLS/REPLICATION attributes, even
    // to restate the default, so they are verified instead of asserted.
    await client.query(`alter role ${role} login inherit password ${password}`);
    await client.query(`grant ${APP_ROLE} to ${role}`);
    const { rows } = await client.query<{ bad: boolean; groups: string[] }>(
      `select (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) as bad,
              array(select m.roleid::regrole::text from pg_auth_members m where m.member = r.oid) as groups
         from pg_roles r where rolname = $1`,
      [options.name],
    );
    const role_ = rows[0];
    if (role_ === undefined || role_.bad || role_.groups.join(",") !== APP_ROLE) {
      throw new Error(
        `ensureLoginRole: ${options.name} has privileges beyond membership of ${APP_ROLE}; fix the role before using it`,
      );
    }
  } finally {
    client.release();
  }
};
