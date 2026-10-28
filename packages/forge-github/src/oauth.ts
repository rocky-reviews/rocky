import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { isAbort, readCapped } from "./http.js";
import type { GitHubEndpoints } from "./app-manifest.js";

/**
 * GitHub App user authorization (P7-1, ADR 0020): the web flow with PKCE (S256), a
 * server-side code exchange, and the two reads login needs, all with the user's token:
 *
 * - `GET /user`: who logged in. Identity is the numeric `id`; the `login` is display data.
 * - `GET /user/installations`: the app's installations the user can access. Rocky maps them to
 *   its orgs by installation id and account id; this is where org membership comes from.
 *
 * The client secret goes only into the token request's body, the user's token only into the
 * `authorization` header of the two reads. Neither, nor the code, the verifier or a response
 * body, is ever put in an error, returned beyond what is documented here, or logged. Errors are
 * `GitHubLoginError` with a fixed reason and at most an HTTP status. A refresh token in the
 * exchange's answer is dropped unread (ADR 0020 §4: sessions never outlive the access token).
 * No redirects are followed; every call has a timeout and a body cap.
 */

export const LOGIN_TIMEOUT_MS = 10_000;
export const MAX_LOGIN_RESPONSE_BYTES = 256 * 1024;
/** Pages of 100 read from `GET /user/installations` (1000 installations at most). */
export const MAX_INSTALLATION_PAGES = 10;
/** GitHub's documented user-token lifetime is 8 hours; anything above a year is not believed. */
const MAX_EXPIRES_IN_SECONDS = 366 * 24 * 3600;

export type GitHubLoginFailure =
  | "timeout"
  | "network"
  | "http_status"
  | "invalid_response"
  /** The code is wrong, expired, already used, or its PKCE verifier does not match. */
  | "bad_verification_code"
  /** The client id or secret was refused: an operator problem. */
  | "client_rejected"
  /** Any other OAuth error GitHub reports. */
  | "oauth_error"
  /** 401 on a read with the user's token. */
  | "token_rejected"
  /** 403 on a read (SSO enforcement, IP allow list, rate limit). */
  | "forbidden"
  | "too_many_installations";

export class GitHubLoginError extends Error {
  override readonly name = "GitHubLoginError";
  readonly reason: GitHubLoginFailure;
  readonly status: number | undefined;
  constructor(reason: GitHubLoginFailure, status?: number) {
    super(`GitHub login failed: ${reason}${status === undefined ? "" : ` (${status})`}`);
    this.reason = reason;
    this.status = status;
  }
}

/** PKCE (RFC 7636): a 256-bit verifier (43 base64url characters) and its S256 challenge. */
export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");
export const newPkceVerifier = (): string => randomBytes(32).toString("base64url");
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** GitHub App client ids (`Iv1.…`, `Iv23…`). */
const CLIENT_ID = /^[A-Za-z0-9._-]{8,64}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{20,256}$/;
/** What GitHub sends back as `code`; anything else is refused before an exchange. */
const CODE = /^[A-Za-z0-9_-]{8,128}$/;
const STATE = /^[A-Za-z0-9_-]{32,128}$/;
const TOKEN = /^[\x21-\x7e]{16,512}$/;
const JSON_TYPE = /^application\/(?:vnd\.github\+)?json\b/i;

export const isOAuthCode = (value: unknown): value is string =>
  typeof value === "string" && CODE.test(value);

const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const UserJson = z.object({ id: ForgeId, login: Login });
const TokenJson = z.object({
  access_token: z.string().regex(TOKEN),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.int().min(1).max(MAX_EXPIRES_IN_SECONDS).optional(),
});
const ErrorJson = z.object({ error: z.string().max(64) });
const Installation = z.object({
  id: ForgeId,
  app_id: ForgeId.optional(),
  // `type` and `login` are read for the membership rule (review round 1); an enterprise account
  // has a `slug` and no login, so both are optional here and checked below.
  account: z
    .object({ id: ForgeId, type: z.string().max(32).optional(), login: Login.optional() })
    .nullable(),
  suspended_at: z.string().nullable().optional(),
});
const InstallationsJson = z.object({
  total_count: z.int().min(0),
  installations: z.array(z.unknown()).max(100),
});

export interface GitHubIdentity {
  readonly id: number;
  /** Display only: GitHub logins can be renamed and reused. */
  readonly login: string;
}

export interface GitHubUserToken {
  readonly accessToken: string;
  /** When the token expires, or `null` for a token that does not (expiry disabled on the app). */
  readonly expiresAt: Date | null;
}

export interface GitHubUserInstallation {
  readonly installationId: number;
  readonly accountId: number;
  /** GitHub's account login, for the membership URL (display data otherwise). */
  readonly accountLogin: string;
  readonly accountType: "Organization" | "User";
}

/** `GET /user/memberships/orgs/{org}`: the user's own membership of an organization. */
const MembershipJson = z.object({
  state: z.string().max(32),
  organization: z.object({ id: ForgeId }),
  user: z.object({ id: ForgeId }),
});
const NotFound = z.object({ message: z.literal("Not Found") });

export interface GitHubLogin {
  /** `https://github.com/login/oauth/authorize?…` for this state and challenge. */
  authorizeUrl(input: { redirectUri: URL; state: string; codeChallenge: string }): URL;
  /** The code → user token exchange (server side, with the client secret and the verifier). */
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: URL;
  }): Promise<GitHubUserToken>;
  readUser(accessToken: string): Promise<GitHubIdentity>;
  /**
   * Installations of this app the user can access, on an Organization or User account;
   * suspended ones, other apps' and enterprise accounts are left out.
   */
  listInstallations(accessToken: string): Promise<GitHubUserInstallation[]>;
  /**
   * Whether the token's user is an **active** member of the organization (review round 1):
   * `GET /user/memberships/orgs/{org}` as the user (needs the app's organization permission
   * Members: read). `true` only for `state: "active"` with the same organization and user ids;
   * GitHub's JSON 404 is `false`; any other answer throws `GitHubLoginError`.
   */
  isActiveOrgMember(
    accessToken: string,
    org: { readonly id: number; readonly login: string },
    userId: number,
  ): Promise<boolean>;
}

export interface GitHubLoginOptions {
  readonly endpoints: GitHubEndpoints;
  readonly clientId: string;
  readonly clientSecret: string;
  /** When known (`GITHUB_APP_ID`), installations of any other app id are left out. */
  readonly appId?: number;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const decodeJson = (contentType: string, bytes: Buffer | undefined): unknown => {
  if (!JSON_TYPE.test(contentType) || bytes === undefined) {
    throw new GitHubLoginError("invalid_response");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GitHubLoginError("invalid_response");
  }
};

/** OAuth error codes GitHub documents; anything else is reported as `oauth_error`. */
const OAUTH_ERRORS: Readonly<Record<string, GitHubLoginFailure>> = {
  bad_verification_code: "bad_verification_code",
  incorrect_client_credentials: "client_rejected",
  unverified_user_email: "oauth_error",
  redirect_uri_mismatch: "oauth_error",
};

export const createGitHubLogin = (options: GitHubLoginOptions): GitHubLogin => {
  const { web, api } = options.endpoints;
  if (web.protocol !== "https:" || api.protocol !== "https:") {
    throw new Error("GitHub endpoints must be https");
  }
  if (!web.pathname.endsWith("/") || !api.pathname.endsWith("/")) {
    throw new Error("GitHub endpoints must end with /");
  }
  if (!CLIENT_ID.test(options.clientId)) throw new Error("GitHub App client id is malformed");
  if (!CLIENT_SECRET.test(options.clientSecret)) {
    throw new Error("GitHub App client secret is malformed");
  }
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;

  const call = async (
    url: URL,
    init: { method: string; headers: Record<string, string>; body?: string },
    read: { readonly readNotFound?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> => {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url.href, { ...init, redirect: "error", signal });
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new GitHubLoginError("timeout");
      throw new GitHubLoginError("network");
    }
    const readable =
      response.status === 200 || (read.readNotFound === true && response.status === 404);
    if (!readable) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: undefined };
    }
    let bytes: Buffer | undefined;
    try {
      bytes = await readCapped(response, MAX_LOGIN_RESPONSE_BYTES);
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new GitHubLoginError("timeout");
      throw new GitHubLoginError("network");
    }
    return {
      status: response.status,
      body: decodeJson(response.headers.get("content-type") ?? "", bytes),
    };
  };

  const asUser = async (path: string, accessToken: string): Promise<unknown> => {
    if (typeof accessToken !== "string" || !TOKEN.test(accessToken)) {
      throw new GitHubLoginError("token_rejected");
    }
    const answer = await call(new URL(path, api), {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "rocky-reviews",
      },
    });
    if (answer.status === 401) throw new GitHubLoginError("token_rejected", 401);
    if (answer.status === 403) throw new GitHubLoginError("forbidden", 403);
    if (answer.status !== 200) throw new GitHubLoginError("http_status", answer.status);
    return answer.body;
  };

  return {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) => {
      if (!STATE.test(state)) throw new Error("authorizeUrl: malformed state");
      if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
        throw new Error("authorizeUrl: malformed code challenge");
      }
      const url = new URL("login/oauth/authorize", web);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri.href);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },

    exchangeCode: async ({ code, codeVerifier, redirectUri }) => {
      if (!isOAuthCode(code)) throw new GitHubLoginError("bad_verification_code");
      if (!VERIFIER.test(codeVerifier)) throw new GitHubLoginError("bad_verification_code");
      const asked = now();
      const answer = await call(new URL("login/oauth/access_token", web), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "rocky-reviews",
        },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri.href,
          code_verifier: codeVerifier,
        }).toString(),
      });
      if (answer.status !== 200) throw new GitHubLoginError("http_status", answer.status);
      // GitHub reports OAuth errors with a 200 and an `error` field.
      const failure = ErrorJson.safeParse(answer.body);
      if (failure.success) {
        throw new GitHubLoginError(OAUTH_ERRORS[failure.data.error] ?? "oauth_error");
      }
      const parsed = TokenJson.safeParse(answer.body);
      if (!parsed.success) throw new GitHubLoginError("invalid_response");
      const { access_token: accessToken, expires_in: expiresIn } = parsed.data;
      // Counted from before the request, so the stored expiry is never later than GitHub's.
      return {
        accessToken,
        expiresAt: expiresIn === undefined ? null : new Date(asked + expiresIn * 1000),
      };
    },

    isActiveOrgMember: async (accessToken, org, userId) => {
      if (
        !Number.isSafeInteger(org.id) ||
        org.id < 1 ||
        !Number.isSafeInteger(userId) ||
        userId < 1
      ) {
        throw new Error("isActiveOrgMember: invalid id");
      }
      if (typeof org.login !== "string" || !Login.safeParse(org.login).success) {
        throw new Error("isActiveOrgMember: invalid organization login");
      }
      if (typeof accessToken !== "string" || !TOKEN.test(accessToken)) {
        throw new GitHubLoginError("token_rejected");
      }
      const answer = await call(
        new URL(`user/memberships/orgs/${encodeURIComponent(org.login)}`, api),
        {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${accessToken}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "rocky-reviews",
          },
        },
        { readNotFound: true },
      );
      if (answer.status === 404) {
        if (!NotFound.safeParse(answer.body).success)
          throw new GitHubLoginError("invalid_response");
        return false;
      }
      if (answer.status === 401) throw new GitHubLoginError("token_rejected", 401);
      if (answer.status === 403) throw new GitHubLoginError("forbidden", 403);
      if (answer.status !== 200) throw new GitHubLoginError("http_status", answer.status);
      const parsed = MembershipJson.safeParse(answer.body);
      if (!parsed.success) throw new GitHubLoginError("invalid_response");
      return (
        parsed.data.state === "active" &&
        parsed.data.organization.id === org.id &&
        parsed.data.user.id === userId
      );
    },

    readUser: async (accessToken) => {
      const parsed = UserJson.safeParse(await asUser("user", accessToken));
      if (!parsed.success) throw new GitHubLoginError("invalid_response");
      return { id: parsed.data.id, login: parsed.data.login };
    },

    listInstallations: async (accessToken) => {
      const found = new Map<number, GitHubUserInstallation>();
      for (let page = 1; ; page++) {
        if (page > MAX_INSTALLATION_PAGES) throw new GitHubLoginError("too_many_installations");
        const body = await asUser(`user/installations?per_page=100&page=${page}`, accessToken);
        const parsed = InstallationsJson.safeParse(body);
        if (!parsed.success) throw new GitHubLoginError("invalid_response");
        for (const raw of parsed.data.installations) {
          const item = Installation.safeParse(raw);
          if (!item.success) throw new GitHubLoginError("invalid_response");
          const { id, app_id: appId, account, suspended_at: suspendedAt } = item.data;
          if (options.appId !== undefined && appId !== options.appId) continue;
          if (account === null || (suspendedAt !== undefined && suspendedAt !== null)) continue;
          const type = account.type;
          if ((type !== "Organization" && type !== "User") || account.login === undefined) continue;
          found.set(id, {
            installationId: id,
            accountId: account.id,
            accountLogin: account.login,
            accountType: type,
          });
        }
        if (parsed.data.installations.length < 100) break;
      }
      return [...found.values()];
    },
  };
};
