import type { ForgeKind, GitHubTokenKind, OrgId } from "@rocky-reviews/core";
import type pg from "pg";
import type { TenantTx } from "./client.js";
import { loadForgeToken, loadOrgDataKey, SecretStoreError, type StoredSecret } from "./secrets.js";

/**
 * The token connection (P10-4, migration 0024, ADR 0045): a self-hosted org reached through its
 * owner's personal access token. The org row says `connection = 'token'` and binds to the
 * owner's immutable GitHub user id (`account_id`); the owner is the org's one member, and the
 * token is stored exactly like a sign-in token (`members.forge_token_ciphertext`, envelope
 * encrypted, ADR 0020 §4), so the repository access check and posting as the user read it
 * unchanged. Nothing here sees a plaintext; what describes the token (its kind, when it was
 * saved) lives in `orgs.settings`, which the application role may write.
 *
 * Every function runs inside the caller's `withOrg` (RLS), except `tokenOrgOf`, the one
 * cross-tenant read: "which live token org is there?", ids only, through `auth.token_org`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const FORGES: readonly ForgeKind[] = ["github", "gitlab", "gitea"];
const TOKEN_KINDS: readonly GitHubTokenKind[] = ["fine_grained", "classic"];
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** The key under `orgs.settings` (jsonb) that describes the saved token. */
const SETTINGS_KEY = "token_connection";

export class TokenConnectionError extends Error {
  override readonly name = "TokenConnectionError";
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const fail = (message: string): never => {
  throw new TokenConnectionError(`token connection: ${message}`);
};

const assertUuid = (value: unknown, what: string): string =>
  typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : fail(`${what} must be a uuid`);
const assertForge = (value: unknown): ForgeKind =>
  FORGES.includes(value as ForgeKind) ? (value as ForgeKind) : fail("unknown forge");
const assertId = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fail(`${what} must be a positive integer`);
const assertDate = (value: unknown, what: string): Date =>
  value instanceof Date && Number.isFinite(value.getTime())
    ? value
    : fail(`${what} must be a date`);

const sqlState = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
};

/** Runs `run`; a database failure becomes a value-free `TokenConnectionError`. */
const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TokenConnectionError || error instanceof SecretStoreError) throw error;
    throw new TokenConnectionError("token connection: database error", sqlState(error));
  }
};

/** The one live token org of a forge, ids only (cross-tenant, `auth.token_org`). */
export const tokenOrgOf = async (
  pool: Pick<pg.Pool, "query">,
  forge: ForgeKind,
): Promise<{ orgId: OrgId; accountId: number } | null> => {
  assertForge(forge);
  const { rows } = await guarded(() =>
    pool.query<{ org_id: string; account_id: string }>(
      "select org_id, account_id::text from auth.token_org($1)",
      [forge],
    ),
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { orgId: row.org_id as OrgId, accountId: Number(row.account_id) };
};

/**
 * Creates the token org for `tx.orgId` (a fresh id the caller chose, as the worker does for an
 * installation): bound to the token owner's GitHub user id, a User account, no installation.
 * Through `auth.create_token_org`, the only way the application role can insert an org. A second
 * live org for the same account (token or App) is refused by the database (`23505`).
 */
export const createTokenOrg = async (
  tx: TenantTx,
  org: { readonly forge: ForgeKind; readonly accountId: number; readonly login: string },
): Promise<void> => {
  const forge = assertForge(org.forge);
  const accountId = assertId(org.accountId, "account id");
  if (typeof org.login !== "string" || !LOGIN.test(org.login)) fail("invalid login");
  const { rows } = await guarded(() =>
    tx.query<{ id: string }>("select auth.create_token_org($1, $2, $3) as id", [
      forge,
      accountId,
      org.login,
    ]),
  );
  if (rows[0]?.id !== tx.orgId) fail("org not created");
};

/**
 * The token org's display login, when its owner (`accountId`, the org's account) was renamed on
 * GitHub. Through `auth.refresh_token_org_login`: the current tenant's token org only. `true`
 * when it changed.
 */
export const refreshTokenOrgLogin = async (
  tx: TenantTx,
  owner: { readonly accountId: number; readonly login: string },
): Promise<boolean> => {
  const accountId = assertId(owner.accountId, "account id");
  if (typeof owner.login !== "string" || !LOGIN.test(owner.login)) fail("invalid login");
  const { rows } = await tx.query<{ changed: boolean }>(
    "select auth.refresh_token_org_login($1, $2) as changed",
    [accountId, owner.login],
  );
  return rows[0]?.changed === true;
};

/** What the server knows about the saved token without decrypting it. */
export interface TokenConnection {
  readonly memberId: string;
  readonly forgeUserId: number;
  /** The owner's login as GitHub last reported it (display only). */
  readonly login: string;
  /** From `orgs.settings`; `null` when no token was ever saved. */
  readonly tokenKind: GitHubTokenKind | null;
  readonly savedAt: Date | null;
  /** GitHub's expiry of the token (`members.forge_access_expires_at`). */
  readonly expiresAt: Date | null;
  /** The encrypted token; `null` when none is stored (removed, or never saved). */
  readonly token: StoredSecret | null;
  readonly dataKey: StoredSecret | null;
}

interface SettingsRow {
  settings: Record<string, unknown> | null;
  account_id: string;
  connection: string;
}

const describe = (settings: Record<string, unknown> | null) => {
  const raw = settings?.[SETTINGS_KEY];
  if (typeof raw !== "object" || raw === null) return { tokenKind: null, savedAt: null };
  const { kind, savedAt } = raw as Record<string, unknown>;
  const at = typeof savedAt === "string" ? new Date(savedAt) : null;
  return {
    tokenKind: TOKEN_KINDS.includes(kind as GitHubTokenKind) ? (kind as GitHubTokenKind) : null,
    savedAt: at !== null && Number.isFinite(at.getTime()) ? at : null,
  };
};

/**
 * The token connection of `tx.orgId`: the owner member (the one whose forge user id is the org's
 * account id, not removed) with its ciphertexts. `null` when the org is not a token org, or has
 * no such member yet. Never a plaintext.
 */
export const loadTokenConnection = async (tx: TenantTx): Promise<TokenConnection | null> => {
  const org = await guarded(() =>
    tx.query<SettingsRow>("select settings, account_id::text, connection from orgs where id = $1", [
      tx.orgId,
    ]),
  );
  const row = org.rows[0];
  if (row === undefined || row.connection !== "token") return null;
  const member = await guarded(() =>
    tx.query<{ id: string; login: string; forge_user_id: string; expires_at: Date | null }>(
      `select id, login, forge_user_id::text, forge_access_expires_at as expires_at
         from members
        where org_id = $1 and forge_user_id = $2 and removed_at is null
        order by created_at, id
        limit 1`,
      [tx.orgId, Number(row.account_id)],
    ),
  );
  const owner = member.rows[0];
  if (owner === undefined) return null;
  return {
    memberId: owner.id,
    forgeUserId: Number(owner.forge_user_id),
    login: owner.login,
    ...describe(row.settings),
    expiresAt: owner.expires_at,
    token: await loadForgeToken(tx, owner.id),
    dataKey: await loadOrgDataKey(tx),
  };
};

/** Records what describes a saved token (its kind, when); `null` forgets it (token removed). */
export const recordTokenConnection = async (
  tx: TenantTx,
  description: { readonly kind: GitHubTokenKind; readonly savedAt: Date } | null,
): Promise<void> => {
  let value: Record<string, unknown> | null = null;
  if (description !== null) {
    if (!TOKEN_KINDS.includes(description.kind)) fail("unknown token kind");
    value = {
      kind: description.kind,
      savedAt: assertDate(description.savedAt, "savedAt").toISOString(),
    };
  }
  const { rowCount } = await guarded(() =>
    tx.query(
      value === null
        ? "update orgs set settings = settings - $2, updated_at = now() where id = $1"
        : "update orgs set settings = settings || jsonb_build_object($2::text, $3::jsonb), updated_at = now() where id = $1",
      value === null ? [tx.orgId, SETTINGS_KEY] : [tx.orgId, SETTINGS_KEY, JSON.stringify(value)],
    ),
  );
  if (rowCount !== 1) fail("no such org");
};

/** A repository Rocky follows on the token, with what the connection page shows. */
export interface ConnectionRepositoryRow {
  readonly id: string;
  readonly forgeRepoId: number;
  readonly fullName: string;
  readonly private: boolean;
  readonly openPullRequests: number;
  readonly syncedAt: Date | null;
}

const MAX_LISTING = 1000;

/** Enabled repositories of the org, oldest first, with their open pull request counts. */
export const listConnectionRepositories = async (
  tx: TenantTx,
  options: { readonly limit: number },
): Promise<ConnectionRepositoryRow[]> => {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTING) fail("invalid limit");
  const { rows } = await guarded(() =>
    tx.query<{
      id: string;
      forge_repo_id: string;
      full_name: string;
      private: boolean;
      open: string;
      synced_at: Date | null;
    }>(
      `select r.id, r.forge_repo_id::text, r.full_name, r.private, r.synced_at,
              (select count(*) from pull_requests p
                where p.org_id = r.org_id and p.repo_id = r.id and p.state = 'open') as open
         from repos r
        where r.org_id = $1 and r.enabled
        order by r.created_at, r.id
        limit $2`,
      [tx.orgId, limit],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    forgeRepoId: Number(r.forge_repo_id),
    fullName: r.full_name,
    private: r.private,
    openPullRequests: Number(r.open),
    syncedAt: r.synced_at,
  }));
};

/** One enabled repository of the org by its row id, or `null` (another org's is absent: RLS). */
export const findConnectionRepository = async (
  tx: TenantTx,
  repoId: string,
): Promise<ConnectionRepositoryRow | null> => {
  const id = assertUuid(repoId, "repository id");
  const rows = await listConnectionRepositoriesById(tx, [id]);
  return rows[0] ?? null;
};

const listConnectionRepositoriesById = async (
  tx: TenantTx,
  ids: readonly string[],
): Promise<ConnectionRepositoryRow[]> => {
  const { rows } = await guarded(() =>
    tx.query<{
      id: string;
      forge_repo_id: string;
      full_name: string;
      private: boolean;
      open: string;
      synced_at: Date | null;
    }>(
      `select r.id, r.forge_repo_id::text, r.full_name, r.private, r.synced_at,
              (select count(*) from pull_requests p
                where p.org_id = r.org_id and p.repo_id = r.id and p.state = 'open') as open
         from repos r
        where r.org_id = $1 and r.enabled and r.id = any($2::uuid[])`,
      [tx.orgId, ids],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    forgeRepoId: Number(r.forge_repo_id),
    fullName: r.full_name,
    private: r.private,
    openPullRequests: Number(r.open),
    syncedAt: r.synced_at,
  }));
};

/** Stamps when the repository's pull requests were last read from the forge. */
export const markRepositorySynced = async (
  tx: TenantTx,
  repoId: string,
  at: Date,
): Promise<boolean> => {
  const id = assertUuid(repoId, "repository id");
  const when = assertDate(at, "at");
  const { rowCount } = await guarded(() =>
    tx.query("update repos set synced_at = $3, updated_at = now() where org_id = $1 and id = $2", [
      tx.orgId,
      id,
      when,
    ]),
  );
  return rowCount === 1;
};

/**
 * Stops following a repository (`enabled = false`): the inbox and the pages hide it; its rows
 * stay (a reviewer's drafts are theirs) and following it again re-enables the same row.
 */
export const disableRepository = async (tx: TenantTx, repoId: string): Promise<boolean> => {
  const id = assertUuid(repoId, "repository id");
  const { rowCount } = await guarded(() =>
    tx.query(
      "update repos set enabled = false, updated_at = now() where org_id = $1 and id = $2 and enabled",
      [tx.orgId, id],
    ),
  );
  return rowCount === 1;
};

/** Follows a repository again that was disabled; `false` when there is no such row. */
export const enableRepository = async (tx: TenantTx, repoId: string): Promise<boolean> => {
  const id = assertUuid(repoId, "repository id");
  const { rowCount } = await guarded(() =>
    tx.query("update repos set enabled = true, updated_at = now() where org_id = $1 and id = $2", [
      tx.orgId,
      id,
    ]),
  );
  return rowCount === 1;
};

/** The latest sync of any enabled repository of the org, or `null`. */
export const lastSyncedAt = async (tx: TenantTx): Promise<Date | null> => {
  const { rows } = await guarded(() =>
    tx.query<{ at: Date | null }>(
      "select max(synced_at) as at from repos where org_id = $1 and enabled",
      [tx.orgId],
    ),
  );
  return rows[0]?.at ?? null;
};
