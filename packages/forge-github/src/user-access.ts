import {
  ForgeReadError,
  type ForgeUserCredential,
  type RepositoryLocator,
  type UserAccessReader,
  type UserRepositoryAccess,
  type UserRepositoryDenial,
} from "@rocky-reviews/core";
import { z } from "zod";
import { isAbort, readCapped } from "./http.js";
import { isRepositoryFullName } from "./repositories.js";

/**
 * Whether a GitHub user can read a repository (P3-6, ADR 0011), asked as that user with the
 * user's own token:
 *
 * 1. `GET /user`: who the token belongs to. Its `id` must be the member's `forge_user_id`
 *    (`token_user_mismatch` otherwise), and its `login` is the one used in step 3: the login comes
 *    from GitHub for this token, never from the request or the database.
 * 2. `GET /repos/{owner}/{repo}`: GitHub answers with what this token can see. A JSON 404 means
 *    the user (or, for a GitHub App user token, the installation) cannot see it. Otherwise read
 *    access is `permissions.pull === true` on a repository whose `id` is the one asked about.
 * 3. Only for a repository that is not private (`private !== true` or `visibility !==
 *    "private"`: public, internal, or anything unexpected):
 *    `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. Every GitHub user can read a
 *    public repository and every enterprise member an internal one, so `pull` proves nothing
 *    there. The user must be a collaborator with any role: `permission` `admin`, `write` or
 *    `read`, for this user's `id`. `none` or GitHub's JSON 404 is `not_collaborator`.
 *
 * Fail closed. 401 is `token_rejected` and 403 is `forbidden` on any call (SSO enforcement, IP
 * allow list, rate limit, or an endpoint that refuses app user tokens). Any other status, a
 * non-JSON or oversized body, a missing or mistyped field (including `visibility`), a redirect (a
 * renamed repository: refused, not followed), a timeout or a network failure throws
 * `ForgeReadError`, which the access check turns into a deny. The token goes into the
 * `authorization` header of these requests and nowhere else: it is never logged, kept, or put in
 * an error. A token that is not a plausible bearer value is rejected without a request, so it
 * cannot inject a header.
 */

export const USER_ACCESS_TIMEOUT_MS = 10_000;
export const MAX_REPOSITORY_RESPONSE_BYTES = 256 * 1024;

const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
/** A GitHub user login (no `[bot]`: an app cannot hold a user token). */
const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const UserJson = z.object({ id: ForgeId, login: Login });
const RepositoryJson = z.object({
  id: ForgeId,
  private: z.boolean(),
  visibility: z.string().max(32),
  permissions: z.object({ pull: z.boolean() }),
});
const CollaboratorJson = z.object({
  permission: z.enum(["admin", "write", "read", "none"]),
  role_name: z.string().min(1).max(125),
  user: z.object({ id: ForgeId, login: Login }),
});
const NotFound = z.object({ message: z.literal("Not Found") });
const TOKEN = /^[\x21-\x7e]{16,512}$/;
const JSON_TYPE = /^application\/(?:vnd\.github\+)?json\b/i;

export interface GitHubUserAccessReaderOptions {
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A denial GitHub answered with a status that means the same on every call. */
const DENIAL_BY_STATUS: Readonly<Record<number, UserRepositoryDenial>> = {
  401: "token_rejected",
  403: "forbidden",
};

const decodeJson = (contentType: string, bytes: Buffer | undefined): unknown => {
  if (!JSON_TYPE.test(contentType) || bytes === undefined) {
    throw new ForgeReadError("invalid_response");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ForgeReadError("invalid_response");
  }
};

const isNotFound = (answer: Answer): boolean => {
  if (answer.status !== 404) return false;
  if (!NotFound.safeParse(answer.body).success) throw new ForgeReadError("invalid_response");
  return true;
};

const segment = (value: string): string => encodeURIComponent(value);

export const createGitHubUserAccessReader = (
  options: GitHubUserAccessReaderOptions,
): UserAccessReader => {
  if (options.api.protocol !== "https:") throw new Error("GitHub API base must be https");
  // A relative path resolved against a base without the slash would drop its last segment.
  if (!options.api.pathname.endsWith("/")) throw new Error("GitHub API base must end with /");
  const doFetch = options.fetch ?? fetch;

  /**
   * One GET as the user. Returns the status and, for 200 and 404, the decoded JSON body; 401 and
   * 403 come back with no body; anything else throws.
   */
  const get = async (path: string, token: string): Promise<Answer> => {
    const url = new URL(path, options.api);
    const signal = AbortSignal.timeout(options.timeoutMs ?? USER_ACCESS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url.href, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "rocky-reviews",
        },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
    const status = response.status;
    if (status !== 200 && status !== 404) {
      await response.body?.cancel().catch(() => undefined);
      if (DENIAL_BY_STATUS[status] !== undefined) return { status, body: undefined };
      throw new ForgeReadError("http_status", status);
    }
    let bytes: Buffer | undefined;
    try {
      bytes = await readCapped(response, MAX_REPOSITORY_RESPONSE_BYTES);
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
    return { status, body: decodeJson(response.headers.get("content-type") ?? "", bytes) };
  };

  const denial = (answer: Answer): UserRepositoryAccess | null => {
    const reason = DENIAL_BY_STATUS[answer.status];
    return reason === undefined ? null : { access: "none", reason };
  };

  const readUserRepositoryAccess = async (
    credential: ForgeUserCredential,
    repository: RepositoryLocator,
  ): Promise<UserRepositoryAccess> => {
    const { id, fullName } = repository;
    if (!Number.isSafeInteger(id) || id < 1 || !isRepositoryFullName(fullName)) {
      throw new Error("readUserRepositoryAccess: invalid repository");
    }
    const { token, userId } = credential;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId < 1) {
      throw new Error("readUserRepositoryAccess: invalid user");
    }
    if (typeof token !== "string" || !TOKEN.test(token)) {
      return { access: "none", reason: "token_rejected" };
    }
    const base = `repos/${fullName.split("/").map(segment).join("/")}`;

    // 1. Whose token is this?
    const me = await get("user", token);
    const meDenied = denial(me);
    if (meDenied !== null) return meDenied;
    if (me.status !== 200) throw new ForgeReadError("http_status", me.status);
    const user = UserJson.safeParse(me.body);
    if (!user.success) throw new ForgeReadError("invalid_response");
    if (user.data.id !== userId) return { access: "none", reason: "token_user_mismatch" };

    // 2. Can this user read the repository?
    const repo = await get(base, token);
    const repoDenied = denial(repo);
    if (repoDenied !== null) return repoDenied;
    if (isNotFound(repo)) return { access: "none", reason: "not_found" };
    const parsed = RepositoryJson.safeParse(repo.body);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    if (parsed.data.id !== id) return { access: "none", reason: "repository_mismatch" };
    if (!parsed.data.permissions.pull) return { access: "none", reason: "no_read_permission" };
    if (parsed.data.private && parsed.data.visibility === "private") return { access: "read" };

    // 3. Not private: read access is everyone's, so require a collaborator role.
    const collaborator = await get(
      `${base}/collaborators/${segment(user.data.login)}/permission`,
      token,
    );
    const collaboratorDenied = denial(collaborator);
    if (collaboratorDenied !== null) return collaboratorDenied;
    if (isNotFound(collaborator)) return { access: "none", reason: "not_collaborator" };
    const role = CollaboratorJson.safeParse(collaborator.body);
    if (!role.success || role.data.user.id !== user.data.id) {
      throw new ForgeReadError("invalid_response");
    }
    return role.data.permission === "none"
      ? { access: "none", reason: "not_collaborator" }
      : { access: "read" };
  };

  return { kind: "github", readUserRepositoryAccess };
};
