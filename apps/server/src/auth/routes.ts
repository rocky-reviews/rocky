import { createHash } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import {
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  generateWrappedDataKey,
  OrgKeyring,
  type KeyWrapper,
} from "@rocky-reviews/crypto";
import {
  audit,
  clearForgeToken,
  loadOrgDataKey,
  loadSessionMember,
  SecretStoreError,
  storeForgeToken,
  storeOrgDataKey,
  upsertLoginMember,
  type Db,
  type LiveSession,
  type SessionMember,
  type SessionOrg,
  type StoredSecret,
} from "@rocky-reviews/db";
import {
  GitHubLoginError,
  isOAuthCode,
  newPkceVerifier,
  OAUTH_CALLBACK_PATH,
  pkceChallenge,
  type GitHubIdentity,
  type GitHubLogin,
  type GitHubUserToken,
} from "@rocky-reviews/forge-github";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { STYLE } from "../github-app-setup.js";
import { MEMBER_TOKEN_PURPOSE } from "../repository-access.js";
import {
  clearCookie,
  cookieName,
  csrfTokenFor,
  decodeLoginCookie,
  encodeLoginCookie,
  isRandomToken,
  LOGIN_COOKIE,
  randomToken,
  readCookie,
  sameSecret,
  serializeCookie,
  SESSION_COOKIE,
  sha256,
} from "./cookies.js";
import { DEFAULT_RETURN_TO, returnUrl, safeReturnTo } from "./return-to.js";

/**
 * GitHub login, sessions and the session API (P7-1, ADR 0020).
 *
 *   GET  /auth/github/login?returnTo=/path   new state + PKCE verifier → login cookie, 302 to GitHub
 *   GET  /auth/github/callback?code&state    state checked against the cookie and consumed once,
 *                                            code exchanged with the verifier, identity and orgs
 *                                            read from GitHub → new session cookie, 303 to returnTo
 *   POST /auth/logout                        (CSRF) revokes the session, clears the cookie
 *   GET  /api/session                        the session, its orgs and the CSRF token, or 401
 *   POST /api/session/active-org {orgId}     (CSRF) chooses the org to work in
 *
 * Logs carry fixed outcomes, ids and counts: never a code, state, verifier, cookie, token, login
 * or email. The rate-limit seam for P7-3 is `AuthDeps.rateLimit`, applied to these routes only.
 */

export const LOGIN_PATH = "/auth/github/login";
export const LOGOUT_PATH = "/auth/logout";
export const SESSION_PATH = "/api/session";
export const ACTIVE_ORG_PATH = "/api/session/active-org";
/** Time to approve on GitHub; also the login cookie's lifetime. */
export const LOGIN_TTL_MS = 10 * 60 * 1000;
/** A session unused this long ends. */
export const SESSION_IDLE_SECONDS = 8 * 60 * 60;
/** A session ends this long after login at the latest, and never after the GitHub token. */
export const SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** A token that expires sooner than this is not worth a session. */
const MIN_TOKEN_REMAINING_MS = 5 * 60 * 1000;

export interface AuthDeps {
  readonly publicUrl: URL;
  readonly cookieSecure: boolean;
  /** HMAC key for the login cookie and the CSRF token (≥ 32 bytes). */
  readonly secret: Buffer;
  readonly login: GitHubLogin;
  readonly db: Pick<Db, "withOrg" | "sessions">;
  readonly keys: KeyWrapper;
  readonly now?: () => number;
  readonly idleTimeoutSeconds?: number;
  readonly maxLifetimeMs?: number;
  /**
   * Called after the transaction that stored or cleared a member's token has committed (ADR 0011
   * §6): the server passes the repository access check's `invalidateMember` here.
   */
  readonly onMemberTokenChanged?: (orgId: OrgId, memberId: string) => void;
  /** P7-3 seam: registers rate limiting on the auth routes' scope. */
  readonly rateLimit?: (scope: FastifyInstance) => Promise<void>;
}

export interface SessionContext {
  readonly token: string;
  readonly session: LiveSession;
}

/** What a route needs after `activeMember`: ids from the session, never from the request. */
export interface ActiveMember {
  readonly sessionId: string;
  readonly userId: string;
  readonly orgId: OrgId;
  readonly memberId: string;
  readonly role: SessionMember["role"];
}

export interface SessionAuth {
  /** The live session of this request's cookie, or `null`. Moves its idle window. */
  authenticate(request: FastifyRequest): Promise<SessionContext | null>;
  /**
   * The session's member in its active org, verified inside `withOrg` (the member row exists,
   * belongs to the session's GitHub user, and the org is not being deleted), or `null`. P7-2
   * routes start here.
   */
  activeMember(request: FastifyRequest): Promise<ActiveMember | null>;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

const noStore = (reply: FastifyReply): FastifyReply =>
  reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff");

/** A fixed page: `title` and `body` are literals written here, never request or GitHub data. */
const page = (reply: FastifyReply, status: number, title: string, body: string) =>
  noStore(reply)
    .code(status)
    .header(
      "content-security-policy",
      `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    )
    .header("x-frame-options", "DENY")
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}<p><a href="${LOGIN_PATH}">Sign in again</a></p></body></html>`,
    );

const param = (request: FastifyRequest, name: string): string | undefined | null => {
  const query = request.query as Record<string, unknown>;
  if (!Object.hasOwn(query, name)) return undefined;
  const value = query[name];
  return typeof value === "string" ? value : null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE = /^[A-Za-z0-9_-]{43}$/;

export const registerAuth = (app: FastifyInstance, deps: AuthDeps): SessionAuth => {
  const now = deps.now ?? Date.now;
  const idle = deps.idleTimeoutSeconds ?? SESSION_IDLE_SECONDS;
  const maxLifetime = deps.maxLifetimeMs ?? SESSION_MAX_LIFETIME_MS;
  const sessionCookie = cookieName(SESSION_COOKIE, deps.cookieSecure);
  const loginCookie = cookieName(LOGIN_COOKIE, deps.cookieSecure);
  const redirectUri = new URL(OAUTH_CALLBACK_PATH, deps.publicUrl.origin);
  const { db } = deps;

  const log = (
    request: FastifyRequest,
    level: "info" | "warn" | "error",
    outcome: string,
    extra: Record<string, string | number | boolean> = {},
  ) => request.log[level]({ signin: { outcome, ...extra } }, "sign-in");

  const changed = (orgId: OrgId, memberId: string) => {
    try {
      deps.onMemberTokenChanged?.(orgId, memberId);
    } catch {
      // An observer failure never changes the outcome; the 5-minute bound still holds.
    }
  };

  const authenticate = async (request: FastifyRequest): Promise<SessionContext | null> => {
    const token = readCookie(request.headers.cookie, sessionCookie);
    if (!isRandomToken(token)) return null;
    const at = new Date(now());
    const session = await db.sessions.findSession(sha256(token), at);
    if (session === null) return null;
    await db.sessions.touchSession(session.sessionId, at);
    return { token, session };
  };

  const memberOf = (session: LiveSession, link: SessionOrg) =>
    db.withOrg(link.orgId, (tx) =>
      loadSessionMember(tx, { memberId: link.memberId, forgeUserId: session.forgeUserId }),
    );

  const activeMember = async (request: FastifyRequest): Promise<ActiveMember | null> => {
    const context = await authenticate(request);
    if (context === null) return null;
    const { session } = context;
    const link = session.orgs.find((o) => o.orgId === session.activeOrgId);
    if (link === undefined) return null;
    const member = await memberOf(session, link);
    if (member === null) return null;
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      orgId: link.orgId,
      memberId: member.memberId,
      role: member.role,
    };
  };

  /** The session as the web app sees it; orgs whose membership no longer holds are left out. */
  const view = async (context: SessionContext) => {
    const { session } = context;
    const orgs: {
      id: OrgId;
      login: string;
      memberId: string;
      memberLogin: string;
      role: SessionMember["role"];
    }[] = [];
    for (const link of session.orgs) {
      const member = await memberOf(session, link);
      if (member === null) continue;
      orgs.push({
        id: link.orgId,
        login: member.orgLogin,
        memberId: member.memberId,
        memberLogin: member.login,
        role: member.role,
      });
    }
    const active = orgs.some((o) => o.id === session.activeOrgId) ? session.activeOrgId : null;
    return {
      authenticated: true as const,
      user: { id: session.userId, forgeUserId: session.forgeUserId },
      orgs,
      activeOrgId: active,
      csrfToken: csrfTokenFor(deps.secret, context.token),
      expiresAt: session.expiresAt.toISOString(),
      idleExpiresAt: new Date(
        Math.min(session.expiresAt.getTime(), now() + idle * 1000),
      ).toISOString(),
    };
  };

  /** Stores the user's token for one org's member, encrypted under that org's data key. */
  const bindOrg = async (
    orgId: OrgId,
    identity: GitHubIdentity,
    token: GitHubUserToken,
  ): Promise<SessionOrg> => {
    const first = await db.withOrg(orgId, async (tx) => ({
      member: await upsertLoginMember(tx, { forgeUserId: identity.id, login: identity.login }),
      dataKey: await loadOrgDataKey(tx),
    }));
    const { memberId } = first.member;
    let dataKey: StoredSecret | null = first.dataKey;
    if (dataKey === null) {
      // First token in this org: provision its data key (first writer wins).
      const wrapped = await generateWrappedDataKey(deps.keys, orgId, 1);
      const text = encodeWrappedDataKey(wrapped);
      try {
        await db.withOrg(orgId, (tx) => storeOrgDataKey(tx, text, wrapped.version));
        dataKey = { ciphertext: text, keyVersion: wrapped.version };
      } catch (error) {
        if (!(error instanceof SecretStoreError)) throw error;
        dataKey = await db.withOrg(orgId, (tx) => loadOrgDataKey(tx));
        if (dataKey === null) throw error;
      }
    }
    // Outside any transaction: no transaction is held across a KMS call.
    const keyring = await OrgKeyring.open(deps.keys, orgId, [
      decodeWrappedDataKey(dataKey.ciphertext),
    ]);
    let ciphertext: string;
    let version: number;
    try {
      ciphertext = keyring.encrypt(token.accessToken, {
        purpose: MEMBER_TOKEN_PURPOSE,
        recordId: memberId,
      });
      version = keyring.currentVersion;
    } finally {
      keyring.destroy();
    }
    await db.withOrg(orgId, (tx) =>
      storeForgeToken(tx, memberId, ciphertext, version, { expiresAt: token.expiresAt }),
    );
    changed(orgId, memberId);
    return { orgId, memberId };
  };

  const auditIn = async (
    orgs: readonly SessionOrg[],
    action: string,
    sessionId: string,
    metadata: Record<string, string> = {},
  ): Promise<void> => {
    for (const link of orgs) {
      await db.withOrg(link.orgId, (tx) =>
        audit(
          tx,
          { type: "user", id: link.memberId },
          action,
          { type: "session", id: sessionId },
          metadata,
        ),
      );
    }
  };

  const clearLogin = clearCookie(LOGIN_COOKIE, deps.cookieSecure);

  void app.register(async (scope) => {
    if (deps.rateLimit !== undefined) await deps.rateLimit(scope);

    scope.get(LOGIN_PATH, async (request, reply) => {
      const raw = param(request, "returnTo");
      const returnTo = (typeof raw === "string" ? safeReturnTo(raw) : null) ?? DEFAULT_RETURN_TO;
      if (raw !== undefined && returnTo === DEFAULT_RETURN_TO && raw !== DEFAULT_RETURN_TO) {
        log(request, "warn", "return_to_refused");
      }
      const state = randomToken();
      const verifier = newPkceVerifier();
      const at = now();
      await db.sessions.createLoginAttempt({
        stateSha256: sha256(state),
        returnTo,
        now: new Date(at),
        ttlMs: LOGIN_TTL_MS,
      });
      const cookie = encodeLoginCookie(deps.secret, {
        state,
        verifier,
        expiresAt: Math.floor((at + LOGIN_TTL_MS) / 1000),
      });
      const location = deps.login.authorizeUrl({
        redirectUri,
        state,
        codeChallenge: pkceChallenge(verifier),
      });
      log(request, "info", "login_started");
      return noStore(reply)
        .code(302)
        .header(
          "set-cookie",
          serializeCookie(LOGIN_COOKIE, cookie, {
            secure: deps.cookieSecure,
            maxAgeSeconds: LOGIN_TTL_MS / 1000,
          }),
        )
        .header("location", location.href)
        .send();
    });

    scope.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
      // The login cookie is spent whatever happens next.
      void reply.header("set-cookie", clearLogin);
      const state = param(request, "state");
      const code = param(request, "code");
      if (param(request, "error") !== undefined) {
        log(request, "info", "login_cancelled");
        return page(reply, 400, "Sign-in cancelled", "<p>GitHub did not sign you in.</p>");
      }
      if (typeof state !== "string" || !STATE.test(state) || !isOAuthCode(code)) {
        log(request, "warn", "bad_parameters");
        return page(reply, 400, "Invalid sign-in link", "<p>Start again from Rocky.</p>");
      }
      const at = now();
      const binding = decodeLoginCookie(
        deps.secret,
        readCookie(request.headers.cookie, loginCookie),
        at,
      );
      // Login CSRF: the state must be the one this browser was given.
      if (binding === undefined || !sameSecret(binding.state, state)) {
        log(request, "warn", binding === undefined ? "no_login_cookie" : "state_mismatch");
        return page(reply, 403, "Sign-in expired", "<p>Start again from Rocky.</p>");
      }
      const attempt = await db.sessions.consumeLoginAttempt(sha256(state), new Date(at));
      if (attempt === null) {
        log(request, "warn", "state_unknown_or_used");
        return page(reply, 403, "Sign-in expired", "<p>Start again from Rocky.</p>");
      }

      let token: GitHubUserToken;
      let identity: GitHubIdentity;
      let installations;
      try {
        token = await deps.login.exchangeCode({
          code,
          codeVerifier: binding.verifier,
          redirectUri,
        });
        identity = await deps.login.readUser(token.accessToken);
        installations = await deps.login.listInstallations(token.accessToken);
      } catch (error) {
        const e = error instanceof GitHubLoginError ? error : undefined;
        log(request, "warn", "github_failed", {
          reason: e?.reason ?? "unknown",
          ...(e?.status === undefined ? {} : { status: e.status }),
        });
        return e?.reason === "bad_verification_code"
          ? page(reply, 400, "Sign-in expired", "<p>Start again from Rocky.</p>")
          : page(reply, 502, "GitHub sign-in failed", "<p>Try again in a moment.</p>");
      }

      const after = now();
      let expiresAt = after + maxLifetime;
      if (token.expiresAt !== null) {
        if (token.expiresAt.getTime() - after < MIN_TOKEN_REMAINING_MS) {
          log(request, "warn", "token_expiring");
          return page(reply, 502, "GitHub sign-in failed", "<p>Try again in a moment.</p>");
        }
        // A session never outlives the token it was created with (ADR 0020 §4).
        expiresAt = Math.min(expiresAt, token.expiresAt.getTime());
      }

      const candidates = await db.sessions.loginOrgs("github", installations);
      const { userId } = await db.sessions.upsertUser("github", identity.id, new Date(after));
      const bound: SessionOrg[] = [];
      for (const candidate of candidates) {
        try {
          bound.push(await bindOrg(candidate.orgId, identity, token));
        } catch (error) {
          // That org is left out of the session (fail closed for it, not for the others).
          const code = (error as { code?: unknown }).code;
          log(request, "error", "org_bind_failed", {
            orgId: candidate.orgId,
            ...(typeof code === "string" ? { errorCode: code } : {}),
          });
        }
      }

      // Session fixation: whatever session this browser presented ends here.
      const presented = readCookie(request.headers.cookie, sessionCookie);
      if (isRandomToken(presented)) {
        const old = await db.sessions.findSession(sha256(presented), new Date(after));
        if (old !== null) {
          const revoked = await db.sessions.revokeSession(
            old.sessionId,
            "superseded",
            new Date(after),
          );
          if (revoked !== null) {
            await auditIn(revoked.orgs, "auth.session_revoked", revoked.sessionId, {
              reason: "superseded",
            });
          }
        }
      }

      const sessionToken = randomToken();
      const { sessionId } = await db.sessions.createSession({
        tokenSha256: sha256(sessionToken),
        userId,
        orgs: bound,
        activeOrgId: bound.length === 1 ? (bound[0]?.orgId ?? null) : null,
        now: new Date(after),
        idleTimeoutSeconds: idle,
        expiresAt: new Date(expiresAt),
      });
      try {
        await auditIn(bound, "auth.login", sessionId);
      } catch (error) {
        // No unaudited session: revoke it and fail.
        await db.sessions.revokeSession(sessionId, "logout", new Date(now()));
        throw error;
      }
      log(request, "info", "login", { userId, orgs: bound.length, sessionRecord: sessionId });
      const target = returnUrl(attempt.returnTo, deps.publicUrl);
      return noStore(reply)
        .code(303)
        .header("set-cookie", [
          clearLogin,
          serializeCookie(SESSION_COOKIE, sessionToken, {
            secure: deps.cookieSecure,
            maxAgeSeconds: Math.floor((expiresAt - after) / 1000),
          }),
        ])
        .header("location", target.href)
        .send();
    });

    scope.post(LOGOUT_PATH, async (request, reply) => {
      const clear = clearCookie(SESSION_COOKIE, deps.cookieSecure);
      const context = await authenticate(request);
      if (context === null) return noStore(reply).code(204).header("set-cookie", clear).send();
      const at = new Date(now());
      const revoked = await db.sessions.revokeSession(context.session.sessionId, "logout", at);
      if (revoked !== null) {
        await auditIn(revoked.orgs, "auth.logout", revoked.sessionId);
        // ADR 0011 §6: the stored token goes with the last live session of this user.
        if ((await db.sessions.otherLiveSessions(revoked.userId, revoked.sessionId, at)) === 0) {
          for (const link of revoked.orgs) {
            await db.withOrg(link.orgId, (tx) => clearForgeToken(tx, link.memberId));
            changed(link.orgId, link.memberId);
          }
        }
        log(request, "info", "logout", { sessionRecord: revoked.sessionId });
      }
      return noStore(reply).code(204).header("set-cookie", clear).send();
    });

    scope.get(SESSION_PATH, async (request, reply) => {
      const context = await authenticate(request);
      if (context === null) return noStore(reply).code(401).send({ authenticated: false });
      return noStore(reply)
        .code(200)
        .send(await view(context));
    });

    scope.post(ACTIVE_ORG_PATH, async (request, reply) => {
      const context = await authenticate(request);
      if (context === null) return noStore(reply).code(401).send({ authenticated: false });
      const body = request.body as { orgId?: unknown } | null | undefined;
      const orgId = body?.orgId;
      if (typeof orgId !== "string" || !UUID.test(orgId)) {
        return noStore(reply).code(400).send({ error: "invalid_org" });
      }
      const link = context.session.orgs.find((o) => o.orgId === orgId.toLowerCase());
      // Membership is re-checked inside the org's own transaction before it becomes active.
      const member = link === undefined ? null : await memberOf(context.session, link);
      if (link === undefined || member === null) {
        return noStore(reply).code(404).send({ error: "not_found" });
      }
      if (!(await db.sessions.setActiveOrg(context.session.sessionId, link.orgId))) {
        return noStore(reply).code(404).send({ error: "not_found" });
      }
      const fresh = await authenticate(request);
      if (fresh === null) return noStore(reply).code(401).send({ authenticated: false });
      return noStore(reply)
        .code(200)
        .send(await view(fresh));
    });
  });

  return { authenticate, activeMember };
};
