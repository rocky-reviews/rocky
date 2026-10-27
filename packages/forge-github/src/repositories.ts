import {
  ForgeReadError,
  type Clock,
  type DiffTruncation,
  type Forge,
  type ForgeDiff,
  type ForgePullRequest,
  type ForgePullRequestSummary,
  type ForgeRepository,
  type RepositoryRef,
  type RepositorySession,
  type RevisionRef,
} from "@rocky-reviews/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { githubAppJwt, type GitHubAppAuth } from "./app-auth.js";
import { isAbort, readCapped, readUpTo } from "./http.js";
import { createGitHubInstallationReader } from "./installations.js";

/**
 * Pull request reads for the mirror (P3-4, ADR 0010), on behalf of one installation and one
 * repository.
 *
 * **Credentials.** Each session mints its own installation access token
 * (`POST /app/installations/{id}/access_tokens`, authenticated with the app JWT) scoped to the
 * one repository (`repository_ids`) and to read-only permissions (`contents: read`,
 * `pull_requests: read`), narrower than what the app was granted (`pull_requests: write`). The
 * answer must say exactly that: the one repository asked for, and no permission beyond read on
 * those two (plus `metadata: read`, which GitHub always adds); anything else is revoked and
 * refused. The token lives only in this closure: it is never returned, logged, stored or put in
 * an error. `close()` revokes it (`DELETE /installation/token`), so it is valid for the duration
 * of one inbox row or one rebuild, not GitHub's full hour; a session that outlives
 * `TOKEN_REFRESH_MARGIN_MS` before the token's expiry gets a new one.
 *
 * **Answers.** As for installations (ADR 0009 §4): https API base only, no redirects followed,
 * timeouts, byte caps, schema-checked, ids must be the ones asked for. Only GitHub's own JSON
 * `{"message": "Not Found"}` 404 means "not there"; a minting 422 means the repository is not
 * one the installation can access. Everything else throws `ForgeReadError`.
 *
 * **Diffs** come from `GET /repos/{owner}/{repo}/compare/{base}...{head}` (the merge-base diff
 * GitHub shows for a pull request, pinned to the revision's two commits, so a push between the
 * pull request read and the diff read cannot mix revisions). They are read up to `maxBytes`; a
 * longer diff is cut at its last complete line and flagged `max_bytes`. GitHub refusing to render
 * it (406 with `errors[].code == "too_large"`) is `forge_limit`; commits it does not have (a JSON
 * 404 or 422, which can be temporary right after a push) is `unavailable`. The reading is the raw
 * bytes and their sha256, never a decoded copy (a diff need not be UTF-8). Diff content is
 * untrusted and never logged.
 */

export const MIRROR_TOKEN_PERMISSIONS: Readonly<Record<string, "read">> = Object.freeze({
  contents: "read",
  pull_requests: "read",
});
/** GitHub adds `metadata: read` to every installation token. */
const IMPLIED_PERMISSIONS: Readonly<Record<string, "read">> = { metadata: "read" };

export const REPOSITORY_READ_TIMEOUT_MS = 10_000;
export const DIFF_READ_TIMEOUT_MS = 30_000;
export const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024;
export const MAX_PULL_REQUEST_RESPONSE_BYTES = 1024 * 1024;
/** 100 pull requests per page, each with a body of up to 64 KiB. */
export const MAX_LIST_PAGE_BYTES = 16 * 1024 * 1024;
/** The largest `maxBytes` a caller may ask for. */
export const MAX_DIFF_BYTES = 64 * 1024 * 1024;
export const LIST_PAGE_SIZE = 100;
/** A listing stops with an error past this many pages (10 000 pull requests). */
export const MAX_LIST_PAGES = 100;
/** A token this close to its expiry is replaced before the next read. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const PrNumber = z.int().min(1).max(2_147_483_647);
const Count = z.int().min(0).max(2_147_483_647);
const Sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
/** Users and GitHub Apps (`name[bot]`), as in webhook senders. */
const ActorLogin = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/);
/** `owner/name`; a name of `.` or `..` would address another path (review round 1, F). */
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const FullName = z.string().regex(FULL_NAME);
/** A git branch name as GitHub reports it: no control characters or spaces; bounded. */
const Branch = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => [...v].every((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f));
/** GitHub caps titles at 256 characters; anything far longer is not a GitHub answer. */
const Title = z.string().max(1024);
const Timestamp = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(Date.parse(v)));
/** An opaque bearer token: printable ASCII, bounded. Its format is GitHub's business. */
const Token = z.string().regex(/^[\x21-\x7e]{16,512}$/);

const RepositoryJson = z.object({
  id: ForgeId,
  full_name: FullName,
  private: z.boolean(),
  default_branch: Branch,
});
const TokenJson = z.object({
  token: Token,
  expires_at: Timestamp,
  permissions: z.record(z.string(), z.string()),
  repositories: z.array(z.record(z.string(), z.unknown())).max(100),
});
/** Read first, so a token that comes with an unacceptable answer can still be revoked. */
const TokenOnly = z.object({ token: Token });
const PullRequestJson = z.object({
  number: PrNumber,
  state: z.enum(["open", "closed"]),
  title: Title,
  user: z.object({ login: ActorLogin }).nullable(),
  head: z.object({ sha: Sha }),
  base: z.object({ sha: Sha, repo: z.object({ id: ForgeId }) }),
  created_at: Timestamp,
  updated_at: Timestamp,
  closed_at: Timestamp.nullable(),
  merged_at: Timestamp.nullable(),
  additions: Count,
  deletions: Count,
  changed_files: Count,
});
const PullRequestListJson = z
  .array(
    z.object({
      number: PrNumber,
      head: z.object({ sha: Sha }),
      base: z.object({ repo: z.object({ id: ForgeId }) }),
      updated_at: Timestamp,
    }),
  )
  .max(LIST_PAGE_SIZE);
const InstallationJson = z.object({
  id: ForgeId,
  suspended_at: z.string().max(64).nullable().optional(),
});
const NotFound = z.object({ message: z.literal("Not Found") });
const TooLarge = z.object({
  errors: z
    .array(z.object({ code: z.string() }))
    .refine((e) => e.some((x) => x.code === "too_large")),
});

const JSON_TYPE = /^application\/(?:vnd\.github\+)?json\b/i;
const DIFF_TYPE = /^(?:text\/plain|application\/vnd\.github\.diff)\b/i;

/** A diff reading of exactly these bytes. */
const reading = (bytes: Buffer, truncation: DiffTruncation | null): ForgeDiff => ({
  bytes: new Uint8Array(bytes),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  truncated: truncation !== null,
  truncation,
});

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

const decodeJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ForgeReadError("invalid_response");
  }
};

/** `owner/name` as two encoded path segments (both already shape-checked). */
const repoPath = (fullName: string): string =>
  fullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

export const isRepositoryFullName = (value: unknown): value is string =>
  typeof value === "string" && FULL_NAME.test(value);

export interface GitHubForgeOptions {
  readonly auth: GitHubAppAuth;
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly diffTimeoutMs?: number;
}

type Credential = { readonly kind: "app" } | { readonly kind: "token"; readonly token: string };

interface Exchange {
  readonly status: number;
  readonly contentType: string;
  /** `undefined` when the body was larger than the cap. */
  readonly bytes: Buffer | undefined;
}

interface Minted {
  readonly token: string;
  readonly expiresAt: number;
  readonly repository: ForgeRepository;
}

/**
 * The GitHub `Forge`: installation reads as the app (`createGitHubInstallationReader`) plus
 * repository sessions on installation tokens.
 */
export const createGitHubForge = (options: GitHubForgeOptions): Forge => {
  if (options.api.protocol !== "https:") throw new Error("GitHub API base must be https");
  const doFetch = options.fetch ?? fetch;
  const installations = createGitHubInstallationReader(options);

  const authorization = (credential: Credential): string =>
    credential.kind === "app"
      ? `Bearer ${githubAppJwt(options.auth, options.clock.now())}`
      : `Bearer ${credential.token}`;

  const open = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    credential: Credential,
    init: { accept?: string; body?: unknown; search?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ response: Response; signal: AbortSignal }> => {
    const url = new URL(path, options.api);
    for (const [key, value] of Object.entries(init.search ?? {})) url.searchParams.set(key, value);
    const signal = AbortSignal.timeout(
      init.timeoutMs ?? options.timeoutMs ?? REPOSITORY_READ_TIMEOUT_MS,
    );
    try {
      const response = await doFetch(url.href, {
        method,
        headers: {
          accept: init.accept ?? "application/vnd.github+json",
          authorization: authorization(credential),
          "x-github-api-version": "2022-11-28",
          "user-agent": "rocky-reviews",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal,
      });
      return { response, signal };
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
  };

  /** One request whose body is read whole, up to `cap` bytes. */
  const exchange = async (
    method: "GET" | "POST",
    path: string,
    credential: Credential,
    cap: number,
    init: { body?: unknown; search?: Record<string, string> } = {},
  ): Promise<Exchange> => {
    const { response, signal } = await open(method, path, credential, init);
    try {
      const bytes = await readCapped(response, cap);
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        bytes,
      };
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
  };

  /** The JSON body of an answer that must be JSON within its cap. */
  const json = (answer: Exchange): unknown => {
    if (!JSON_TYPE.test(answer.contentType) || answer.bytes === undefined) {
      throw new ForgeReadError("invalid_response");
    }
    return decodeJson(answer.bytes);
  };

  const isNotFound = (answer: Exchange): boolean => {
    if (answer.status !== 404) return false;
    if (!NotFound.safeParse(json(answer)).success) throw new ForgeReadError("invalid_response");
    return true;
  };

  /** Best effort: a token that cannot be revoked still expires within the hour. */
  const revoke = async (token: string): Promise<void> => {
    try {
      const { response } = await open("DELETE", "installation/token", { kind: "token", token }, {});
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Ignored: see above.
    }
  };

  const decodeRepository = (value: unknown): ForgeRepository => {
    const parsed = RepositoryJson.safeParse(value);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    return {
      id: parsed.data.id,
      fullName: parsed.data.full_name,
      private: parsed.data.private,
      defaultBranch: parsed.data.default_branch,
    };
  };

  /** True when the granted permissions are within what was asked for. */
  const withinScope = (granted: Record<string, string>): boolean =>
    Object.entries(granted).every(
      ([name, level]) =>
        level === "read" &&
        (Object.hasOwn(MIRROR_TOKEN_PERMISSIONS, name) || Object.hasOwn(IMPLIED_PERMISSIONS, name)),
    );

  /**
   * Mints a read-only token for one repository of `installationId`. `null` when GitHub says the
   * installation is gone (JSON 404) or the repository is not one it can access (422).
   */
  const mint = async (
    installationId: number,
    scope: { readonly repositoryId: number } | { readonly name: string },
  ): Promise<Minted | null> => {
    const answer = await exchange(
      "POST",
      `app/installations/${installationId}/access_tokens`,
      { kind: "app" },
      MAX_TOKEN_RESPONSE_BYTES,
      {
        body: {
          ...("repositoryId" in scope
            ? { repository_ids: [scope.repositoryId] }
            : { repositories: [scope.name] }),
          permissions: MIRROR_TOKEN_PERMISSIONS,
        },
      },
    );
    if (isNotFound(answer)) return null;
    if (answer.status === 422) {
      json(answer);
      return null;
    }
    if (answer.status !== 201) throw new ForgeReadError("http_status", answer.status);
    const body = json(answer);
    const issued = TokenOnly.safeParse(body);
    if (!issued.success) throw new ForgeReadError("invalid_response");
    const token = issued.data.token;
    let repository: ForgeRepository;
    let expiresAt: number;
    try {
      const parsed = TokenJson.safeParse(body);
      if (!parsed.success) throw new ForgeReadError("invalid_response");
      const { permissions, repositories } = parsed.data;
      if (!withinScope(permissions) || repositories.length !== 1) {
        throw new ForgeReadError("invalid_response");
      }
      repository = decodeRepository(repositories[0]);
      const expected =
        "repositoryId" in scope
          ? repository.id === scope.repositoryId
          : repository.fullName.split("/")[1]?.toLowerCase() === scope.name.toLowerCase();
      if (!expected) throw new ForgeReadError("invalid_response");
      expiresAt = Date.parse(parsed.data.expires_at);
    } catch (error) {
      // Never keep (or leave live) a token broader than, or for something other than, the ask.
      await revoke(token);
      throw error;
    }
    return { token, expiresAt, repository };
  };

  const decodePullRequest = (
    value: unknown,
    ref: { installationId: number; repositoryId: number; number: number },
  ): ForgePullRequest => {
    const parsed = PullRequestJson.safeParse(value);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    const p = parsed.data;
    // The answer must be about what was asked.
    if (p.number !== ref.number || p.base.repo.id !== ref.repositoryId) {
      throw new ForgeReadError("invalid_response");
    }
    return {
      ref,
      title: p.title,
      authorLogin: p.user?.login ?? null,
      state: p.merged_at !== null ? "merged" : p.state,
      headSha: p.head.sha,
      baseSha: p.base.sha,
      openedAt: new Date(p.created_at),
      closedAt: p.closed_at === null ? null : new Date(p.closed_at),
      updatedAt: new Date(p.updated_at),
      changedFiles: p.changed_files,
      additions: p.additions,
      deletions: p.deletions,
    };
  };

  const session = (ref: RepositoryRef, first: Minted): RepositorySession => {
    let current: Minted = first;
    let closed = false;
    const repository = first.repository;
    const base = `repos/${repoPath(repository.fullName)}`;

    const credential = async (): Promise<Credential> => {
      if (closed) throw new Error("repository session is closed");
      if (current.expiresAt - options.clock.now().getTime() < TOKEN_REFRESH_MARGIN_MS) {
        const next = await mint(ref.installationId, { repositoryId: ref.repositoryId });
        // Access was lost mid-session (uninstalled, repository removed from the installation).
        if (next === null) throw new ForgeReadError("http_status", 404);
        const previous = current.token;
        current = next;
        await revoke(previous);
      }
      return { kind: "token", token: current.token };
    };

    const getPullRequest = async (number: number): Promise<ForgePullRequest | null> => {
      if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
        throw new Error("getPullRequest: invalid number");
      }
      const answer = await exchange(
        "GET",
        `${base}/pulls/${number}`,
        await credential(),
        MAX_PULL_REQUEST_RESPONSE_BYTES,
      );
      if (isNotFound(answer)) return null;
      if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
      return decodePullRequest(json(answer), { ...ref, number });
    };

    async function* listPullRequests(): AsyncIterable<ForgePullRequestSummary> {
      for (let page = 1; ; page++) {
        if (page > MAX_LIST_PAGES) throw new ForgeReadError("invalid_response");
        const answer = await exchange(
          "GET",
          `${base}/pulls`,
          await credential(),
          MAX_LIST_PAGE_BYTES,
          {
            search: {
              state: "all",
              // Newest first, by creation: stable while pull requests are updated during the
              // listing; a pull request opened meanwhile only repeats one entry (consumers dedupe).
              sort: "created",
              direction: "desc",
              per_page: String(LIST_PAGE_SIZE),
              page: String(page),
            },
          },
        );
        if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
        const parsed = PullRequestListJson.safeParse(json(answer));
        if (!parsed.success) throw new ForgeReadError("invalid_response");
        for (const item of parsed.data) {
          if (item.base.repo.id !== ref.repositoryId) throw new ForgeReadError("invalid_response");
          yield {
            number: item.number,
            headSha: item.head.sha,
            updatedAt: new Date(item.updated_at),
          };
        }
        if (parsed.data.length < LIST_PAGE_SIZE) return;
      }
    }

    const getDiff = async (
      revision: RevisionRef,
      diffOptions: { readonly maxBytes: number },
    ): Promise<ForgeDiff> => {
      if (!Sha.safeParse(revision.baseSha).success || !Sha.safeParse(revision.headSha).success) {
        throw new Error("getDiff: invalid revision");
      }
      const maxBytes = diffOptions.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DIFF_BYTES) {
        throw new Error("getDiff: invalid maxBytes");
      }
      const { response, signal } = await open(
        "GET",
        `${base}/compare/${revision.baseSha}...${revision.headSha}`,
        await credential(),
        {
          accept: "application/vnd.github.diff",
          timeoutMs: options.diffTimeoutMs ?? DIFF_READ_TIMEOUT_MS,
        },
      );
      const contentType = response.headers.get("content-type") ?? "";
      try {
        if (response.status === 200) {
          if (!DIFF_TYPE.test(contentType)) {
            await response.body?.cancel().catch(() => undefined);
            throw new ForgeReadError("invalid_response");
          }
          const { bytes, overflow } = await readUpTo(response, maxBytes);
          if (!overflow) return reading(bytes, null);
          // Cut at the last complete line, so no hunk line (or UTF-8 sequence) is split. Size and
          // digest describe these raw bytes, never a decoded and re-encoded copy.
          return reading(bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1), "max_bytes");
        }
        const bytes = await readCapped(response, MAX_TOKEN_RESPONSE_BYTES);
        const answer: Exchange = { status: response.status, contentType, bytes };
        if (response.status === 406) {
          if (!TooLarge.safeParse(json(answer)).success) {
            throw new ForgeReadError("http_status", 406);
          }
          return reading(Buffer.alloc(0), "forge_limit");
        }
        if (isNotFound(answer) || response.status === 422) {
          json(answer);
          return reading(Buffer.alloc(0), "unavailable");
        }
        throw new ForgeReadError("http_status", response.status);
      } catch (error) {
        if (error instanceof ForgeReadError) throw error;
        if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
        throw new ForgeReadError("network");
      }
    };

    return {
      repository,
      getPullRequest,
      listPullRequests,
      getDiff,
      close: async () => {
        if (closed) return;
        closed = true;
        await revoke(current.token);
      },
    };
  };

  const openRepository = async (ref: RepositoryRef): Promise<RepositorySession | null> => {
    if (!isId(ref.installationId) || !isId(ref.repositoryId)) {
      throw new Error("openRepository: invalid ids");
    }
    const minted = await mint(ref.installationId, { repositoryId: ref.repositoryId });
    return minted === null ? null : session(ref, minted);
  };

  const locateRepository = async (fullName: string): Promise<RepositoryRef | null> => {
    if (!isRepositoryFullName(fullName)) throw new Error("locateRepository: invalid name");
    const answer = await exchange(
      "GET",
      `repos/${repoPath(fullName)}/installation`,
      { kind: "app" },
      MAX_TOKEN_RESPONSE_BYTES,
    );
    if (isNotFound(answer)) return null;
    if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
    const installation = InstallationJson.safeParse(json(answer));
    if (!installation.success) throw new ForgeReadError("invalid_response");
    // GitHub refuses tokens for a suspended installation; say so instead of a bare 403.
    const suspendedAt = installation.data.suspended_at;
    if (suspendedAt !== null && suspendedAt !== undefined) {
      throw new ForgeReadError("installation_suspended");
    }
    const name = fullName.split("/")[1] ?? "";
    const minted = await mint(installation.data.id, { name });
    if (minted === null) return null;
    await revoke(minted.token);
    return { installationId: installation.data.id, repositoryId: minted.repository.id };
  };

  return { ...installations, openRepository, locateRepository };
};
