import {
  appliedMigrations,
  migrate,
  retentionFromEnv,
  rollback,
  setRetentionSettings,
} from "@rocky-reviews/db";
import pg from "pg";

/**
 * Applies pending SQL migrations as the table owner (DATABASE_ADMIN_URL, ADR 0005).
 *
 *   pnpm db:migrate            apply everything pending
 *   pnpm db:migrate down [n]   roll back the last n migrations (default 1)
 *   pnpm db:migrate status     list applied migrations
 */
const url = process.env["DATABASE_ADMIN_URL"];
if (url === undefined || url === "") {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example)");
  process.exit(2);
}

const [command = "up", arg] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  switch (command) {
    case "up": {
      const { applied } = await migrate(pool);
      console.log(
        applied.length === 0 ? "migrations: up to date" : `applied: ${applied.join(", ")}`,
      );
      // Retention periods are owner-managed settings (ADR 0005 §5): the deployment that runs
      // migrations also writes RETENTION_*_DAYS / ORG_DELETION_GRACE_DAYS (defaults when unset).
      const retention = retentionFromEnv(process.env);
      await setRetentionSettings(pool, retention);
      console.log(`retention settings: ${JSON.stringify(retention)}`);
      break;
    }
    case "down": {
      const steps = arg === undefined ? 1 : Number(arg);
      const { reverted } = await rollback(pool, { steps });
      console.log(`reverted: ${reverted.join(", ")}`);
      break;
    }
    case "status": {
      for (const m of await appliedMigrations(pool)) {
        console.log(`${m.name}\t${m.appliedAt.toISOString()}`);
      }
      break;
    }
    default:
      console.error(`unknown command: ${command} (use up | down [n] | status)`);
      process.exitCode = 2;
  }
} finally {
  await pool.end();
}
