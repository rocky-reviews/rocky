import {
  ForgeReadError,
  personalTokenKind,
  type ForgeRepository,
  type GitHubTokenKind,
  type RepositorySession,
} from "@rocky-reviews/core";
import { z } from "zod";
import {
  createGitHubHttp,
  createRepositorySession,
  decodeRepository,
  ForgeId,
  FULL_NAME,
  isId,
  MAX_LIST_PAGE_BYTES,
  MAX_TOKEN_RESPONSE_BYTES,
  RepositoryJson,
  type GitHubHttp,
} from "./client.js";

/**
 * GitHub on a personal access token (P10-4, ADR 0045): the token-mode self-host's one
 * credential, the owner's own. Everything the App forge does with installation tokens
 * (repository sessions: pull requests, listings, diffs) is done here with the person's token,
 * through the same `createRepositorySession`; posting a review and the access check already
 * take a user credential (ADR 0026, ADR 0011) and are unchanged.
 *
 * - **The token is the person's**: never revoked by Rocky (`close` is a no-op), never logged,
 *   never put in an error, and refused without a request unless it has the shape of a personal
 *   token (`personalTokenKind`: an OAuth, installation or user-to-server token is not one).
 * - **`readUser`** is the validation on save: `GET /user` says whose token it is (the numeric
 *   id is the identity), which kind it is (from its prefix), and when it expires (GitHub's
 *   `github-authentication-token-expiration` header, when present). A classic token's scopes
 *   come back as a list so the caller can warn about them; they are never stored.
 * - **Rate limits** are one budget per token. An exhausted one is `rate_limited` with GitHub's
 *   reset time, so the page can say when to try again instead of retrying blindly.
 * - **Answers** as everywhere: https only, no redirects, timeouts, byte caps, schema-checked,
 *   ids must match. A JSON 404 is "not visible to this token" (`null`); 401 is `token_rejected`
 *   and 403 `forbidden` through the fixed denial codes; anything else throws `ForgeReadError`.
 */

export const USER_READ_TIMEOUT_MS = 10_000;
/** Repositories `listRepositories` reads at most: five pages of 100. */
export const MAX_LISTED_REPOSITORIES = 500;
const PAGE = 100;

/** A GitHub user login as `GET /user` returns it (no `[bot]`). */
const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const UserJson = z.object({ id: ForgeId, login: Login });
const Permissions = z.object({ pull: z.boolean(), push: z.boolean().optional() }).optional();
/** One listed repository; a name that does not pass the forge's rules is left out, not failed. */
const ListedJson = z.object({
  id: ForgeId,
  full_name: z.string().max(200),
  private: z.boolean(),
  default_branch: z.string().max(255),
  permissions: Permissions,
});
const RepositoryListJson = z.array(ListedJson).max(PAGE);
const RepositoryWithPermissionsJson = RepositoryJson.extend({ permissions: Permissions });
/** A classic token's scopes, as `x-oauth-scopes` lists them: a short comma-separated list. */
const SCOPES = /^[a-z_:]{1,40}(?:, ?[a-z_:]{1,40}){0,40}$/;

export interface TokenIdentity {
  readonly id: number;
  readonly login: string;
  readonly kind: GitHubTokenKind;
  /** GitHub's expiry for the token; `null` when it reported none (a token that never expires). */
  readonly expiresAt: Date | null;
  /** A classic token's scopes (shown as a warning, never stored); empty for a fine-grained one. */
  readonly scopes: readonly string[];
}

/** Why a token is not accepted. Fixed codes. */
export type TokenDenial = "not_a_personal_token" | "token_rejected" | "forbidden";

export type TokenRead<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: TokenDenial };

/** A repository the token can see, with what the token's owner may do there. */
export interface TokenRepository extends ForgeRepository {
  readonly permissions: { readonly pull: boolean; readonly push: boolean };
}

export interface GitHubTokenClient {
  /** Whose token this is, its kind and its expiry (`GET /user`). */
  readUser(token: string): Promise<TokenRead<TokenIdentity>>;
  /**
   * The repositories the token can see (`GET /user/repos`, every affiliation, most recently
   * updated first), up to `max` (at most `MAX_LISTED_REPOSITORIES`); `truncated` when there are
   * more. Entries whose names do not pass the forge's rules are left out.
   */
  listRepositories(
    token: string,
    options?: { readonly max?: number },
  ): Promise<TokenRead<{ repositories: TokenRepository[]; truncated: boolean }>>;
  /** One repository by id (`GET /repositories/{id}`); `null` when the token cannot see it. */
  getRepository(token: string, repositoryId: number): Promise<TokenRead<TokenRepository | null>>;
  /**
   * A session on one repository the token can see (`null` when it cannot), with the same reads
   * as an installation session. `close` revokes nothing: the token is the person's.
   */
  openRepository(token: string, repositoryId: number): Promise<TokenRead<RepositorySession | null>>;
}

export interface GitHubTokenClientOptions {
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly diffTimeoutMs?: number;
}

/** GitHub writes the expiry as `2026-12-31 23:59:59 UTC`; anything unreadable is "unknown". */
const expiryOf = (header: string | null): Date | null => {
  if (header === null || header.length > 64) return null;
  const at = Date.parse(header.replace(/ UTC$/, "Z").replace(" ", "T"));
  return Number.isFinite(at) ? new Date(at) : null;
};

const scopesOf = (header: string | null): string[] =>
  header === null || !SCOPES.test(header) ? [] : header.split(",").map((s) => s.trim());

const permissionsOf = (value: z.infer<typeof Permissions>) => ({
  pull: value?.pull === true,
  push: value?.push === true,
});

export const createGitHubTokenClient = (options: GitHubTokenClientOptions): GitHubTokenClient => {
  const http: GitHubHttp = createGitHubHttp({
    api: options.api,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    timeoutMs: options.timeoutMs ?? USER_READ_TIMEOUT_MS,
    authorization: (credential) => {
      if (credential.kind !== "token") throw new Error("token client: no app credential");
      return `Bearer ${credential.token}`;
    },
    rateLimits: true,
  });

  const credential = (token: string) => ({ kind: "token" as const, token });

  /** The documented refusals of a user token; anything else is the caller's to decide. */
  const denial = (status: number): TokenDenial | null =>
    status === 401 ? "token_rejected" : status === 403 ? "forbidden" : null;

  const readUser: GitHubTokenClient["readUser"] = async (token) => {
    const kind = personalTokenKind(token);
    if (kind === null) return { ok: false, reason: "not_a_personal_token" };
    const answer = await http.exchange("GET", "user", credential(token), MAX_TOKEN_RESPONSE_BYTES);
    const refused = denial(answer.status);
    if (refused !== null) return { ok: false, reason: refused };
    if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
    const user = UserJson.safeParse(http.json(answer));
    if (!user.success) throw new ForgeReadError("invalid_response");
    return {
      ok: true,
      value: {
        id: user.data.id,
        login: user.data.login,
        kind,
        expiresAt: expiryOf(answer.headers.get("github-authentication-token-expiration")),
        scopes: kind === "classic" ? scopesOf(answer.headers.get("x-oauth-scopes")) : [],
      },
    };
  };

  const listRepositories: GitHubTokenClient["listRepositories"] = async (
    token,
    listOptions = {},
  ) => {
    if (personalTokenKind(token) === null) return { ok: false, reason: "not_a_personal_token" };
    const max = listOptions.max ?? MAX_LISTED_REPOSITORIES;
    if (!Number.isSafeInteger(max) || max < 1 || max > MAX_LISTED_REPOSITORIES) {
      throw new Error("listRepositories: invalid max");
    }
    const repositories: TokenRepository[] = [];
    const seen = new Set<number>();
    for (let page = 1; ; page++) {
      const answer = await http.exchange(
        "GET",
        "user/repos",
        credential(token),
        MAX_LIST_PAGE_BYTES,
        {
          search: {
            per_page: String(PAGE),
            page: String(page),
            sort: "updated",
            direction: "desc",
            affiliation: "owner,collaborator,organization_member",
          },
        },
      );
      const refused = denial(answer.status);
      if (refused !== null) return { ok: false, reason: refused };
      if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
      const parsed = RepositoryListJson.safeParse(http.json(answer));
      if (!parsed.success) throw new ForgeReadError("invalid_response");
      for (const item of parsed.data) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (repositories.length >= max)
          return { ok: true, value: { repositories, truncated: true } };
        const repository = RepositoryJson.safeParse(item);
        // A name GitHub allows but Rocky's rules do not (none today): left out, never failed.
        if (!repository.success || !FULL_NAME.test(item.full_name)) continue;
        repositories.push({
          ...decodeRepository(item),
          permissions: permissionsOf(item.permissions),
        });
      }
      if (parsed.data.length < PAGE) return { ok: true, value: { repositories, truncated: false } };
      if (repositories.length >= max) return { ok: true, value: { repositories, truncated: true } };
    }
  };

  const getRepository: GitHubTokenClient["getRepository"] = async (token, repositoryId) => {
    if (personalTokenKind(token) === null) return { ok: false, reason: "not_a_personal_token" };
    if (!isId(repositoryId)) throw new Error("getRepository: invalid id");
    const answer = await http.exchange(
      "GET",
      `repositories/${repositoryId}`,
      credential(token),
      MAX_TOKEN_RESPONSE_BYTES,
    );
    const refused = denial(answer.status);
    if (refused !== null) return { ok: false, reason: refused };
    if (http.isNotFound(answer)) return { ok: true, value: null };
    if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
    const parsed = RepositoryWithPermissionsJson.safeParse(http.json(answer));
    if (!parsed.success || parsed.data.id !== repositoryId)
      throw new ForgeReadError("invalid_response");
    return {
      ok: true,
      value: {
        ...decodeRepository(parsed.data),
        permissions: permissionsOf(parsed.data.permissions),
      },
    };
  };

  const openRepository: GitHubTokenClient["openRepository"] = async (token, repositoryId) => {
    const found = await getRepository(token, repositoryId);
    if (!found.ok) return found;
    if (found.value === null) return { ok: true, value: null };
    const own = credential(token);
    return {
      ok: true,
      value: createRepositorySession({
        http,
        repository: found.value,
        // A personal token is on behalf of nobody but its owner: no installation in the refs.
        installationId: null,
        credential: () => Promise.resolve(own),
        close: () => Promise.resolve(),
        ...(options.diffTimeoutMs === undefined ? {} : { diffTimeoutMs: options.diffTimeoutMs }),
      }),
    };
  };

  return { readUser, listRepositories, getRepository, openRepository };
};
