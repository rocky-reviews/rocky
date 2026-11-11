import {
  ForgeReadError,
  MAX_AVAILABLE_REPOSITORIES,
  MAX_CONNECTION_REPOSITORIES,
  personalTokenKind,
  splitRepoFullName,
  tokenWarnings,
  type AddRepositoryRefusal,
  type AvailableRepositoriesResponse,
  type InboxSync,
  type ConnectionRepository,
  type ConnectionResponse,
  type ConnectionToken,
  type ForgeKind,
  type OrgId,
  type RepositorySession,
  type RepositorySyncReport,
  type SyncProblem,
  type SyncResponse,
  type TokenSaveRefusal,
} from "@rocky-reviews/core";
import {
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  generateWrappedDataKey,
  OrgKeyring,
  type KeyWrapper,
} from "@rocky-reviews/crypto";
import {
  audit,
  claimFirstOwner,
  clearForgeToken,
  createTokenOrg,
  disableRepository,
  enableRepository,
  findConnectionRepository,
  lastSyncedAt,
  listConnectionRepositories,
  loadOrgDataKey,
  loadTokenConnection,
  markRepositorySynced,
  recordTokenConnection,
  SecretStoreError,
  storeForgeToken,
  storeOrgDataKey,
  upsertLoginMember,
  upsertRepository,
  type ConnectionRepositoryRow,
  type Db,
  type StoredSecret,
} from "@rocky-reviews/db";
import type { GitHubTokenClient, TokenDenial } from "@rocky-reviews/forge-github";
import type { Logger } from "@rocky-reviews/log";
import { mirrorPullRequest, syncOpenPullRequests } from "@rocky-reviews/mirror";
import { randomUUID } from "node:crypto";
import { readMemberCredential } from "../member-token.js";
import { MEMBER_TOKEN_PURPOSE } from "../repository-access.js";

/**
 * The token connection (P10-4, ADR 0045): everything a self-hosted Rocky does with one person's
 * personal access token instead of the GitHub App. The token is validated with GitHub on save
 * (`GET /user`, then one listing as the permissions probe), stored like a sign-in token
 * (envelope-encrypted under the org's data key, purpose `github_token`, record id = the owner
 * member; ADR 0020 §4), and decrypted for one call at a time (`readMemberCredential`): never
 * returned by any API, never logged, never kept in memory between calls.
 *
 * The org is created on the first save (`createTokenOrg`, bound to the token owner's GitHub
 * user id); its only member is the owner. Repositories are followed on request (`addRepository`,
 * what the token can see) and their pull requests read on demand (`sync`: the shared mirror
 * sync, so analysis, drafts, memory and posting run unchanged). One sync at a time per org;
 * opening the inbox syncs at most every `syncOnOpenIntervalMs`; GitHub's rate limit stops a
 * sync with its reset time instead of being retried blindly.
 *
 * Every answer is fixed codes, counts, times and GitHub's own names. Logs carry ids, counts and
 * codes.
 */

/** Open pull requests read per repository per sync (newest first; older ones wait for the next). */
export const SYNC_PULL_REQUEST_LIMIT = 200;
/** How long opening the inbox waits for the sync it started before answering with `running`. */
export const SYNC_ON_OPEN_WAIT_MS = 4_000;
/** Opening the inbox or a pull request syncs at most this often. */
export const SYNC_ON_OPEN_INTERVAL_MS = 60_000;
/** Explicit syncs ("Sync" button) are accepted at most this often per org. */
export const SYNC_MIN_INTERVAL_MS = 5_000;

export interface TokenConnectionDeps {
  readonly db: Pick<Db, "withOrg" | "tokenOrg">;
  readonly keys: KeyWrapper;
  readonly client: GitHubTokenClient;
  readonly log: Pick<Logger, "info" | "warn">;
  readonly forge: Extract<ForgeKind, "github">;
  /** `ROCKY_ANALYSIS_AUTO=on`: every new open head a sync reads is queued for analysis. */
  readonly analysisAuto: boolean;
  readonly now?: () => number;
  readonly newOrgId?: () => OrgId;
  /** After a token is stored or cleared (ADR 0011 §6): the access check's `invalidateMember`. */
  readonly onMemberTokenChanged?: (orgId: OrgId, memberId: string) => void;
  readonly syncOnOpenIntervalMs?: number;
  readonly syncOnOpenWaitMs?: number;
  readonly syncLimit?: number;
}

export type SaveTokenResult =
  | { readonly ok: true; readonly orgId: OrgId; readonly token: ConnectionToken }
  | { readonly ok: false; readonly reason: TokenSaveRefusal; readonly retryAt?: Date };

export type AddRepositoryResult =
  | { readonly ok: true; readonly repository: ConnectionRepository; readonly sync: SyncResponse }
  | { readonly ok: false; readonly reason: AddRepositoryRefusal; readonly retryAt?: Date };

export type AvailableResult =
  | { readonly ok: true; readonly value: AvailableRepositoriesResponse }
  | { readonly ok: false; readonly reason: AddRepositoryRefusal; readonly retryAt?: Date };

export interface TokenConnectionService {
  /** Validates with GitHub, creates the org on the first save, stores the token encrypted. */
  saveToken(token: string): Promise<SaveTokenResult>;
  /** Deletes the stored token; the org and its data stay. `false` without a token. */
  removeToken(orgId: OrgId): Promise<boolean>;
  /** The connection page's data: the token described (never its value), the repositories. */
  describe(orgId: OrgId): Promise<ConnectionResponse | null>;
  /** The token's description alone (the setup wizard), or `null` without one. */
  describeToken(orgId: OrgId): Promise<ConnectionToken | null>;
  listAvailable(orgId: OrgId): Promise<AvailableResult>;
  addRepository(orgId: OrgId, forgeRepoId: number): Promise<AddRepositoryResult>;
  /** Stops following a repository (its rows stay). `false` when it is not followed. */
  removeRepository(orgId: OrgId, repoId: string): Promise<boolean>;
  /** Reads every followed repository's pull requests (or one repository's) from GitHub. */
  sync(
    orgId: OrgId,
    options?: { readonly repoId?: string; readonly force?: boolean },
  ): Promise<SyncResponse>;
  /**
   * The inbox's sync on open: at most once per interval, never two at once. Waits a few seconds
   * for it; a longer sync keeps running and the answer says `running`.
   */
  syncOnOpen(orgId: OrgId): Promise<InboxSync>;
  /** The pull request page's sync on open: one pull request, at most once per interval. */
  syncPullRequest(
    orgId: OrgId,
    target: { readonly forgeRepoId: number; readonly number: number },
  ): Promise<void>;
  /** A repository session on the org's token (the diff reader, ADR 0034); `null` when none. */
  openRepository(orgId: OrgId, forgeRepoId: number): Promise<RepositorySession | null>;
}

const denialToSave: Readonly<Record<TokenDenial, TokenSaveRefusal>> = {
  not_a_personal_token: "not_a_personal_token",
  token_rejected: "token_rejected",
  forbidden: "forbidden",
};

const denialToSync: Readonly<Record<TokenDenial, SyncProblem & AddRepositoryRefusal>> = {
  not_a_personal_token: "token_rejected",
  token_rejected: "token_rejected",
  forbidden: "forbidden",
};

/** A read failure as a sync problem: rate limits and GitHub's refusals by code, the rest "unavailable". */
const problemOf = (error: unknown): { problem: SyncProblem; retryAt?: Date } => {
  if (error instanceof ForgeReadError) {
    if (error.reason === "rate_limited") {
      return {
        problem: "rate_limited",
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      };
    }
    if (error.reason === "http_status" && error.status === 401)
      return { problem: "token_rejected" };
    if (error.reason === "http_status" && error.status === 403) return { problem: "forbidden" };
    return { problem: "forge_unavailable" };
  }
  return { problem: "failed" };
};

/** A refusal with a fixed reason and, for a rate limit, when to try again. */
type Refused<R extends string> = {
  readonly ok: false;
  readonly reason: R;
  readonly retryAt?: Date;
};

const toSaveRefusal = (error: unknown): Refused<TokenSaveRefusal> => {
  const { problem, retryAt } = problemOf(error);
  const reason: TokenSaveRefusal =
    problem === "rate_limited" || problem === "token_rejected" || problem === "forbidden"
      ? problem
      : "forge_unavailable";
  return { ok: false, reason, ...(retryAt === undefined ? {} : { retryAt }) };
};

const toAddRefusal = (error: unknown): Refused<AddRepositoryRefusal> => {
  const { problem, retryAt } = problemOf(error);
  const reason: AddRepositoryRefusal =
    problem === "rate_limited" || problem === "token_rejected" || problem === "forbidden"
      ? problem
      : "forge_unavailable";
  return { ok: false, reason, ...(retryAt === undefined ? {} : { retryAt }) };
};

const repositoryView = (row: ConnectionRepositoryRow): ConnectionRepository | null => {
  const names = splitRepoFullName(row.fullName);
  if (names === null) return null;
  return {
    id: row.id,
    forgeRepoId: row.forgeRepoId,
    owner: names.owner,
    name: names.name,
    private: row.private,
    openPullRequests: row.openPullRequests,
    lastSyncedAt: row.syncedAt === null ? null : row.syncedAt.toISOString(),
  };
};

export const createTokenConnectionService = (deps: TokenConnectionDeps): TokenConnectionService => {
  const { db, client } = deps;
  const now = deps.now ?? Date.now;
  const newOrgId = deps.newOrgId ?? (() => randomUUID() as OrgId);
  const onOpenInterval = deps.syncOnOpenIntervalMs ?? SYNC_ON_OPEN_INTERVAL_MS;
  const onOpenWait = deps.syncOnOpenWaitMs ?? SYNC_ON_OPEN_WAIT_MS;
  const syncLimit = deps.syncLimit ?? SYNC_PULL_REQUEST_LIMIT;
  /** Orgs with a sync in flight (one at a time per org). */
  const syncing = new Set<string>();
  /** Per org: when the last sync started (explicit or on open), for the throttles. */
  const lastSyncStartedAt = new Map<string, number>();
  /** Per org, repository and number: when the pull request page last synced it. */
  const lastPullSyncAt = new Map<string, number>();

  const log = (
    level: "info" | "warn",
    outcome: string,
    fields: Record<string, string | number | boolean | null> = {},
  ) => deps.log[level]({ connection: { outcome, ...fields } }, "token connection");

  const changed = (orgId: OrgId, memberId: string) => {
    try {
      deps.onMemberTokenChanged?.(orgId, memberId);
    } catch {
      // An observer failure never changes the outcome; the 5-minute bound still holds.
    }
  };

  const describeToken = async (orgId: OrgId): Promise<ConnectionToken | null> => {
    const connection = await db.withOrg(orgId, loadTokenConnection);
    if (connection === null || connection.token === null || connection.tokenKind === null) {
      return null;
    }
    const at = new Date(now());
    return {
      login: connection.login,
      forgeUserId: connection.forgeUserId,
      kind: connection.tokenKind,
      expiresAt: connection.expiresAt === null ? null : connection.expiresAt.toISOString(),
      savedAt: (connection.savedAt ?? at).toISOString(),
      warnings: tokenWarnings({ kind: connection.tokenKind, expiresAt: connection.expiresAt }, at),
    };
  };

  /** The org's data key, provisioned on first use (first writer wins, as at sign-in). */
  const dataKeyOf = async (orgId: OrgId): Promise<StoredSecret> => {
    const stored = await db.withOrg(orgId, (tx) => loadOrgDataKey(tx));
    if (stored !== null) return stored;
    const wrapped = await generateWrappedDataKey(deps.keys, orgId, 1);
    const text = encodeWrappedDataKey(wrapped);
    try {
      await db.withOrg(orgId, (tx) => storeOrgDataKey(tx, text, wrapped.version));
      return { ciphertext: text, keyVersion: wrapped.version };
    } catch (error) {
      if (!(error instanceof SecretStoreError)) throw error;
      const again = await db.withOrg(orgId, (tx) => loadOrgDataKey(tx));
      if (again === null) throw error;
      return again;
    }
  };

  const saveToken: TokenConnectionService["saveToken"] = async (token) => {
    const kind = personalTokenKind(token);
    if (kind === null) {
      log("info", "token_refused", { reason: "not_a_personal_token" });
      return { ok: false, reason: "not_a_personal_token" };
    }
    let identity;
    try {
      const read = await client.readUser(token);
      if (!read.ok) {
        log("info", "token_refused", { reason: read.reason });
        return { ok: false, reason: denialToSave[read.reason] };
      }
      identity = read.value;
      // A classic token reaches repositories only through `repo` (or `public_repo` for public
      // ones): without either it can read nothing Rocky needs.
      if (
        identity.kind === "classic" &&
        !identity.scopes.some((scope) => scope === "repo" || scope === "public_repo")
      ) {
        log("info", "token_refused", { reason: "missing_permissions" });
        return { ok: false, reason: "missing_permissions" };
      }
      // The permissions probe: the token must be able to list repositories (Metadata: read on
      // something, or nothing yet). What it cannot do shows up per repository when one is added.
      const probe = await client.listRepositories(token, { max: 1 });
      if (!probe.ok) {
        log("info", "token_refused", { reason: probe.reason, step: "probe" });
        return { ok: false, reason: denialToSave[probe.reason] };
      }
    } catch (error) {
      const refusal = toSaveRefusal(error);
      log("warn", "token_refused", {
        reason: refusal.ok ? "ok" : refusal.reason,
        errorCode: error instanceof ForgeReadError ? error.code : "error",
      });
      return refusal;
    }

    let orgId: OrgId;
    const existing = await db.tokenOrg(deps.forge);
    if (existing !== null) {
      // Replacing: the same person's token, or nothing (the org is bound to the owner's id).
      if (existing.accountId !== identity.id) {
        log("info", "token_refused", { reason: "token_user_mismatch", orgId: existing.orgId });
        return { ok: false, reason: "token_user_mismatch" };
      }
      orgId = existing.orgId;
    } else {
      orgId = newOrgId();
      await db.withOrg(orgId, (tx) =>
        createTokenOrg(tx, { forge: deps.forge, accountId: identity.id, login: identity.login }),
      );
      log("info", "org_created", { orgId });
    }
    const member = await db.withOrg(orgId, async (tx) => {
      const row = await upsertLoginMember(tx, { forgeUserId: identity.id, login: identity.login });
      if (row === null) return null;
      await claimFirstOwner(tx, row.memberId);
      return row;
    });
    if (member === null) {
      // The owner's member row was removed in Rocky: nothing to attach the token to.
      log("warn", "token_refused", { reason: "owner_removed", orgId });
      return { ok: false, reason: "forbidden" };
    }
    const dataKey = await dataKeyOf(orgId);
    // Outside any transaction: no transaction is held across a KMS call.
    const keyring = await OrgKeyring.open(deps.keys, orgId, [
      decodeWrappedDataKey(dataKey.ciphertext),
    ]);
    let ciphertext: string;
    let version: number;
    try {
      ciphertext = keyring.encrypt(token, {
        purpose: MEMBER_TOKEN_PURPOSE,
        recordId: member.memberId,
      });
      version = keyring.currentVersion;
    } finally {
      keyring.destroy();
    }
    const savedAt = new Date(now());
    await db.withOrg(orgId, async (tx) => {
      await storeForgeToken(tx, member.memberId, ciphertext, version, {
        expiresAt: identity.expiresAt,
      });
      await recordTokenConnection(tx, { kind, savedAt });
      await audit(
        tx,
        { type: "user", id: member.memberId },
        "connection.token_saved",
        { type: "member", id: member.memberId },
        { kind, expiresAt: identity.expiresAt?.toISOString() ?? null },
      );
    });
    changed(orgId, member.memberId);
    log("info", "token_saved", { orgId, memberId: member.memberId, kind });
    return {
      ok: true,
      orgId,
      token: {
        login: identity.login,
        forgeUserId: identity.id,
        kind,
        expiresAt: identity.expiresAt?.toISOString() ?? null,
        savedAt: savedAt.toISOString(),
        warnings: tokenWarnings({ kind, expiresAt: identity.expiresAt }, savedAt),
      },
    };
  };

  const removeToken: TokenConnectionService["removeToken"] = async (orgId) => {
    const removed = await db.withOrg(orgId, async (tx) => {
      const connection = await loadTokenConnection(tx);
      if (connection === null || connection.token === null) return null;
      await clearForgeToken(tx, connection.memberId);
      await recordTokenConnection(tx, null);
      await audit(tx, { type: "user", id: connection.memberId }, "connection.token_removed", {
        type: "member",
        id: connection.memberId,
      });
      return connection.memberId;
    });
    if (removed === null) return false;
    changed(orgId, removed);
    log("info", "token_removed", { orgId, memberId: removed });
    return true;
  };

  const describe: TokenConnectionService["describe"] = async (orgId) => {
    const connection = await db.withOrg(orgId, loadTokenConnection);
    if (connection === null) return null;
    const [token, rows, last] = await Promise.all([
      describeToken(orgId),
      db.withOrg(orgId, (tx) =>
        listConnectionRepositories(tx, { limit: MAX_CONNECTION_REPOSITORIES }),
      ),
      db.withOrg(orgId, lastSyncedAt),
    ]);
    return {
      connection: "token",
      token,
      repositories: rows.map(repositoryView).filter((r) => r !== null),
      lastSyncedAt: last === null ? null : last.toISOString(),
      analysisAuto: deps.analysisAuto,
    };
  };

  /** The org's token for one call, or the fixed reason there is none. */
  const credential = async (
    orgId: OrgId,
  ): Promise<{ ok: true; token: string } | { ok: false; problem: SyncProblem }> => {
    const connection = await db.withOrg(orgId, loadTokenConnection);
    if (connection === null) return { ok: false, problem: "no_token" };
    const read = await readMemberCredential(deps, orgId, connection.memberId, new Date(now()));
    if (!read.ok) {
      return {
        ok: false,
        problem: read.reason === "token_expired" ? "token_rejected" : "no_token",
      };
    }
    return { ok: true, token: read.credential.token };
  };

  const listAvailable: TokenConnectionService["listAvailable"] = async (orgId) => {
    const own = await credential(orgId);
    if (!own.ok) return { ok: false, reason: "no_token" };
    const followed = new Set(
      (
        await db.withOrg(orgId, (tx) =>
          listConnectionRepositories(tx, { limit: MAX_CONNECTION_REPOSITORIES }),
        )
      ).map((r) => r.forgeRepoId),
    );
    try {
      const listed = await client.listRepositories(own.token, { max: MAX_AVAILABLE_REPOSITORIES });
      if (!listed.ok) return { ok: false, reason: denialToSync[listed.reason] };
      const repositories = listed.value.repositories.flatMap((r) => {
        const names = splitRepoFullName(r.fullName);
        return names === null || !r.permissions.pull
          ? []
          : [
              {
                forgeRepoId: r.id,
                owner: names.owner,
                name: names.name,
                private: r.private,
                added: followed.has(r.id),
              },
            ];
      });
      log("info", "available_listed", { orgId, count: repositories.length });
      return { ok: true, value: { repositories, truncated: listed.value.truncated } };
    } catch (error) {
      log("warn", "available_failed", {
        orgId,
        errorCode: error instanceof ForgeReadError ? error.code : "error",
      });
      return toAddRefusal(error);
    }
  };

  const openRepository: TokenConnectionService["openRepository"] = async (orgId, forgeRepoId) => {
    const own = await credential(orgId);
    if (!own.ok) return null;
    const opened = await client.openRepository(own.token, forgeRepoId);
    return opened.ok ? opened.value : null;
  };

  /** One repository's sync on an open session; the counts, or the problem met. */
  const syncOne = async (
    orgId: OrgId,
    token: string,
    repo: ConnectionRepositoryRow,
  ): Promise<{ report: RepositorySyncReport; retryAt?: Date }> => {
    const base = { id: repo.id, listed: 0, mirrored: 0, unchanged: 0, analysesQueued: 0 };
    let session: RepositorySession | null = null;
    try {
      const opened = await client.openRepository(token, repo.forgeRepoId);
      if (!opened.ok) return { report: { ...base, problem: denialToSync[opened.reason] } };
      session = opened.value;
      if (session === null) return { report: { ...base, problem: "repository_not_found" } };
      const report = await syncOpenPullRequests(db, orgId, session, {
        limit: syncLimit,
        enqueueAnalysis: deps.analysisAuto,
      });
      await db.withOrg(orgId, (tx) => markRepositorySynced(tx, repo.id, new Date(now())));
      log("info", "repository_synced", {
        orgId,
        repoId: repo.id,
        listed: report.listed,
        mirrored: report.mirrored,
        unchanged: report.unchanged,
        missing: report.missing,
        closed: report.closed,
        analysesQueued: report.analysesQueued,
        limitReached: report.limitReached,
      });
      return {
        report: {
          ...base,
          listed: report.listed,
          mirrored: report.mirrored,
          unchanged: report.unchanged,
          analysesQueued: report.analysesQueued,
          problem: null,
        },
      };
    } catch (error) {
      const { problem, retryAt } = problemOf(error);
      log("warn", "repository_sync_failed", {
        orgId,
        repoId: repo.id,
        problem,
        errorCode: error instanceof ForgeReadError ? error.code : "error",
      });
      return { report: { ...base, problem }, ...(retryAt === undefined ? {} : { retryAt }) };
    } finally {
      await session?.close();
    }
  };

  const runSync = async (orgId: OrgId, repoId: string | undefined): Promise<SyncResponse> => {
    const own = await credential(orgId);
    const repositories: RepositorySyncReport[] = [];
    if (!own.ok) {
      log("info", "sync_refused", { orgId, reason: own.problem });
      return { outcome: own.problem, retryAt: null, syncedAt: null, repositories };
    }
    const rows =
      repoId === undefined
        ? await db.withOrg(orgId, (tx) =>
            listConnectionRepositories(tx, { limit: MAX_CONNECTION_REPOSITORIES }),
          )
        : [await db.withOrg(orgId, (tx) => findConnectionRepository(tx, repoId))].filter(
            (r) => r !== null,
          );
    if (repoId !== undefined && rows.length === 0) {
      return { outcome: "repository_not_found", retryAt: null, syncedAt: null, repositories };
    }
    let outcome: SyncResponse["outcome"] = "synced";
    let retryAt: Date | undefined;
    for (const repo of rows) {
      const { report, retryAt: at } = await syncOne(orgId, own.token, repo);
      repositories.push(report);
      if (report.problem === null) continue;
      if (outcome === "synced") outcome = report.problem;
      // A dead token or an exhausted budget stops the rest: they would all fail the same way.
      if (
        report.problem === "rate_limited" ||
        report.problem === "token_rejected" ||
        report.problem === "forbidden"
      ) {
        retryAt = at;
        break;
      }
    }
    const syncedAt = repositories.some((r) => r.problem === null) ? new Date(now()) : null;
    log("info", "synced", {
      orgId,
      outcome,
      repositories: repositories.length,
      failed: repositories.filter((r) => r.problem !== null).length,
    });
    return {
      outcome,
      retryAt: retryAt === undefined ? null : retryAt.toISOString(),
      syncedAt: syncedAt === null ? null : syncedAt.toISOString(),
      repositories,
    };
  };

  /** `runSync` under the per-org lock; `busy` when one is running. */
  const guarded = async (orgId: OrgId, repoId: string | undefined): Promise<SyncResponse> => {
    if (syncing.has(orgId)) {
      return { outcome: "busy", retryAt: null, syncedAt: null, repositories: [] };
    }
    syncing.add(orgId);
    lastSyncStartedAt.set(orgId, now());
    try {
      return await runSync(orgId, repoId);
    } finally {
      syncing.delete(orgId);
    }
  };

  const sync: TokenConnectionService["sync"] = async (orgId, options = {}) => {
    const since = now() - (lastSyncStartedAt.get(orgId) ?? -Infinity);
    if (options.force !== true && since < SYNC_MIN_INTERVAL_MS && !syncing.has(orgId)) {
      return { outcome: "busy", retryAt: null, syncedAt: null, repositories: [] };
    }
    return guarded(orgId, options.repoId);
  };

  const syncOnOpen: TokenConnectionService["syncOnOpen"] = async (orgId) => {
    const stamp = async (): Promise<string | null> =>
      (await db.withOrg(orgId, lastSyncedAt))?.toISOString() ?? null;
    const since = now() - (lastSyncStartedAt.get(orgId) ?? -Infinity);
    if (syncing.has(orgId)) {
      return { state: "running", lastSyncedAt: await stamp(), problem: null, retryAt: null };
    }
    if (since < onOpenInterval) {
      return { state: "skipped", lastSyncedAt: await stamp(), problem: null, retryAt: null };
    }
    const running = guarded(orgId, undefined);
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      running,
      new Promise<"waiting">((resolve) => {
        timer = setTimeout(() => resolve("waiting"), onOpenWait);
      }),
    ]).finally(() => clearTimeout(timer));
    if (waited === "waiting") {
      // It goes on without the request; its failures are logged by `runSync` and seen next time.
      running.catch(() => undefined);
      return { state: "running", lastSyncedAt: await stamp(), problem: null, retryAt: null };
    }
    const failed = waited.outcome !== "synced" && waited.outcome !== "busy";
    return {
      state: failed ? "failed" : waited.outcome === "busy" ? "running" : "synced",
      lastSyncedAt: await stamp(),
      problem: failed ? (waited.outcome as SyncProblem) : null,
      retryAt: failed ? waited.retryAt : null,
    };
  };

  const syncPullRequest: TokenConnectionService["syncPullRequest"] = async (orgId, target) => {
    const key = `${orgId}|${target.forgeRepoId}|${target.number}`;
    if (now() - (lastPullSyncAt.get(key) ?? -Infinity) < onOpenInterval) return;
    lastPullSyncAt.set(key, now());
    // Bounded: a page opened for many pull requests remembers at most this many keys.
    while (lastPullSyncAt.size > 10_000) {
      const oldest = lastPullSyncAt.keys().next().value;
      if (oldest === undefined) break;
      lastPullSyncAt.delete(oldest);
    }
    const own = await credential(orgId);
    if (!own.ok) return;
    let session: RepositorySession | null = null;
    try {
      const opened = await client.openRepository(own.token, target.forgeRepoId);
      if (!opened.ok || opened.value === null) return;
      session = opened.value;
      const pr = await session.getPullRequest(target.number);
      if (pr === null) return;
      const result = await mirrorPullRequest(db, orgId, session, pr, {
        enqueueAnalysis: deps.analysisAuto,
      });
      log("info", "pull_request_synced", {
        orgId,
        number: target.number,
        outcome: result.outcome,
        analysisQueued: result.analysisQueued,
      });
    } catch (error) {
      log("warn", "pull_request_sync_failed", {
        orgId,
        number: target.number,
        errorCode: error instanceof ForgeReadError ? error.code : "error",
      });
    } finally {
      await session?.close();
    }
  };

  const addRepository: TokenConnectionService["addRepository"] = async (orgId, forgeRepoId) => {
    const own = await credential(orgId);
    if (!own.ok) return { ok: false, reason: "no_token" };
    const followed = await db.withOrg(orgId, (tx) =>
      listConnectionRepositories(tx, { limit: MAX_CONNECTION_REPOSITORIES }),
    );
    if (
      followed.length >= MAX_CONNECTION_REPOSITORIES &&
      !followed.some((r) => r.forgeRepoId === forgeRepoId)
    ) {
      return { ok: false, reason: "too_many_repositories" };
    }
    let found;
    try {
      found = await client.getRepository(own.token, forgeRepoId);
    } catch (error) {
      log("warn", "add_failed", {
        orgId,
        errorCode: error instanceof ForgeReadError ? error.code : "error",
      });
      return toAddRefusal(error);
    }
    if (!found.ok) return { ok: false, reason: denialToSync[found.reason] };
    if (found.value === null) return { ok: false, reason: "repository_not_found" };
    if (!found.value.permissions.pull) return { ok: false, reason: "no_read_permission" };
    const repository = found.value;
    const repoId = await db.withOrg(orgId, async (tx) => {
      const id = await upsertRepository(tx, repository);
      await enableRepository(tx, id);
      const connection = await loadTokenConnection(tx);
      await audit(
        tx,
        { type: "user", id: connection?.memberId ?? "token_owner" },
        "connection.repository_added",
        { type: "repo", id },
        { forgeRepoId },
      );
      return id;
    });
    log("info", "repository_added", { orgId, repoId, forgeRepoId });
    const synced = await guarded(orgId, repoId);
    const row = await db.withOrg(orgId, (tx) => findConnectionRepository(tx, repoId));
    const view = row === null ? null : repositoryView(row);
    if (view === null) return { ok: false, reason: "repository_not_found" };
    return { ok: true, repository: view, sync: synced };
  };

  const removeRepository: TokenConnectionService["removeRepository"] = async (orgId, repoId) => {
    const removed = await db.withOrg(orgId, async (tx) => {
      if (!(await disableRepository(tx, repoId))) return false;
      const connection = await loadTokenConnection(tx);
      await audit(
        tx,
        { type: "user", id: connection?.memberId ?? "token_owner" },
        "connection.repository_removed",
        { type: "repo", id: repoId },
      );
      return true;
    });
    if (removed) log("info", "repository_removed", { orgId, repoId });
    return removed;
  };

  return {
    saveToken,
    removeToken,
    describe,
    describeToken,
    listAvailable,
    addRepository,
    removeRepository,
    sync,
    syncOnOpen,
    syncPullRequest,
    openRepository,
  };
};
