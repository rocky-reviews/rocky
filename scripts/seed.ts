import pg from "pg";

/**
 * Prepares the local database. Phase 2 adds migrations and fixture orgs/PRs (pr-847 from
 * design-poc); for now it checks the connection and the extensions the app relies on.
 */
const REQUIRED_EXTENSIONS = ["vector", "pgcrypto"];

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
try {
  const { rows } = await pool.query<{ extname: string }>("select extname from pg_extension");
  const installed = new Set(rows.map((row) => row.extname));
  const missing = REQUIRED_EXTENSIONS.filter((name) => !installed.has(name));
  if (missing.length > 0) {
    console.error(`missing extensions: ${missing.join(", ")} (recreate the dev volume)`);
    process.exitCode = 1;
  } else {
    console.log(`database ready, extensions: ${REQUIRED_EXTENSIONS.join(", ")}`);
  }
} finally {
  await pool.end();
}
