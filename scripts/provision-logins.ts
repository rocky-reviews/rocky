import { APP_ROLE, ensureLoginRole, WORKER_ROLE } from "@rocky-reviews/db";
import type pg from "pg";

/**
 * Login roles for the server and the worker, provisioned by the migration step from the
 * environment (P10-1, ADR 0043 §2). `deploy/docker-compose.yml` sets the four variables on the
 * `migrate` service; a deployment whose platform provisions the roles leaves them unset.
 *
 *   ROCKY_DB_APP_USER / ROCKY_DB_APP_PASSWORD         a LOGIN member of rocky_app (the server)
 *   ROCKY_DB_WORKER_USER / ROCKY_DB_WORKER_PASSWORD   a member of rocky_app and rocky_worker
 *
 * Each pair is both or neither. The work is `ensureLoginRole` (ADR 0005): the password goes to
 * Postgres as a SCRAM-SHA-256 verifier, a pre-existing role with any privilege or any other
 * membership is refused untouched, and the result is verified. Re-running rotates passwords.
 * Errors name the variable, never its value.
 */

export interface LoginSpec {
  readonly name: string;
  readonly password: string;
  readonly worker: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

/** What `ensureLoginRole` accepts, checked here so the message can name the variable. */
const ROLE_NAME = /^[a-z0-9_]{3,63}$/;
/**
 * URL-safe characters only: the password goes into a connection URL unescaped, compose
 * interpolates `$` in deploy/.env, and quotes or spaces would need escaping somewhere. Plain
 * ASCII, so no SASLprep (ADR 0005); long enough to be generated (`openssl rand -hex 24`), not
 * typed. deploy/postgres-init.sh applies the same alphabet to the migrator's password.
 */
const PASSWORD = /^[A-Za-z0-9._~-]{16,256}$/;
/** Names the migrations, the provisioning or Postgres own; a login must never shadow them. */
const RESERVED = new Set([
  APP_ROLE,
  WORKER_ROLE,
  "rocky_retention",
  "rocky_lifecycle",
  "rocky_auth",
  "rocky",
  "postgres",
]);

const nonEmpty = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
};

const pair = (env: Env, prefix: string, worker: boolean): LoginSpec | undefined => {
  const userVar = `${prefix}_USER`;
  const passwordVar = `${prefix}_PASSWORD`;
  const name = nonEmpty(env, userVar);
  const password = nonEmpty(env, passwordVar);
  if (name === undefined && password === undefined) return undefined;
  if (name === undefined || password === undefined) {
    throw new Error(`${userVar} and ${passwordVar} must be set together (or neither)`);
  }
  if (!ROLE_NAME.test(name) || RESERVED.has(name)) {
    throw new Error(
      `${userVar} must be 3-63 lowercase letters, digits or _ and not a role Rocky manages`,
    );
  }
  if (!PASSWORD.test(password)) {
    throw new Error(
      `${passwordVar} must be 16-256 characters from A-Z a-z 0-9 . _ ~ - (openssl rand -hex 24)`,
    );
  }
  return { name, password, worker };
};

export const loginProvisioningFromEnv = (env: Env): LoginSpec[] => {
  const app = pair(env, "ROCKY_DB_APP", false);
  const worker = pair(env, "ROCKY_DB_WORKER", true);
  if (app !== undefined && worker !== undefined && app.name === worker.name) {
    throw new Error("ROCKY_DB_APP_USER and ROCKY_DB_WORKER_USER name the same role");
  }
  return [app, worker].filter((spec): spec is LoginSpec => spec !== undefined);
};

/** Runs as the migrator; each role is created or brought up to date in turn. */
export const provisionLogins = async (
  migrator: pg.Pool,
  specs: readonly LoginSpec[],
): Promise<void> => {
  for (const spec of specs) {
    await ensureLoginRole(migrator, {
      name: spec.name,
      password: spec.password,
      worker: spec.worker,
    });
  }
};
