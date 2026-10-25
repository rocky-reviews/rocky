import { APP_ROLE, migrate } from "@rocky-reviews/db";
import pg from "pg";

/**
 * Prepares the local database: checks the extensions deploy/dev/init.sql installs, applies
 * pending migrations as the owner, and checks that the application role in DATABASE_URL is
 * what the server and worker expect (a member of rocky_app, no bypass). Fixture orgs/PRs
 * (pr-847 from design-poc) arrive with the GitHub mirror in Phase 3.
 */
const REQUIRED_EXTENSIONS = ["vector", "pgcrypto"];

const adminUrl = process.env["DATABASE_ADMIN_URL"];
const appUrl = process.env["DATABASE_URL"];
if (adminUrl === undefined || appUrl === undefined) {
  console.error("DATABASE_URL and DATABASE_ADMIN_URL must be set (see .env.example)");
  process.exit(2);
}

const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
try {
  const { rows } = await admin.query<{ extname: string }>("select extname from pg_extension");
  const installed = new Set(rows.map((row) => row.extname));
  const missing = REQUIRED_EXTENSIONS.filter((name) => !installed.has(name));
  if (missing.length > 0) {
    console.error(`missing extensions: ${missing.join(", ")} (recreate the dev volume)`);
    process.exit(1);
  }

  const { applied } = await migrate(admin);
  console.log(applied.length === 0 ? "migrations: up to date" : `applied: ${applied.join(", ")}`);

  const appUser = new URL(appUrl).username;
  const role = await admin.query<{ ok: boolean }>(
    `select (not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
             and pg_has_role(rolname, $2, 'MEMBER')) as ok
       from pg_roles where rolname = $1`,
    [appUser, APP_ROLE],
  );
  if (role.rows[0]?.ok !== true) {
    console.error(
      `role ${appUser} must exist, be a member of ${APP_ROLE} and have no bypass attributes (recreate the dev volume)`,
    );
    process.exit(1);
  }
  console.log(`database ready: extensions ${REQUIRED_EXTENSIONS.join(", ")}, app role ${appUser}`);
} finally {
  await admin.end();
}
