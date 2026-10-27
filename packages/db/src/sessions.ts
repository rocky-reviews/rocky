import type { ForgeKind, OrgId } from "@rocky-reviews/core";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import type { TenantTx } from "./client.js";
import { members, orgs } from "./schema.js";

/**
 * Login and sessions (P7-1, migration 0013, ADR 0020). Sessions are user-level: these tables live
 * in `app`, outside tenant RLS, and hold ids, hashes and times only. The cookie token and the
 * OAuth state are never stored, only their sha256; nothing here ever sees a forge token.
 *
 * Times come from the caller's clock (the server's), so expiry is testable with a fake clock; the
 * database bounds what may be written (an absolute lifetime of at most 7 days that the
 * application cannot extend, a login attempt of at most 15 minutes).
 *
 * Errors are `SessionStoreError` with a fixed message and at most a SQLSTATE: driver messages
 * carry statement parameters.
 */

export class SessionStoreError extends Error {
  override readonly name = "SessionStoreError";
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Database bounds (migration 0013), checked here first so a bad call never reaches SQL. */
export const LOGIN_ATTEMPT_MAX_TTL_MS = 15 * 60 * 1000;
export const SESSION_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MIN_SECONDS = 60;
export const SESSION_IDLE_MAX_SECONDS = 86_400;
/** `last_seen_at` is written at most this often per session (idle expiry has this granularity). */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;
/** Dead sessions and attempts are kept this long after they ended, then purged. */
export const SESSION_PURGE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Most orgs one login can bind (and the database function's own bound). */
export const MAX_LOGIN_ORGS = 1000;
export const RETURN_TO_MAX_BYTES = 2048;

export type SessionRevocation = "logout" | "superseded";

export interface SessionOrg {
  readonly orgId: OrgId;
  readonly memberId: string;
}

/** A session that is live at the time asked: not revoked, before both expiries. */
export interface LiveSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly forge: ForgeKind;
  readonly forgeUserId: number;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  /** The absolute expiry. */
  readonly expiresAt: Date;
  /** `lastSeenAt + idle timeout`. */
  readonly idleExpiresAt: Date;
  /** The active org, only when it is one of `orgs`. */
  readonly activeOrgId: OrgId | null;
  /** Orgs whose membership was verified with the forge at login, still linked to a member row. */
  readonly orgs: readonly SessionOrg[];
}

export interface NewSession {
  readonly tokenSha256: Buffer;
  readonly userId: string;
  readonly orgs: readonly SessionOrg[];
  readonly activeOrgId: OrgId | null;
  readonly now: Date;
  readonly idleTimeoutSeconds: number;
  readonly expiresAt: Date;
}

export interface RevokedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly orgs: readonly SessionOrg[];
}

export interface LoginInstallation {
  readonly installationId: number;
  readonly accountId: number;
}

export interface SessionStore {
  /** Records a login in flight under sha256(state). */
  createLoginAttempt(input: {
    readonly stateSha256: Buffer;
    readonly returnTo: string;
    readonly now: Date;
    readonly ttlMs: number;
  }): Promise<void>;
  /**
   * Consumes a login attempt: deletes it and returns its `returnTo`, or `null` when it does not
   * exist, was already consumed, or has expired. Atomic: of two concurrent calls one wins.
   */
  consumeLoginAttempt(stateSha256: Buffer, now: Date): Promise<{ returnTo: string } | null>;
  /**
   * The live orgs bound to these installations (both ids must match; not scheduled for deletion,
   * not being erased), through `auth.login_orgs`.
   */
  loginOrgs(
    forge: ForgeKind,
    installations: readonly LoginInstallation[],
  ): Promise<{ orgId: OrgId; installationId: number }[]>;
  /** The user row for a forge identity, created on first login. */
  upsertUser(forge: ForgeKind, forgeUserId: number, now: Date): Promise<{ userId: string }>;
  /** A new session and its org links, in one transaction. */
  createSession(session: NewSession): Promise<{ sessionId: string }>;
  /** The live session with this token hash, or `null` (unknown, revoked, idle or expired). */
  findSession(tokenSha256: Buffer, now: Date): Promise<LiveSession | null>;
  /** Moves `last_seen_at` to `now` (at most once per SESSION_TOUCH_INTERVAL_MS). */
  touchSession(sessionId: string, now: Date): Promise<void>;
  /** Sets the active org; false unless the session is live and linked to that org. */
  setActiveOrg(sessionId: string, orgId: OrgId | null): Promise<boolean>;
  /** Revokes a live session; `null` when it was not live (already revoked, or unknown). */
  revokeSession(
    sessionId: string,
    reason: SessionRevocation,
    now: Date,
  ): Promise<RevokedSession | null>;
  /** How many other live sessions the user has at `now`. */
  otherLiveSessions(userId: string, exceptSessionId: string, now: Date): Promise<number>;
  /** Deletes attempts and sessions that ended more than SESSION_PURGE_AFTER_MS ago. */
  purgeEnded(now: Date): Promise<{ attempts: number; sessions: number }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const FORGES: readonly ForgeKind[] = ["github", "gitlab", "gitea"];
/** Mirrors the CHECK on app.login_attempts.return_to (the server validates far more strictly). */
const RETURN_TO_SHAPE = /^\/(?:[^/\\]|$)/;
const RETURN_TO_FORBIDDEN = /[\\\s\p{Cc}]/u;

const fail = (message: string): never => {
  throw new SessionStoreError(`sessions: ${message}`);
};

const assertHash = (value: unknown): Buffer =>
  Buffer.isBuffer(value) && value.length === 32 ? value : fail("hash must be 32 bytes");
const assertUuid = (value: unknown, what: string): string =>
  typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : fail(`${what} must be a uuid`);
const assertDate = (value: unknown, what: string): Date =>
  value instanceof Date && Number.isFinite(value.getTime())
    ? value
    : fail(`${what} must be a date`);
const assertForgeId = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fail(`${what} must be a positive integer`);
const assertForge = (value: unknown): ForgeKind =>
  FORGES.includes(value as ForgeKind) ? (value as ForgeKind) : fail("unknown forge");

const sqlState = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
};

/** Runs `run`; a database failure becomes a value-free `SessionStoreError`. */
const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError("sessions: database error", sqlState(error));
  }
};

interface SessionRow {
  id: string;
  user_id: string;
  forge: ForgeKind;
  forge_user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  idle_timeout_seconds: number;
  active_org_id: string | null;
}

export const createSessionStore = (pool: pg.Pool): SessionStore => {
  const orgsOf = async (
    client: Pick<pg.Pool, "query">,
    sessionId: string,
  ): Promise<SessionOrg[]> => {
    const { rows } = await client.query<{ org_id: string; member_id: string }>(
      "select org_id, member_id from app.session_orgs where session_id = $1 order by org_id",
      [sessionId],
    );
    return rows.map((r) => ({ orgId: r.org_id as OrgId, memberId: r.member_id }));
  };

  const createLoginAttempt: SessionStore["createLoginAttempt"] = async (input) => {
    const hash = assertHash(input.stateSha256);
    const now = assertDate(input.now, "now");
    if (
      !Number.isInteger(input.ttlMs) ||
      input.ttlMs < 1 ||
      input.ttlMs > LOGIN_ATTEMPT_MAX_TTL_MS
    ) {
      fail("login attempt lifetime out of range");
    }
    const { returnTo } = input;
    if (
      typeof returnTo !== "string" ||
      Buffer.byteLength(returnTo, "utf8") > RETURN_TO_MAX_BYTES ||
      !RETURN_TO_SHAPE.test(returnTo) ||
      RETURN_TO_FORBIDDEN.test(returnTo)
    ) {
      fail("returnTo must be a relative path");
    }
    await guarded(() =>
      pool.query(
        `insert into app.login_attempts (state_sha256, return_to, created_at, expires_at)
         values ($1, $2, $3, $4)`,
        [hash, returnTo, now, new Date(now.getTime() + input.ttlMs)],
      ),
    );
  };

  const consumeLoginAttempt: SessionStore["consumeLoginAttempt"] = async (stateSha256, now) => {
    const hash = assertHash(stateSha256);
    const at = assertDate(now, "now");
    // Deleted whatever its expiry: a presented state is spent even when it is too late.
    const { rows } = await guarded(() =>
      pool.query<{ return_to: string; expires_at: Date; created_at: Date }>(
        `delete from app.login_attempts where state_sha256 = $1
         returning return_to, expires_at, created_at`,
        [hash],
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    // Fresh only inside [created_at, expires_at): a clock that went backwards is not fresh.
    if (at.getTime() < row.created_at.getTime() || at.getTime() >= row.expires_at.getTime()) {
      return null;
    }
    return { returnTo: row.return_to };
  };

  const loginOrgs: SessionStore["loginOrgs"] = async (forge, installations) => {
    assertForge(forge);
    if (!Array.isArray(installations) || installations.length > MAX_LOGIN_ORGS) {
      fail("too many installations");
    }
    const installationIds = installations.map((i) =>
      assertForgeId(i.installationId, "installation id"),
    );
    const accountIds = installations.map((i) => assertForgeId(i.accountId, "account id"));
    if (installationIds.length === 0) return [];
    const { rows } = await guarded(() =>
      pool.query<{ org_id: string; installation_id: string }>(
        "select org_id, installation_id::text from auth.login_orgs($1, $2::bigint[], $3::bigint[])",
        [forge, installationIds, accountIds],
      ),
    );
    return rows.map((r) => ({
      orgId: r.org_id as OrgId,
      installationId: Number(r.installation_id),
    }));
  };

  const upsertUser: SessionStore["upsertUser"] = async (forge, forgeUserId, now) => {
    assertForge(forge);
    assertForgeId(forgeUserId, "forge user id");
    const at = assertDate(now, "now");
    const { rows } = await guarded(() =>
      pool.query<{ id: string }>(
        `insert into app.users (forge, forge_user_id, created_at, last_login_at)
         values ($1, $2, $3, $3)
         on conflict (forge, forge_user_id) do update set last_login_at = excluded.last_login_at
         returning id`,
        [forge, forgeUserId, at],
      ),
    );
    const row = rows[0];
    if (row === undefined) return fail("user upsert returned no row");
    return { userId: row.id };
  };

  const createSession: SessionStore["createSession"] = async (session) => {
    const hash = assertHash(session.tokenSha256);
    const userId = assertUuid(session.userId, "user id");
    const now = assertDate(session.now, "now");
    const expiresAt = assertDate(session.expiresAt, "expiresAt");
    const lifetime = expiresAt.getTime() - now.getTime();
    if (lifetime <= 0 || lifetime > SESSION_MAX_LIFETIME_MS) fail("session lifetime out of range");
    const idle = session.idleTimeoutSeconds;
    if (
      !Number.isInteger(idle) ||
      idle < SESSION_IDLE_MIN_SECONDS ||
      idle > SESSION_IDLE_MAX_SECONDS
    ) {
      fail("idle timeout out of range");
    }
    if (!Array.isArray(session.orgs) || session.orgs.length > MAX_LOGIN_ORGS) fail("too many orgs");
    const links = session.orgs.map((o) => ({
      orgId: assertUuid(o.orgId, "org id"),
      memberId: assertUuid(o.memberId, "member id"),
    }));
    const active = session.activeOrgId === null ? null : assertUuid(session.activeOrgId, "org id");
    if (active !== null && !links.some((l) => l.orgId === active)) {
      fail("the active org must be one of the session's orgs");
    }

    return guarded(async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query<{ id: string }>(
          `insert into app.sessions
             (token_sha256, user_id, created_at, last_seen_at, idle_timeout_seconds, expires_at)
           values ($1, $2, $3, $3, $4, $5)
           returning id`,
          [hash, userId, now, idle, expiresAt],
        );
        const sessionId = rows[0]?.id;
        if (sessionId === undefined)
          throw new SessionStoreError("sessions: insert returned no row");
        if (links.length > 0) {
          await client.query(
            `insert into app.session_orgs (session_id, org_id, member_id)
             select $1, o, m from unnest($2::uuid[], $3::uuid[]) as t(o, m)`,
            [sessionId, links.map((l) => l.orgId), links.map((l) => l.memberId)],
          );
        }
        if (active !== null) {
          await client.query("update app.sessions set active_org_id = $2 where id = $1", [
            sessionId,
            active,
          ]);
        }
        await client.query("commit");
        return { sessionId };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  };

  const findSession: SessionStore["findSession"] = async (tokenSha256, now) => {
    const hash = assertHash(tokenSha256);
    const at = assertDate(now, "now");
    const row = await guarded(async () => {
      // Live: not revoked, before the absolute expiry and before the idle expiry. The active
      // org counts only while the session is still linked to it.
      const { rows } = await pool.query<SessionRow>(
        `select s.id, s.user_id, u.forge, u.forge_user_id::text, s.created_at, s.last_seen_at,
                s.expires_at, s.idle_timeout_seconds,
                (select so.org_id from app.session_orgs so
                  where so.session_id = s.id and so.org_id = s.active_org_id) as active_org_id
           from app.sessions s join app.users u on u.id = s.user_id
          where s.token_sha256 = $1
            and s.revoked_at is null
            and s.created_at <= $2
            and s.expires_at > $2
            and s.last_seen_at + make_interval(secs => s.idle_timeout_seconds) > $2`,
        [hash, at],
      );
      return rows[0];
    });
    if (row === undefined) return null;
    const sessionOrgs = await guarded(() => orgsOf(pool, row.id));
    return {
      sessionId: row.id,
      userId: row.user_id,
      forge: row.forge,
      forgeUserId: Number(row.forge_user_id),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      idleExpiresAt: new Date(row.last_seen_at.getTime() + row.idle_timeout_seconds * 1000),
      activeOrgId: row.active_org_id as OrgId | null,
      orgs: sessionOrgs,
    };
  };

  const touchSession: SessionStore["touchSession"] = async (sessionId, now) => {
    const id = assertUuid(sessionId, "session id");
    const at = assertDate(now, "now");
    await guarded(() =>
      pool.query(
        `update app.sessions set last_seen_at = $2
          where id = $1 and revoked_at is null and expires_at > $2
            and last_seen_at <= $2 - make_interval(secs => $3::double precision / 1000)`,
        [id, at, SESSION_TOUCH_INTERVAL_MS],
      ),
    );
  };

  const setActiveOrg: SessionStore["setActiveOrg"] = async (sessionId, orgId) => {
    const id = assertUuid(sessionId, "session id");
    const org = orgId === null ? null : assertUuid(orgId, "org id");
    const { rowCount } = await guarded(() =>
      pool.query(
        `update app.sessions s set active_org_id = $2
          where s.id = $1 and s.revoked_at is null
            and ($2::uuid is null or exists (select 1 from app.session_orgs so
                                              where so.session_id = s.id and so.org_id = $2))`,
        [id, org],
      ),
    );
    return rowCount === 1;
  };

  const revokeSession: SessionStore["revokeSession"] = async (sessionId, reason, now) => {
    const id = assertUuid(sessionId, "session id");
    if (reason !== "logout" && reason !== "superseded") fail("unknown revocation reason");
    const at = assertDate(now, "now");
    const { rows } = await guarded(() =>
      pool.query<{ user_id: string }>(
        `update app.sessions set revoked_at = $2, revoked_reason = $3
          where id = $1 and revoked_at is null
          returning user_id`,
        [id, at, reason],
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { sessionId: id, userId: row.user_id, orgs: await guarded(() => orgsOf(pool, id)) };
  };

  const otherLiveSessions: SessionStore["otherLiveSessions"] = async (userId, except, now) => {
    const user = assertUuid(userId, "user id");
    const id = assertUuid(except, "session id");
    const at = assertDate(now, "now");
    const { rows } = await guarded(() =>
      pool.query<{ n: string }>(
        `select count(*)::text as n from app.sessions s
          where s.user_id = $1 and s.id <> $2 and s.revoked_at is null
            and s.expires_at > $3
            and s.last_seen_at + make_interval(secs => s.idle_timeout_seconds) > $3`,
        [user, id, at],
      ),
    );
    return Number(rows[0]?.n ?? 0);
  };

  const purgeEnded: SessionStore["purgeEnded"] = async (now) => {
    const at = assertDate(now, "now");
    const cutoff = new Date(at.getTime() - SESSION_PURGE_AFTER_MS);
    const attempts = await guarded(() =>
      pool.query("delete from app.login_attempts where expires_at < $1", [cutoff]),
    );
    const sessions = await guarded(() =>
      pool.query(
        `delete from app.sessions
          where (revoked_at is not null and revoked_at < $1)
             or expires_at < $1
             or last_seen_at + make_interval(secs => idle_timeout_seconds) < $1`,
        [cutoff],
      ),
    );
    return { attempts: attempts.rowCount ?? 0, sessions: sessions.rowCount ?? 0 };
  };

  return {
    createLoginAttempt,
    consumeLoginAttempt,
    loginOrgs,
    upsertUser,
    createSession,
    findSession,
    touchSession,
    setActiveOrg,
    revokeSession,
    otherLiveSessions,
    purgeEnded,
  };
};

// --- Inside withOrg -----------------------------------------------------------------------------

/** A GitHub user login (display data only; identity is the numeric id). */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * The member row of this org for a forge user verified at login, created on first login with
 * the default role (`member`; roles are P7-2's). An existing row keeps its role; only the
 * display login is refreshed. RLS keeps this inside the transaction's org.
 */
export const upsertLoginMember = async (
  tx: TenantTx,
  input: { readonly forgeUserId: number; readonly login: string },
): Promise<{ memberId: string }> => {
  const forgeUserId = assertForgeId(input.forgeUserId, "forge user id");
  if (typeof input.login !== "string" || !LOGIN.test(input.login)) fail("invalid login");
  const [row] = await guarded(() =>
    tx.db
      .insert(members)
      .values({ forgeUserId, login: input.login })
      .onConflictDoUpdate({
        target: [members.orgId, members.forgeUserId],
        set: { login: input.login, updatedAt: new Date() },
      })
      .returning({ id: members.id }),
  );
  if (row === undefined) return fail("member upsert returned no row");
  return { memberId: row.id };
};

export interface SessionMember {
  readonly memberId: string;
  readonly login: string;
  readonly role: "admin" | "member";
  readonly orgLogin: string;
}

/**
 * The session's member in this org, only when it still exists with the session user's forge id
 * and the org is not scheduled for deletion or being erased. `null` otherwise: the caller must
 * treat that as "not a member".
 */
export const loadSessionMember = async (
  tx: TenantTx,
  input: { readonly memberId: string; readonly forgeUserId: number },
): Promise<SessionMember | null> => {
  const memberId = assertUuid(input.memberId, "member id");
  const forgeUserId = assertForgeId(input.forgeUserId, "forge user id");
  const [row] = await guarded(() =>
    tx.db
      .select({
        memberId: members.id,
        login: members.login,
        role: members.role,
        orgLogin: orgs.login,
        deleteAfter: orgs.deleteAfter,
        erasingAt: orgs.erasingAt,
      })
      .from(members)
      .innerJoin(orgs, eq(orgs.id, members.orgId))
      .where(
        and(
          eq(members.orgId, tx.orgId),
          eq(members.id, memberId),
          eq(members.forgeUserId, forgeUserId),
        ),
      ),
  );
  if (row === undefined || row.deleteAfter !== null || row.erasingAt !== null) return null;
  return { memberId: row.memberId, login: row.login, role: row.role, orgLogin: row.orgLogin };
};
