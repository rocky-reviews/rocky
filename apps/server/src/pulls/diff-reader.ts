import { ForgeReadError, type Clock, type Forge } from "@rocky-reviews/core";
import { createHash } from "node:crypto";

/**
 * The pull request's diff, read from GitHub on demand for the file view (H4-3, ADR 0034). The
 * mirror does not store diff text (ADR 0010 §3), so the page's diff is read when a file is
 * opened, through the same forge adapter the worker's mirror and the analysis use:
 *
 * 1. `forge.openRepository` mints an installation token for that one repository id with
 *    `contents: read` and `pull_requests: read` (ADR 0010 §2: the answer is checked, or the
 *    token is revoked and refused; the token never leaves the adapter's closure);
 * 2. `GET /repos/{owner}/{repo}/pulls/{number}` must still name the mirror's head: a head that
 *    moved is `head_moved`, and no diff is read (a diff of another head is never served);
 * 3. `compare/{base}...{head}`, pinned to the mirror's revision (the base the analysis read; or
 *    GitHub's base when the mirror has no revision of the head yet), capped at the mirror's
 *    1 MiB (`max_bytes`: the prefix is then trimmed to whole files, `wholeFiles`); GitHub's
 *    refusal is `too_large`; commits it no longer has are `commits_unavailable`;
 * 4. the session is closed (the token revoked) in `finally`, whatever happened.
 *
 * **Cache.** A whole or cut diff is kept in memory for `DIFF_CACHE_TTL_MS` (one minute), keyed
 * by org, repository id, base and head, bounded by entries and bytes (oldest out), so a reload
 * or a second reviewer of the same revision costs no token. The route runs the member's
 * repository access check before every read, cache hit or not: the cache only saves the
 * GitHub calls, never a decision. Nothing but a diff is cached: a moved head, a refusal, a
 * missing diff and every failure are asked again. Concurrent reads of one key share one
 * session.
 *
 * The bytes are decoded as UTF-8 for display (lossy: a non-UTF-8 diff shows replacement
 * characters; the analysis refuses such a diff, so no drafts exist for it). Diff content is
 * untrusted and never logged; results carry sizes and digests for the route's log line.
 */

/** The mirror's cap (`MIRROR_DIFF_MAX_BYTES`, ADR 0010 §4; the analysis uses the same). */
export const PULL_REQUEST_DIFF_MAX_BYTES = 1024 * 1024;
export const DIFF_CACHE_TTL_MS = 60_000;
export const DIFF_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DIFF_CACHE_MAX_ENTRIES = 64;

export interface PullRequestDiffTarget {
  readonly orgId: string;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly number: number;
  /** The mirror's head: the diff served is this commit's, or nothing. */
  readonly headSha: string;
  /** The mirror's base for that head, or `null` before the revision is recorded. */
  readonly baseSha: string | null;
}

export type PullRequestDiffResult =
  | {
      readonly kind: "diff";
      readonly headSha: string;
      readonly diff: string;
      readonly truncation: "max_bytes" | null;
      /** Of the raw bytes read (before decoding), for the log line. */
      readonly bytes: number;
      readonly sha256: string;
      readonly cached: boolean;
    }
  /** GitHub's head is not the mirror's any more. */
  | { readonly kind: "head_moved" }
  /** GitHub has no diff for the mirror's commits (force-pushed away). */
  | { readonly kind: "commits_unavailable" }
  /** GitHub refuses to render a diff this large. */
  | { readonly kind: "too_large" }
  /** The installation cannot read the repository, or GitHub has no such pull request. */
  | { readonly kind: "not_found" }
  /** An outage or an answer that is not what was asked (`ForgeReadError.code`). */
  | { readonly kind: "forge_failed"; readonly code: string };

export interface PullRequestDiffReader {
  read(target: PullRequestDiffTarget): Promise<PullRequestDiffResult>;
}

export interface PullRequestDiffReaderOptions {
  readonly forge: Pick<Forge, "openRepository">;
  readonly clock?: Clock;
  /** 1 … `PULL_REQUEST_DIFF_MAX_BYTES` (default). */
  readonly maxBytes?: number;
  /** `false` turns the cache off; bounds default to the constants above and cannot exceed them. */
  readonly cache?:
    false | { readonly ttlMs?: number; readonly maxBytes?: number; readonly maxEntries?: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const MAX_NUMBER = 2_147_483_647;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

const invalidTarget = (): never => {
  throw new Error("pull request diff: invalid target");
};

const checkTarget = (target: PullRequestDiffTarget): void => {
  if (typeof target.orgId !== "string" || !UUID.test(target.orgId)) invalidTarget();
  if (!isId(target.installationId) || !isId(target.repositoryId)) invalidTarget();
  if (!isId(target.number) || target.number > MAX_NUMBER) invalidTarget();
  if (typeof target.headSha !== "string" || !SHA.test(target.headSha)) invalidTarget();
  if (target.baseSha !== null && (typeof target.baseSha !== "string" || !SHA.test(target.baseSha)))
    invalidTarget();
};

const bounded = (value: number | undefined, fallback: number, max: number, name: string) => {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > max) {
    throw new Error(`pull request diff: ${name} must be 1 to ${max}`);
  }
  return chosen;
};

type Cached = Extract<PullRequestDiffResult, { kind: "diff" }>;
type Entry = { readonly result: Cached; readonly expiresAt: number; readonly size: number };

/** The diff bytes are decoded lossily: display only (see the module comment). */
const utf8 = new TextDecoder("utf-8");

const FILE_HEADER = Buffer.from("diff --git ");

/**
 * A `max_bytes` prefix (cut at a line end by the adapter) ends inside some file, usually inside
 * a hunk, which the web app's strict reader refuses whole. Served instead: the prefix up to the
 * last file header, so every file shown is complete and the ones past the cut are simply absent
 * (the page says so). A file header is a line starting with `diff --git `; no hunk line can
 * start that way (they start with ` `, `+`, `-` or `\`). A cut inside the first file leaves an
 * empty, flagged diff.
 */
export const wholeFiles = (bytes: Uint8Array): Uint8Array => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const last = buffer.lastIndexOf(FILE_HEADER);
  if (last <= 0) return buffer.subarray(0, 0);
  // Only at a line start (`\n` before it); a header mid-line is content, so look further back.
  let at = last;
  while (at > 0 && buffer[at - 1] !== 0x0a) {
    at = buffer.lastIndexOf(FILE_HEADER, at - 1);
    if (at <= 0) return buffer.subarray(0, 0);
  }
  return buffer.subarray(0, at);
};

export const createPullRequestDiffReader = (
  options: PullRequestDiffReaderOptions,
): PullRequestDiffReader => {
  const clock = options.clock ?? { now: () => new Date() };
  const maxBytes = bounded(
    options.maxBytes,
    PULL_REQUEST_DIFF_MAX_BYTES,
    PULL_REQUEST_DIFF_MAX_BYTES,
    "maxBytes",
  );
  const cacheOptions = options.cache === false ? undefined : (options.cache ?? {});
  const ttlMs =
    cacheOptions === undefined
      ? 0
      : bounded(cacheOptions.ttlMs, DIFF_CACHE_TTL_MS, DIFF_CACHE_TTL_MS, "cache.ttlMs");
  const cacheMaxBytes =
    cacheOptions === undefined
      ? 0
      : bounded(
          cacheOptions.maxBytes,
          DIFF_CACHE_MAX_BYTES,
          DIFF_CACHE_MAX_BYTES,
          "cache.maxBytes",
        );
  const cacheMaxEntries =
    cacheOptions === undefined
      ? 0
      : bounded(
          cacheOptions.maxEntries,
          DIFF_CACHE_MAX_ENTRIES,
          DIFF_CACHE_MAX_ENTRIES,
          "cache.maxEntries",
        );

  // Insertion-ordered: the oldest entry is first. None of the key's parts can hold the separator.
  const cache = new Map<string, Entry>();
  let cacheBytes = 0;
  const inFlight = new Map<string, Promise<PullRequestDiffResult>>();

  const keyOf = (t: PullRequestDiffTarget): string =>
    `${t.orgId.toLowerCase()}|${t.repositoryId}|${t.baseSha ?? "-"}|${t.headSha}`;

  const drop = (key: string): void => {
    const entry = cache.get(key);
    if (entry === undefined) return;
    cache.delete(key);
    cacheBytes -= entry.size;
  };

  const lookup = (key: string, now: number): Cached | undefined => {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (now >= entry.expiresAt) {
      drop(key);
      return undefined;
    }
    return entry.result;
  };

  const store = (key: string, result: Cached, now: number): void => {
    if (cacheOptions === undefined) return;
    const size = result.diff.length;
    if (size > cacheMaxBytes) return;
    drop(key);
    // Make room: the oldest entries go first, whether the bound hit is bytes or count.
    while (cache.size > 0 && (cache.size >= cacheMaxEntries || cacheBytes + size > cacheMaxBytes)) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
    cache.set(key, { result, expiresAt: now + ttlMs, size });
    cacheBytes += size;
  };

  const readFromForge = async (target: PullRequestDiffTarget): Promise<PullRequestDiffResult> => {
    try {
      const session = await options.forge.openRepository({
        installationId: target.installationId,
        repositoryId: target.repositoryId,
      });
      if (session === null) return { kind: "not_found" };
      try {
        const pull = await session.getPullRequest(target.number);
        if (pull === null) return { kind: "not_found" };
        // A diff of another head than the page shows (and the drafts are anchored to) is never
        // served; the page says the PR changed and the mirror catches up on its own.
        if (pull.headSha !== target.headSha) return { kind: "head_moved" };
        const diff = await session.getDiff(
          { baseSha: target.baseSha ?? pull.baseSha, headSha: target.headSha },
          { maxBytes },
        );
        if (diff.truncation === "forge_limit") return { kind: "too_large" };
        if (diff.truncation === "unavailable") return { kind: "commits_unavailable" };
        const bytes = diff.truncation === "max_bytes" ? wholeFiles(diff.bytes) : diff.bytes;
        return {
          kind: "diff",
          headSha: target.headSha,
          diff: utf8.decode(bytes),
          truncation: diff.truncation,
          bytes: bytes.byteLength,
          sha256:
            bytes === diff.bytes ? diff.sha256 : createHash("sha256").update(bytes).digest("hex"),
          cached: false,
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      if (error instanceof ForgeReadError) return { kind: "forge_failed", code: error.code };
      throw error;
    }
  };

  return {
    read: async (target) => {
      checkTarget(target);
      const key = keyOf(target);
      const now = clock.now().getTime();
      const hit = lookup(key, now);
      if (hit !== undefined) return { ...hit, cached: true };
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const read = readFromForge(target)
        .then((result) => {
          if (result.kind === "diff") store(key, result, clock.now().getTime());
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, read);
      return read;
    },
  };
};
