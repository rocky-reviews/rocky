import {
  ForgeReadError,
  type ArchiveFile,
  type BlobRead,
  type Clock,
  type CodeReader,
  type CodeSession,
  type ForgeTree,
  type IndexTreeEntry,
  type Forge,
  type ForgeRepository,
  type RepositoryRef,
  type RepositorySession,
} from "@rocky-reviews/core";
import { z } from "zod";
import { githubAppJwt, type GitHubAppAuth } from "./app-auth.js";
import {
  Branch,
  createGitHubHttp,
  createRepositorySession,
  decodeRepository,
  ForgeId,
  isId,
  isRepositoryFullName,
  MAX_TOKEN_RESPONSE_BYTES,
  REPOSITORY_READ_TIMEOUT_MS,
  repoPath,
  Sha,
  type Credential,
  type Exchange,
  type GitHubHttp,
} from "./client.js";
import { isAbort, readCapped, readUpTo } from "./http.js";
import { createGitHubInstallationReader } from "./installations.js";
import { readTar } from "./tar.js";

export {
  DIFF_READ_TIMEOUT_MS,
  isRepositoryFullName,
  LIST_PAGE_SIZE,
  MAX_DIFF_BYTES,
  MAX_LIST_PAGES,
  REPOSITORY_READ_TIMEOUT_MS,
} from "./client.js";

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
 * The reads themselves (pull request, listing, diff) are `client.ts`'s `createRepositorySession`,
 * shared with the personal-token client since P10-4 (ADR 0045).
 */

export const MIRROR_TOKEN_PERMISSIONS: Readonly<Record<string, "read">> = Object.freeze({
  contents: "read",
  pull_requests: "read",
});
/**
 * The membership check (P3-6, ADR 0011 §2 step 3): `GET /repos/{owner}/{repo}/collaborators/
 * {username}` needs repository permission Metadata: read, and nothing else.
 */
export const COLLABORATOR_TOKEN_PERMISSIONS: Readonly<Record<string, "read">> = Object.freeze({
  metadata: "read",
});
/**
 * Reading code for the repository index (P9-1, ADR 0040 §5): `contents: read` only, narrower
 * than the mirror's token (no pull requests).
 */
export const CODE_TOKEN_PERMISSIONS: Readonly<Record<string, "read">> = Object.freeze({
  contents: "read",
});
/** A recursive tree listing larger than this is treated as truncated. */
export const MAX_TREE_BYTES = 64 * 1024 * 1024;
/** Entries a tree listing may hold (GitHub's own recursive limit is 100 000). */
export const MAX_TREE_ENTRIES = 200_000;
/** The archive download: one deadline for the whole stream. */
export const ARCHIVE_TIMEOUT_MS = 10 * 60_000;
/** Decompressed archive bytes and entries read before an archive is refused. */
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 1_000_000;
/** GitHub adds `metadata: read` to every installation token. */
const IMPLIED_PERMISSIONS: Readonly<Record<string, "read">> = { metadata: "read" };
/** A token this close to its expiry is replaced before the next read. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** The largest `maxBytes` a blob read may ask for (the same bound as a diff). */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const Count = z.int().min(0).max(2_147_483_647);
const Timestamp = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(Date.parse(v)));
/** An opaque bearer token: printable ASCII, bounded. Its format is GitHub's business. */
const Token = z.string().regex(/^[\x21-\x7e]{16,512}$/);
/** A GitHub user login: what `GET /user` returns for a user token (no `[bot]`). */
const USER_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const TokenJson = z.object({
  token: Token,
  expires_at: Timestamp,
  permissions: z.record(z.string(), z.string()),
  repositories: z.array(z.record(z.string(), z.unknown())).max(100),
});
/**
 * Printable ASCII without spaces, bounded: safe to put in an `authorization` header for the
 * revocation of a token that otherwise failed validation (no header injection).
 */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** Read first, so a token that comes with an unacceptable answer can still be revoked. */
const TokenOnly = z.object({ token: Token });
const InstallationJson = z.object({
  id: ForgeId,
  suspended_at: z.string().max(64).nullable().optional(),
});
const RepositorySizeJson = z.object({ id: ForgeId, size: Count.optional() });
const RefJson = z.object({ object: z.object({ sha: Sha, type: z.literal("commit") }) });
const TreeJson = z.object({
  sha: Sha,
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        mode: z.string().max(16),
        type: z.string().max(16),
        sha: Sha,
        size: Count.optional(),
      }),
    )
    .max(MAX_TREE_ENTRIES),
});
/** Regular files (plain and executable); symlinks (120000) and submodules (160000) are not code. */
const FILE_MODES = new Set(["100644", "100755"]);
const RAW_TYPE = /^application\/(?:vnd\.github\.raw|octet-stream)\b/i;

export interface GitHubForgeOptions {
  readonly auth: GitHubAppAuth;
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly diffTimeoutMs?: number;
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
export const createGitHubForge = (options: GitHubForgeOptions): Forge & CodeReader => {
  const doFetch = options.fetch ?? fetch;
  const installations = createGitHubInstallationReader(options);
  const http: GitHubHttp = createGitHubHttp({
    api: options.api,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    authorization: (credential) =>
      credential.kind === "app"
        ? `Bearer ${githubAppJwt(options.auth, options.clock.now())}`
        : `Bearer ${credential.token}`,
  });

  /** Best effort: a token that cannot be revoked still expires within the hour. */
  const revoke = async (token: string): Promise<void> => {
    try {
      const { response } = await http.open(
        "DELETE",
        "installation/token",
        { kind: "token", token },
        {},
      );
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Ignored: see above.
    }
  };

  /** True when the granted permissions are within what was asked for (read only). */
  const withinScope = (
    granted: Record<string, string>,
    asked: Readonly<Record<string, "read">>,
  ): boolean =>
    Object.entries(granted).every(
      ([name, level]) =>
        level === "read" &&
        (Object.hasOwn(asked, name) || Object.hasOwn(IMPLIED_PERMISSIONS, name)),
    );

  /**
   * Mints a read-only token for one repository of `installationId`. `null` when GitHub says the
   * installation is gone (JSON 404) or the repository is not one it can access (422).
   */
  const mint = async (
    installationId: number,
    scope: { readonly repositoryId: number } | { readonly name: string },
    permissions: Readonly<Record<string, "read">> = MIRROR_TOKEN_PERMISSIONS,
  ): Promise<Minted | null> => {
    const answer = await http.exchange(
      "POST",
      `app/installations/${installationId}/access_tokens`,
      { kind: "app" },
      MAX_TOKEN_RESPONSE_BYTES,
      {
        body: {
          ...("repositoryId" in scope
            ? { repository_ids: [scope.repositoryId] }
            : { repositories: [scope.name] }),
          permissions,
        },
      },
    );
    if (http.isNotFound(answer)) return null;
    if (answer.status === 422) {
      http.json(answer);
      return null;
    }
    if (answer.status !== 201) throw new ForgeReadError("http_status", answer.status);
    // A 201 whose body is not JSON (or is over the cap) yields nothing that could be revoked:
    // refused as is; such a token, if one was issued, expires within GitHub's hour (review
    // round 3, N1).
    const body = http.json(answer);
    const issued = TokenOnly.safeParse(body);
    if (!issued.success) {
      // A token that fails validation but is header-safe is still revoked before refusing.
      const loose = (body as { token?: unknown } | null)?.token;
      if (typeof loose === "string" && HEADER_SAFE_TOKEN.test(loose)) await revoke(loose);
      throw new ForgeReadError("invalid_response");
    }
    const token = issued.data.token;
    let repository: ForgeRepository;
    let expiresAt: number;
    try {
      const parsed = TokenJson.safeParse(body);
      if (!parsed.success) throw new ForgeReadError("invalid_response");
      const { repositories } = parsed.data;
      if (!withinScope(parsed.data.permissions, permissions) || repositories.length !== 1) {
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

  /**
   * The credential for the next read of a session: the current token, replaced through `mint`
   * when it is about to expire (the old one revoked). `null` from `mint` means access was lost
   * mid-session (uninstalled, repository removed from the installation).
   */
  const refreshing = (
    ref: RepositoryRef,
    first: Minted,
    permissions: Readonly<Record<string, "read">>,
  ) => {
    let current = first;
    return {
      credential: async (): Promise<Credential> => {
        if (current.expiresAt - options.clock.now().getTime() < TOKEN_REFRESH_MARGIN_MS) {
          const next = await mint(
            ref.installationId,
            { repositoryId: ref.repositoryId },
            permissions,
          );
          if (next === null) throw new ForgeReadError("http_status", 404);
          const previous = current.token;
          current = next;
          await revoke(previous);
        }
        return { kind: "token", token: current.token };
      },
      close: () => revoke(current.token),
    };
  };

  const session = (ref: RepositoryRef, first: Minted): RepositorySession => {
    const tokens = refreshing(ref, first, MIRROR_TOKEN_PERMISSIONS);
    return createRepositorySession({
      http,
      repository: first.repository,
      installationId: ref.installationId,
      credential: tokens.credential,
      close: tokens.close,
      ...(options.diffTimeoutMs === undefined ? {} : { diffTimeoutMs: options.diffTimeoutMs }),
    });
  };

  /**
   * Where GitHub may send an archive download: its codeload host (`codeload.github.com` next to
   * `api.github.com`), or the API's own host (GitHub Enterprise Server). Anything else is refused,
   * so a redirect cannot carry the request to a host of an attacker's choosing.
   */
  const archiveHostAllowed = (location: URL): boolean => {
    if (location.protocol !== "https:" || location.username !== "" || location.password !== "") {
      return false;
    }
    const apiHost = options.api.hostname;
    const apex = apiHost.startsWith("api.") ? apiHost.slice(4) : apiHost;
    return location.hostname === apiHost || location.hostname === `codeload.${apex}`;
  };

  const codeSession = (ref: RepositoryRef, first: Minted): CodeSession => {
    const tokens = refreshing(ref, first, CODE_TOKEN_PERMISSIONS);
    let closed = false;
    const repository = first.repository;
    const base = `repos/${repoPath(repository.fullName)}`;

    const credential = (): Promise<Credential> => {
      if (closed) throw new Error("code session is closed");
      return tokens.credential();
    };

    const checkSha = (sha: string, where: string): void => {
      if (!Sha.safeParse(sha).success) throw new Error(`${where}: invalid sha`);
    };

    const branchHead = async (branch: string): Promise<string | null> => {
      if (!Branch.safeParse(branch).success) throw new Error("branchHead: invalid branch");
      const path = branch
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const answer = await http.exchange(
        "GET",
        `${base}/git/ref/heads/${path}`,
        await credential(),
        MAX_TOKEN_RESPONSE_BYTES,
      );
      if (http.isNotFound(answer)) return null;
      if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
      const parsed = RefJson.safeParse(http.json(answer));
      if (!parsed.success) throw new ForgeReadError("invalid_response");
      return parsed.data.object.sha;
    };

    const repositorySizeKb = async (): Promise<number | null> => {
      const answer = await http.exchange("GET", base, await credential(), MAX_TOKEN_RESPONSE_BYTES);
      if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
      const parsed = RepositorySizeJson.safeParse(http.json(answer));
      if (!parsed.success || parsed.data.id !== repository.id) {
        throw new ForgeReadError("invalid_response");
      }
      return parsed.data.size ?? null;
    };

    const readTree = async (commitSha: string): Promise<ForgeTree | null> => {
      checkSha(commitSha, "readTree");
      const answer = await http.exchange(
        "GET",
        `${base}/git/trees/${commitSha}`,
        await credential(),
        MAX_TREE_BYTES,
        { search: { recursive: "1" } },
      );
      // Too large to read: the caller indexes from the archive instead.
      if (answer.status === 200 && answer.bytes === undefined) {
        return { commitSha, entries: [], truncated: true };
      }
      if (http.isNotFound(answer) || answer.status === 422) return null;
      if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
      const parsed = TreeJson.safeParse(http.json(answer));
      if (!parsed.success) throw new ForgeReadError("invalid_response");
      const entries: IndexTreeEntry[] = [];
      for (const item of parsed.data.tree) {
        if (item.type !== "blob" || !FILE_MODES.has(item.mode)) continue;
        // A blob without a size is not one GitHub lists; refuse rather than guess.
        if (item.size === undefined) throw new ForgeReadError("invalid_response");
        entries.push({ path: item.path, blobSha: item.sha, size: item.size });
      }
      return { commitSha, entries, truncated: parsed.data.truncated };
    };

    const readBlob = async (
      blobSha: string,
      blobOptions: { readonly maxBytes: number },
    ): Promise<BlobRead> => {
      checkSha(blobSha, "readBlob");
      const maxBytes = blobOptions.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BLOB_BYTES) {
        throw new Error("readBlob: invalid maxBytes");
      }
      const { response, signal } = await http.open(
        "GET",
        `${base}/git/blobs/${blobSha}`,
        await credential(),
        {
          accept: "application/vnd.github.raw+json",
        },
      );
      const contentType = response.headers.get("content-type") ?? "";
      try {
        if (response.status === 200) {
          if (!RAW_TYPE.test(contentType)) {
            await response.body?.cancel().catch(() => undefined);
            throw new ForgeReadError("invalid_response");
          }
          const { bytes, overflow } = await readUpTo(response, maxBytes);
          return overflow ? { kind: "too_large" } : { kind: "ok", bytes: new Uint8Array(bytes) };
        }
        const bytes = await readCapped(response, MAX_TOKEN_RESPONSE_BYTES);
        const answer: Exchange = {
          status: response.status,
          contentType,
          bytes,
          headers: response.headers,
        };
        if (http.isNotFound(answer)) return { kind: "not_found" };
        throw new ForgeReadError("http_status", response.status);
      } catch (error) {
        if (error instanceof ForgeReadError) throw error;
        if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
        throw new ForgeReadError("network");
      }
    };

    async function* readArchive(
      commitSha: string,
      archiveOptions: { readonly maxFileBytes: number; readonly wanted: (path: string) => boolean },
    ): AsyncIterable<ArchiveFile> {
      checkSha(commitSha, "readArchive");
      const { response: first } = await http.open(
        "GET",
        `${base}/tarball/${commitSha}`,
        await credential(),
        {
          redirect: "manual",
          timeoutMs: options.timeoutMs ?? REPOSITORY_READ_TIMEOUT_MS,
        },
      );
      let archive: Response;
      if (first.status === 302 || first.status === 307) {
        await first.body?.cancel().catch(() => undefined);
        let location: URL;
        try {
          location = new URL(first.headers.get("location") ?? "", options.api);
        } catch {
          throw new ForgeReadError("invalid_response");
        }
        if (!archiveHostAllowed(location)) throw new ForgeReadError("invalid_response");
        // The redirect URL carries its own short-lived grant: the installation token is not sent.
        try {
          archive = await doFetch(location.href, {
            method: "GET",
            headers: { "user-agent": "rocky-reviews" },
            redirect: "error",
            signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
          });
        } catch (error) {
          throw new ForgeReadError(isAbort(error) ? "timeout" : "network");
        }
      } else if (first.status === 200) {
        archive = first;
      } else {
        const bytes = await readCapped(first, MAX_TOKEN_RESPONSE_BYTES);
        const answer: Exchange = {
          status: first.status,
          contentType: first.headers.get("content-type") ?? "",
          bytes,
          headers: first.headers,
        };
        if (http.isNotFound(answer)) throw new ForgeReadError("http_status", 404);
        throw new ForgeReadError("http_status", first.status);
      }
      if (archive.status !== 200 || archive.body === null) {
        await archive.body?.cancel().catch(() => undefined);
        throw new ForgeReadError("http_status", archive.status);
      }
      try {
        yield* readTar(archive.body.pipeThrough(new DecompressionStream("gzip")), {
          maxFileBytes: archiveOptions.maxFileBytes,
          wanted: archiveOptions.wanted,
          maxTotalBytes: MAX_ARCHIVE_BYTES,
          maxEntries: MAX_ARCHIVE_ENTRIES,
        });
      } catch (error) {
        if (error instanceof ForgeReadError) throw error;
        if (isAbort(error)) throw new ForgeReadError("timeout");
        // A gzip or stream failure: a broken archive, whatever the cause said.
        throw new ForgeReadError("invalid_response");
      }
    }

    return {
      repository,
      branchHead,
      repositorySizeKb,
      readTree,
      readBlob,
      readArchive,
      close: async () => {
        if (closed) return;
        closed = true;
        await tokens.close();
      },
    };
  };

  const openCode = async (ref: RepositoryRef): Promise<CodeSession | null> => {
    if (!isId(ref.installationId) || !isId(ref.repositoryId)) {
      throw new Error("openCode: invalid ids");
    }
    const minted = await mint(
      ref.installationId,
      { repositoryId: ref.repositoryId },
      CODE_TOKEN_PERMISSIONS,
    );
    return minted === null ? null : codeSession(ref, minted);
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
    const answer = await http.exchange(
      "GET",
      `repos/${repoPath(fullName)}/installation`,
      { kind: "app" },
      MAX_TOKEN_RESPONSE_BYTES,
    );
    if (http.isNotFound(answer)) return null;
    if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
    const installation = InstallationJson.safeParse(http.json(answer));
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

  /**
   * Membership, not effective access (P3-6 review round 2, ADR 0011 §2 step 3): is `login` a
   * collaborator of the repository? Asked with an installation token minted for this one
   * repository with `metadata: read` only (checked like every mint: exactly this repository, no
   * wider permission, or revoked and refused), revoked as soon as the answer is read. The URL
   * uses the name GitHub gave for this repository id in the mint answer, never Rocky's copy.
   * GitHub answers 204 for a collaborator (any role, any affiliation) and its JSON 404 otherwise.
   * `false` also when the installation is gone or cannot access the repository; anything else
   * throws `ForgeReadError`.
   */
  const isCollaborator = async (ref: RepositoryRef, login: string): Promise<boolean> => {
    if (!isId(ref.installationId) || !isId(ref.repositoryId)) {
      throw new Error("isCollaborator: invalid ids");
    }
    if (typeof login !== "string" || !USER_LOGIN.test(login)) {
      throw new Error("isCollaborator: invalid login");
    }
    const minted = await mint(
      ref.installationId,
      { repositoryId: ref.repositoryId },
      COLLABORATOR_TOKEN_PERMISSIONS,
    );
    if (minted === null) return false;
    try {
      const answer = await http.exchange(
        "GET",
        `repos/${repoPath(minted.repository.fullName)}/collaborators/${encodeURIComponent(login)}`,
        { kind: "token", token: minted.token },
        MAX_TOKEN_RESPONSE_BYTES,
      );
      if (answer.status === 204) return true;
      if (http.isNotFound(answer)) return false;
      throw new ForgeReadError("http_status", answer.status);
    } finally {
      await revoke(minted.token);
    }
  };

  return { ...installations, openRepository, openCode, locateRepository, isCollaborator };
};
