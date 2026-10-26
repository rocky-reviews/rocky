import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { migrate } from "../migrate.js";
import { ensureLoginRole } from "../roles.js";

/**
 * Integration tests run against the exact image `pnpm dev` uses. The compose file is the
 * single source of truth; a tag without a digest, or a different image, fails here.
 */
export const devPostgresImage = (): string => {
  const compose = readFileSync(
    new URL("../../../../docker-compose.dev.yml", import.meta.url),
    "utf8",
  );
  const match = /^\s*image:\s*(pgvector\/pgvector:[\w.-]+@sha256:[0-9a-f]{64})\s*$/m.exec(compose);
  if (match?.[1] === undefined) {
    throw new Error("docker-compose.dev.yml: pinned pgvector image (tag@sha256) not found");
  }
  return match[1];
};

/** Role names used by the harness. The group roles are created by the migrations. */
export const TEST_ROLES = {
  /** Owns the database and every table; runs migrations. CREATEROLE, not superuser. */
  migrator: "rocky_migrator",
  /** LOGIN member of `rocky_app`: what the server and worker connect as. */
  app: "rocky_app_test",
} as const;

// Test-only credentials for roles inside a throwaway container.
const PASSWORDS = { migrator: "migrator-test-only", app: "app-test-only" } as const;

/** Superuser-only statements every deployment runs before the first migration (keep in step with deploy/dev/init.sql). */
export const PROVISIONING_REVOKES: readonly string[] = [
  "REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC",
  "REVOKE USAGE ON LANGUAGE sql FROM PUBLIC",
  "REVOKE UPDATE ON pg_catalog.pg_settings FROM PUBLIC",
  `REVOKE EXECUTE ON FUNCTION
     pg_catalog.query_to_xml(text, boolean, boolean, text),
     pg_catalog.query_to_xmlschema(text, boolean, boolean, text),
     pg_catalog.query_to_xml_and_xmlschema(text, boolean, boolean, text),
     pg_catalog.ts_stat(text),
     pg_catalog.ts_stat(text, text),
     pg_catalog.ts_rewrite(tsquery, text)
   FROM PUBLIC`,
];

export interface TestPostgres {
  /** Superuser (`test`): only for provisioning (extensions, the migrator role). */
  readonly superUrl: string;
  /** Table owner, runs migrations. Subject to FORCE RLS like production owners. */
  readonly migratorUrl: string;
  /** The application role: RLS enforced, no bypass. */
  readonly appUrl: string;
  readonly migrator: pg.Pool;
  /**
   * `pg_dump --format=plain` of the whole database, run inside the container as the superuser
   * (what a backup or a leaked dump would hold). `inserts` switches COPY blocks for INSERT
   * statements, which escape text differently. The encryption-at-rest test greps the result.
   */
  dump(options?: DumpOptions): Promise<string>;
  stop(): Promise<void>;
}

export interface DumpOptions {
  readonly inserts?: boolean;
  /** pg_dump honours the session's `bytea_output`; `escape` writes octal instead of hex. */
  readonly byteaOutput?: "hex" | "escape";
}

const dumpDatabase = async (
  container: StartedPostgreSqlContainer,
  options: DumpOptions,
): Promise<string> => {
  const args = ["pg_dump", "--format=plain", "--no-owner", "--no-privileges"];
  if (options.inserts === true) args.push("--inserts");
  args.push("--username", container.getUsername(), container.getDatabase());
  // Inside the container pg_dump uses the unix socket; the password covers an image that
  // does not trust local connections. Test-only credentials of a throwaway container.
  const env: Record<string, string> = { PGPASSWORD: container.getPassword() };
  if (options.byteaOutput !== undefined) env.PGOPTIONS = `-c bytea_output=${options.byteaOutput}`;
  const result = await container.exec(args, { env });
  if (result.exitCode !== 0) {
    throw new Error(`pg_dump exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

const connectionUrl = (
  container: StartedPostgreSqlContainer,
  user: string,
  password: string,
): string => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  return url.toString();
};

/**
 * Starts a fresh Postgres, provisions it the way `deploy/dev/init.sql` does (extensions, a
 * non-superuser owner), optionally applies every migration as that owner and creates the
 * application login role. Each test file gets its own container.
 */
export const startPostgres = async (options: { migrate?: boolean } = {}): Promise<TestPostgres> => {
  const container = await new PostgreSqlContainer(devPostgresImage()).start();
  const superUrl = container.getConnectionUri();

  const superuser = new pg.Client({ connectionString: superUrl });
  await superuser.connect();
  try {
    await superuser.query("CREATE EXTENSION IF NOT EXISTS vector");
    await superuser.query(
      `CREATE ROLE ${TEST_ROLES.migrator} LOGIN CREATEROLE PASSWORD ${superuser.escapeLiteral(PASSWORDS.migrator)}`,
    );
    await superuser.query(
      `ALTER DATABASE ${superuser.escapeIdentifier(container.getDatabase())} OWNER TO ${TEST_ROLES.migrator}`,
    );
    // The same revokes as deploy/dev/init.sql (ADR 0005 §2, "Provisioning"); migration 0001
    // refuses to run without them. The migrator is not a superuser here, so it gets the two
    // languages back explicitly (migrations create sql functions and run DO blocks).
    for (const sql of PROVISIONING_REVOKES) await superuser.query(sql);
    await superuser.query(`GRANT USAGE ON LANGUAGE plpgsql, sql TO ${TEST_ROLES.migrator}`);
  } finally {
    await superuser.end();
  }

  const migratorUrl = connectionUrl(container, TEST_ROLES.migrator, PASSWORDS.migrator);
  const migrator = new pg.Pool({ connectionString: migratorUrl, max: 4 });
  if (options.migrate !== false) {
    await migrate(migrator);
    await ensureLoginRole(migrator, { name: TEST_ROLES.app, password: PASSWORDS.app });
  }

  return {
    superUrl,
    migratorUrl,
    appUrl: connectionUrl(container, TEST_ROLES.app, PASSWORDS.app),
    migrator,
    dump: (options = {}) => dumpDatabase(container, options),
    stop: async () => {
      await migrator.end();
      await container.stop();
    },
  };
};

/** Container start plus image pull can take a while on a cold machine or CI runner. */
export const CONTAINER_TIMEOUT_MS = 180_000;
