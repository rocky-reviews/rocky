import {
  ForgeReadError,
  type ForgeUserCredential,
  type RepositoryLocator,
  type UserAccessReader,
  type UserRepositoryAccess,
} from "@rocky-reviews/core";
import { z } from "zod";
import { isAbort, readCapped } from "./http.js";
import { isRepositoryFullName } from "./repositories.js";

/**
 * Whether a GitHub user can read a repository (P3-6, ADR 0011), asked as that user:
 * `GET /repos/{owner}/{repo}` with the user's own token. GitHub answers with what this token can
 * see: a JSON 404 when the user (or, for a GitHub App user token, the installation) cannot see the
 * repository, and otherwise the repository with `permissions` for this user. Read access is
 * `permissions.pull === true`, on a repository whose `id` is the one asked about (a name can be
 * reused after a delete or a rename).
 *
 * Fail closed: 401 is `token_rejected`, 403 `forbidden` (SSO enforcement, IP allow list, rate
 * limit); any other status, a non-JSON or oversized body, a missing `permissions` object, a
 * redirect (renamed repository: refused, not followed), a timeout or a network failure throws
 * `ForgeReadError`, which the access check turns into a deny. The token goes into the
 * `authorization` header of this one request and nowhere else: never logged, kept, or put in an
 * error. A token that is not a plausible bearer value is rejected without a request (no header
 * injection).
 */

export const USER_ACCESS_TIMEOUT_MS = 10_000;
export const MAX_REPOSITORY_RESPONSE_BYTES = 256 * 1024;

const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const RepositoryJson = z.object({
  id: ForgeId,
  permissions: z.object({ pull: z.boolean() }),
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

export const createGitHubUserAccessReader = (
  options: GitHubUserAccessReaderOptions,
): UserAccessReader => {
  if (options.api.protocol !== "https:") throw new Error("GitHub API base must be https");
  const doFetch = options.fetch ?? fetch;

  const readUserRepositoryAccess = async (
    credential: ForgeUserCredential,
    repository: RepositoryLocator,
  ): Promise<UserRepositoryAccess> => {
    const { id, fullName } = repository;
    if (!Number.isSafeInteger(id) || id < 1 || !isRepositoryFullName(fullName)) {
      throw new Error("readUserRepositoryAccess: invalid repository");
    }
    const token = credential.token;
    if (typeof token !== "string" || !TOKEN.test(token)) {
      return { access: "none", reason: "token_rejected" };
    }
    const path = fullName
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = new URL(`repos/${path}`, options.api);
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
    if (status === 401 || status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { access: "none", reason: status === 401 ? "token_rejected" : "forbidden" };
    }
    if (status !== 200 && status !== 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new ForgeReadError("http_status", status);
    }
    let bytes: Buffer | undefined;
    try {
      bytes = await readCapped(response, MAX_REPOSITORY_RESPONSE_BYTES);
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
    const body = decodeJson(response.headers.get("content-type") ?? "", bytes);
    if (status === 404) {
      if (!NotFound.safeParse(body).success) throw new ForgeReadError("invalid_response");
      return { access: "none", reason: "not_found" };
    }
    const parsed = RepositoryJson.safeParse(body);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    if (parsed.data.id !== id) return { access: "none", reason: "repository_mismatch" };
    return parsed.data.permissions.pull
      ? { access: "read" }
      : { access: "none", reason: "no_read_permission" };
  };

  return { kind: "github", readUserRepositoryAccess };
};
