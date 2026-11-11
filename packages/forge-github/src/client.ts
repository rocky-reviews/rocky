import {
  ForgeReadError,
  type DiffTruncation,
  type ForgeDiff,
  type ForgePullRequest,
  type ForgePullRequestSummary,
  type ForgeRepository,
  type RepositorySession,
  type RevisionRef,
} from "@rocky-reviews/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isAbort, readCapped, readUpTo } from "./http.js";

/**
 * The GitHub REST calls the repository reads share (P3-4, ADR 0010; shared with the token
 * client since P10-4, ADR 0045): one `fetch` wrapper with timeouts, byte caps, no redirects and
 * fixed failure reasons, and the repository session (pull request, listing, diff) built over
 * whichever credential the caller supplies: an installation token minted and revoked by the App
 * forge, or a personal access token that is the person's own (never revoked by Rocky).
 *
 * Answers are schema-checked and must be about what was asked (ids match). Only GitHub's own
 * JSON `{"message": "Not Found"}` 404 means "not there". Rate limits (P10-4): with `rateLimits`
 * on, a 403 or 429 whose `x-ratelimit-remaining` is 0 is `rate_limited`, with GitHub's reset
 * time; the App forge leaves it off (its installation tokens keep the P3-4 `http_status`
 * reasons and their inbox retry codes).
 */

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

export const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const PrNumber = z.int().min(1).max(2_147_483_647);
const Count = z.int().min(0).max(2_147_483_647);
export const Sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
/** Users and GitHub Apps (`name[bot]`), as in webhook senders. */
const ActorLogin = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/);
/** `owner/name`; a name of `.` or `..` would address another path (review round 1, F). */
export const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const FullName = z.string().regex(FULL_NAME);
/** A git branch name as GitHub reports it: no control characters or spaces; bounded. */
export const Branch = z
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

export const RepositoryJson = z.object({
  id: ForgeId,
  full_name: FullName,
  private: z.boolean(),
  default_branch: Branch,
});
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
const NotFound = z.object({ message: z.literal("Not Found") });
const TooLarge = z.object({
  errors: z
    .array(z.object({ code: z.string() }))
    .refine((e) => e.some((x) => x.code === "too_large")),
});

const JSON_TYPE = /^application\/(?:vnd\.github\+)?json\b/i;
const DIFF_TYPE = /^(?:text\/plain|application\/vnd\.github\.diff)\b/i;

export const isId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export const isRepositoryFullName = (value: unknown): value is string =>
  typeof value === "string" && FULL_NAME.test(value);

/** `owner/name` as two encoded path segments (both already shape-checked). */
export const repoPath = (fullName: string): string =>
  fullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

export const decodeJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ForgeReadError("invalid_response");
  }
};

export const decodeRepository = (value: unknown): ForgeRepository => {
  const parsed = RepositoryJson.safeParse(value);
  if (!parsed.success) throw new ForgeReadError("invalid_response");
  return {
    id: parsed.data.id,
    fullName: parsed.data.full_name,
    private: parsed.data.private,
    defaultBranch: parsed.data.default_branch,
  };
};

/** A diff reading of exactly these bytes. */
const reading = (bytes: Buffer, truncation: DiffTruncation | null): ForgeDiff => ({
  bytes: new Uint8Array(bytes),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  truncated: truncation !== null,
  truncation,
});

export type Credential =
  { readonly kind: "app" } | { readonly kind: "token"; readonly token: string };

export interface Exchange {
  readonly status: number;
  readonly contentType: string;
  /** `undefined` when the body was larger than the cap. */
  readonly bytes: Buffer | undefined;
  readonly headers: Headers;
}

export interface OpenInit {
  readonly accept?: string;
  readonly body?: unknown;
  readonly search?: Record<string, string>;
  readonly timeoutMs?: number;
  /** Only the archive asks for `manual`: its redirect is followed by hand, without the key. */
  readonly redirect?: "manual";
}

export interface GitHubHttp {
  readonly api: URL;
  open(
    method: "GET" | "POST" | "DELETE",
    path: string,
    credential: Credential,
    init: OpenInit,
  ): Promise<{ response: Response; signal: AbortSignal }>;
  /** One request whose body is read whole, up to `cap` bytes. */
  exchange(
    method: "GET" | "POST",
    path: string,
    credential: Credential,
    cap: number,
    init?: Pick<OpenInit, "body" | "search">,
  ): Promise<Exchange>;
  /** The JSON body of an answer that must be JSON within its cap. */
  json(answer: Exchange): unknown;
  isNotFound(answer: Exchange): boolean;
}

export interface GitHubHttpOptions {
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** The `authorization` header value for a credential (the App forge signs its JWT here). */
  readonly authorization: (credential: Credential) => string;
  /** Turn an exhausted rate limit into `rate_limited` (P10-4; off for installation tokens). */
  readonly rateLimits?: boolean;
}

/** GitHub's reset epoch (seconds) as a date, when it is one. */
const resetAt = (headers: Headers): Date | undefined => {
  const raw = headers.get("x-ratelimit-reset");
  if (raw === null || !/^[0-9]{1,12}$/.test(raw)) return undefined;
  return new Date(Number(raw) * 1000);
};

export const createGitHubHttp = (options: GitHubHttpOptions): GitHubHttp => {
  if (options.api.protocol !== "https:") throw new Error("GitHub API base must be https");
  const doFetch = options.fetch ?? fetch;

  const open: GitHubHttp["open"] = async (method, path, credential, init) => {
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
          authorization: options.authorization(credential),
          "x-github-api-version": "2022-11-28",
          "user-agent": "rocky-reviews",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: init.redirect ?? "error",
        signal,
      });
      return { response, signal };
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
  };

  const exchange: GitHubHttp["exchange"] = async (method, path, credential, cap, init = {}) => {
    const { response, signal } = await open(method, path, credential, init);
    let bytes: Buffer | undefined;
    try {
      bytes = await readCapped(response, cap);
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
    if (
      options.rateLimits === true &&
      (response.status === 403 || response.status === 429) &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      const at = resetAt(response.headers);
      throw new ForgeReadError(
        "rate_limited",
        response.status,
        at === undefined ? {} : { retryAt: at },
      );
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      bytes,
      headers: response.headers,
    };
  };

  const json: GitHubHttp["json"] = (answer) => {
    if (!JSON_TYPE.test(answer.contentType) || answer.bytes === undefined) {
      throw new ForgeReadError("invalid_response");
    }
    return decodeJson(answer.bytes);
  };

  const isNotFound: GitHubHttp["isNotFound"] = (answer) => {
    if (answer.status !== 404) return false;
    if (!NotFound.safeParse(json(answer)).success) throw new ForgeReadError("invalid_response");
    return true;
  };

  return { api: options.api, open, exchange, json, isNotFound };
};

export const decodePullRequest = (
  value: unknown,
  ref: { installationId: number | null; repositoryId: number; number: number },
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

export interface RepositorySessionOptions {
  readonly http: GitHubHttp;
  readonly repository: ForgeRepository;
  /**
   * The installation the reads are on behalf of, as the pull request refs carry it; `null` for
   * a personal token (P10-4: the mirror stores the ref's repository id and number only).
   */
  readonly installationId: number | null;
  /** The credential for the next read; may mint a fresh one (the App forge) or throw once closed. */
  readonly credential: () => Promise<Credential>;
  /** Revokes what must be revoked (installation tokens); a personal token is left alone. */
  readonly close: () => Promise<void>;
  readonly diffTimeoutMs?: number;
}

/** The pull request reads of one repository over `credential()` (ADR 0010 §2, §3). */
export const createRepositorySession = (options: RepositorySessionOptions): RepositorySession => {
  const { http, repository } = options;
  const ref = { installationId: options.installationId, repositoryId: repository.id };
  const base = `repos/${repoPath(repository.fullName)}`;
  let closed = false;

  const credential = (): Promise<Credential> => {
    if (closed) throw new Error("repository session is closed");
    return options.credential();
  };

  const getPullRequest = async (number: number): Promise<ForgePullRequest | null> => {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
      throw new Error("getPullRequest: invalid number");
    }
    const answer = await http.exchange(
      "GET",
      `${base}/pulls/${number}`,
      await credential(),
      MAX_PULL_REQUEST_RESPONSE_BYTES,
    );
    if (http.isNotFound(answer)) return null;
    if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
    return decodePullRequest(http.json(answer), { ...ref, number });
  };

  async function* listPullRequests(
    listOptions: { readonly state?: "all" | "open" } = {},
  ): AsyncIterable<ForgePullRequestSummary> {
    const state = listOptions.state ?? "all";
    if (state !== "all" && state !== "open") throw new Error("listPullRequests: invalid state");
    for (let page = 1; ; page++) {
      if (page > MAX_LIST_PAGES) throw new ForgeReadError("invalid_response");
      const answer = await http.exchange(
        "GET",
        `${base}/pulls`,
        await credential(),
        MAX_LIST_PAGE_BYTES,
        {
          search: {
            state,
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
      const parsed = PullRequestListJson.safeParse(http.json(answer));
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
    const { response, signal } = await http.open(
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
      const answer: Exchange = {
        status: response.status,
        contentType,
        bytes,
        headers: response.headers,
      };
      if (response.status === 406) {
        if (!TooLarge.safeParse(http.json(answer)).success) {
          throw new ForgeReadError("http_status", 406);
        }
        return reading(Buffer.alloc(0), "forge_limit");
      }
      if (http.isNotFound(answer) || response.status === 422) {
        http.json(answer);
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
      await options.close();
    },
  };
};
