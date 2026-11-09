import {
  CHARS_PER_TOKEN,
  classifyPath,
  embeddingInput,
  embeddingTokens,
  ForgeReadError,
  INDEX_LIMITS,
  isLlmCallError,
  LlmMeteringError,
  planIndexRun,
  type Clock,
  type CodeReader,
  type CodeSession,
  type EmbeddingRoleClient,
  type EmbeddingSpace,
  type IndexSkipReason,
  type IndexTreeEntry,
  type LlmRoles,
  type StoredIndexFile,
} from "@rocky-reviews/core";
import {
  beginCodeIndexRun,
  CODE_INDEX_MAX_HASHES,
  CODE_INDEX_MAX_PATHS,
  CodeIndexLeaseLostError,
  finishCodeIndex,
  loadCodeIndexTarget,
  recordLlmUsage,
  removeIndexedFiles,
  renewCodeIndexLease,
  reusableVectors,
  storedIndexFiles,
  writeIndexedFiles,
  type ClaimedCodeIndex,
  type CodeIndexOutcome,
  type Db,
  type IndexedFileWrite,
} from "@rocky-reviews/db";
import {
  gitBlobSha,
  prepareFile,
  type FileChunker,
  type PreparedChunk,
} from "@rocky-reviews/indexer";
import { meterRoles, type LlmUsageTargets } from "@rocky-reviews/llm";
import type { Logger } from "@rocky-reviews/log";
import { retryDelaySeconds } from "./inbox.js";

/**
 * One repository index run (P9-1, ADR 0040), claimed from `code_indexes` by the index lane:
 *
 * 1. the lease's target (`loadCodeIndexTarget`); a repository whose reviews are off is not read;
 * 2. a code session on the one repository (a `contents: read` token scoped to it, revoked at the
 *    end) and the default branch's head now: the event's commit is a hint, GitHub is the truth;
 * 3. the space check (`beginCodeIndexRun`): another embedding model than the stored one empties
 *    the index first, so this run is a full one;
 * 4. the commit's tree against what the index holds (`planIndexRun`): only new or changed blobs
 *    are fetched, paths that are gone or no longer eligible are removed. A first run is the same
 *    plan with nothing stored. A truncated tree listing (a very large repository) is replaced by
 *    one archive download, whose files are compared by blob id as they stream;
 * 5. the estimate against the token limit (or the "Index anyway" approval): over it, the row
 *    waits for a person (`over_limit`) before anything is fetched or embedded;
 * 6. files in batches: fetched (single blobs for a few, one archive for many), chunked, chunks
 *    whose text the index already embedded in this space reuse their vector, the rest are
 *    embedded through the metered embed role (`llm_usage`, per org), and written with the lease
 *    checked. The run stops as `over_limit` if the real spend passes the limit by a quarter;
 * 7. removals, then `done` at the commit read.
 *
 * Logs carry ids, counts and codes; never paths, code, chunk text, vectors or tokens.
 */

/** Files per write; chunks per embedding call (the providers' batch limits are 128 and up). */
export const INDEX_FILE_BATCH = 64;
export const INDEX_EMBED_BATCH = 128;
/** Up to this many changed files are read one blob at a time; more, from one archive. */
export const INDEX_BLOB_FETCH_MAX = 200;
/** Blob reads in flight. */
export const INDEX_FETCH_CONCURRENCY = 8;
/** The lease a run holds, renewed whenever a third of it has passed. */
export const INDEX_LEASE_SECONDS = 15 * 60;
/** The real spend may pass the limit by this fraction before the run stops (sizes estimate). */
export const INDEX_SPEND_SLACK = 0.25;

export interface CodeIndexDeps {
  readonly db: Db;
  readonly forge: CodeReader;
  /** The configured roles; the run meters them per org. */
  readonly llm: LlmRoles;
  readonly usageTargets: LlmUsageTargets;
  /** The embed role's space (`ROCKY_LLM_EMBED_*`). */
  readonly space: EmbeddingSpace;
  readonly chunker: FileChunker;
  readonly log: Logger;
  readonly clock?: Clock;
  /** Tokens one run may embed without an approval. */
  readonly tokenLimit: number;
  readonly fileBatch?: number;
  readonly embedBatch?: number;
  readonly blobFetchMax?: number;
  readonly leaseSeconds?: number;
}

export type CodeIndexRunOutcome =
  "done" | "queued" | "over_limit" | "failed" | "retry" | "lease_lost";

export interface CodeIndexRunReport {
  readonly outcome: CodeIndexRunOutcome;
  readonly errorCode?: string;
  readonly filesWritten: number;
  readonly chunksWritten: number;
  readonly chunksEmbedded: number;
  readonly chunksReused: number;
  readonly filesRemoved: number;
  readonly spentTokens: number;
  readonly fullRun: boolean;
}

/** A file to fetch: from the tree (blob known) or from an archive listing (blob from bytes). */
interface Fetched {
  readonly path: string;
  readonly blobSha: string;
  readonly bytes: Uint8Array | "too_large";
}

class OverLimit extends Error {
  constructor(readonly estimatedTokens: number) {
    super("index: over the token limit");
  }
}

/**
 * Tokens a whole repository would cost to embed, from the size the forge reports (KiB). The
 * forge's size counts the stored repository (compressed, with history), so this is a rough upper
 * bound for source and a rough figure for anything else; it only gates a truncated full run.
 */
export const sizeTokens = (sizeKb: number): number =>
  Math.min(Math.ceil((sizeKb * 1024) / CHARS_PER_TOKEN), 2_147_483_647);

const SAFE_CODE = /^(?:[0-9A-Z]{5}|[a-z][a-z0-9_]{0,63})$/;

const codeOf = (error: unknown): string => {
  if (error instanceof ForgeReadError) {
    return error.status === undefined ? `forge_${error.reason}` : `forge_http_${error.status}`;
  }
  if (isLlmCallError(error)) return `llm_${error.kind}`;
  if (error instanceof LlmMeteringError) return "llm_usage_unrecorded";
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : "internal_error";
};

/** Outages are retried; a property of the answer or of the configuration fails the run. */
const isTransient = (error: unknown): boolean => {
  if (error instanceof ForgeReadError) return error.transient;
  if (isLlmCallError(error)) return error.retryable;
  if (error instanceof LlmMeteringError) return false;
  const code = codeOf(error);
  return /^(?:08|40|53|57|58)[0-9A-Z]{3}$/.test(code) || code === "internal_error";
};

/** Runs `task` over `items` with at most `limit` in flight, results in input order. */
const mapLimited = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await task(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return out;
};

export const runCodeIndex = async (
  deps: CodeIndexDeps,
  claim: ClaimedCodeIndex,
  options: { readonly signal?: AbortSignal } = {},
): Promise<CodeIndexRunReport> => {
  const { db, log, space } = deps;
  const { orgId, indexId } = claim;
  const clock = deps.clock ?? { now: () => new Date() };
  const fileBatch = deps.fileBatch ?? INDEX_FILE_BATCH;
  const embedBatch = deps.embedBatch ?? INDEX_EMBED_BATCH;
  const blobFetchMax = deps.blobFetchMax ?? INDEX_BLOB_FETCH_MAX;
  const leaseSeconds = deps.leaseSeconds ?? INDEX_LEASE_SECONDS;
  const counts = {
    filesWritten: 0,
    chunksWritten: 0,
    chunksEmbedded: 0,
    chunksReused: 0,
    filesRemoved: 0,
    spentTokens: 0,
    fullRun: false,
  };
  const report = (outcome: CodeIndexRunOutcome, errorCode?: string): CodeIndexRunReport => ({
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...counts,
  });
  const finish = async (outcome: CodeIndexOutcome): Promise<CodeIndexRunReport> => {
    const status = await db.withOrg(orgId, (tx) => finishCodeIndex(tx, claim, outcome));
    if (status === "lost") return report("lease_lost");
    const errorCode =
      outcome.kind === "failed" || outcome.kind === "retry" ? outcome.errorCode : undefined;
    const result = report(
      outcome.kind === "retry" ? (status === "failed" ? "failed" : "retry") : status,
      errorCode,
    );
    log.info({ indexId, attempt: claim.attempts, ...result }, "code index run finished");
    return result;
  };

  const target = await db.withOrg(orgId, (tx) => loadCodeIndexTarget(tx, claim));
  if (target === undefined) return report("lease_lost");
  if (!target.enabled) return finish({ kind: "failed", errorCode: "repository_disabled" });

  const embedder: EmbeddingRoleClient | undefined = meterRoles(deps.llm, {
    // Its own transaction per call: usage survives whatever happens to the run.
    sink: { record: (records) => db.withOrg(orgId, (tx) => recordLlmUsage(tx, records)) },
    targets: deps.usageTargets,
    log,
    clock,
    // The row names the repository it was indexed for (P9-3, migration 0023).
    repoId: target.repoId,
  }).embedding();
  if (embedder === undefined) return finish({ kind: "failed", errorCode: "embeddings_off" });

  const limit = Math.max(deps.tokenLimit, target.approvedTokens ?? 0);
  const hardCap = Math.ceil(limit * (1 + INDEX_SPEND_SLACK));
  let renewedAt = clock.now().getTime();
  const keepLease = async (): Promise<void> => {
    if (clock.now().getTime() - renewedAt < (leaseSeconds * 1000) / 3) return;
    if (!(await db.withOrg(orgId, (tx) => renewCodeIndexLease(tx, claim, leaseSeconds)))) {
      throw new CodeIndexLeaseLostError();
    }
    renewedAt = clock.now().getTime();
  };

  let session: CodeSession | null = null;
  try {
    session = await deps.forge.openCode({
      installationId: target.installationId,
      repositoryId: target.forgeRepoId,
    });
    if (session === null)
      return await finish({ kind: "failed", errorCode: "repository_inaccessible" });
    const code = session;
    const head = await code.branchHead(target.defaultBranch);
    if (head === null) return await finish({ kind: "failed", errorCode: "branch_not_found" });

    const { reset } = await db.withOrg(orgId, (tx) => beginCodeIndexRun(tx, claim, space));
    counts.fullRun = reset || target.indexedSha === null;
    if (!reset && target.indexedSha === head) {
      return await finish({ kind: "done", indexedSha: head, spentTokens: 0 });
    }
    const tree = await code.readTree(head);
    if (tree === null) return await finish({ kind: "failed", errorCode: "commit_not_found" });
    const stored = await db.withOrg(orgId, (tx) => storedIndexFiles(tx, target.repoId));

    // --- What to fetch -----------------------------------------------------------------------
    let files: AsyncIterable<Fetched>;
    let removals: () => readonly string[];
    if (!tree.truncated) {
      const plan = planIndexRun(tree.entries, stored);
      if (plan.estimatedTokens > limit) {
        return await finish({
          kind: "over_limit",
          estimatedTokens: plan.estimatedTokens,
          limitTokens: limit,
        });
      }
      files =
        plan.fetch.length <= blobFetchMax
          ? fromBlobs(code, plan.fetch)
          : fromArchive(code, head, plan.fetch);
      removals = () => plan.remove;
    } else {
      // The listing is incomplete, so the plan cannot estimate. A full run (nothing stored, or
      // another space) is bounded by the repository's size before anything is downloaded: over
      // the limit, or of unknown size, it waits for a person. An incremental run embeds only what
      // changed, and stays bounded by the running cap.
      if (counts.fullRun && target.approvedTokens === null) {
        const sizeKb = await code.repositorySizeKb();
        const estimatedTokens = sizeKb === null ? limit + 1 : sizeTokens(sizeKb);
        if (estimatedTokens > limit) {
          return await finish({ kind: "over_limit", estimatedTokens, limitTokens: limit });
        }
      }
      // One archive is the listing, compared by blob id as it streams.
      const seen = new Set<string>();
      files = fromFullArchive(code, head, stored, seen);
      removals = () => stored.map((f) => f.path).filter((path) => !seen.has(path));
    }

    // --- Fetch, chunk, embed, write ----------------------------------------------------------
    let pending: Fetched[] = [];
    const flush = async (): Promise<void> => {
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      options.signal?.throwIfAborted();
      await keepLease();
      await writeBatch(batch);
    };

    const writeBatch = async (batch: readonly Fetched[]): Promise<void> => {
      const writes: IndexedFileWrite[] = [];
      const prepared: {
        readonly file: Fetched;
        readonly language: string;
        readonly chunks: readonly PreparedChunk[];
      }[] = [];
      for (const file of batch) {
        if (file.bytes === "too_large") {
          writes.push(skipped(file, "too_large"));
          continue;
        }
        const result = await prepareFile(deps.chunker, file.path, file.bytes);
        if (result.kind === "skip") writes.push(skipped(file, result.reason));
        else if (result.chunks.length === 0) writes.push(skipped(file, "empty"));
        else prepared.push({ file, language: result.language, chunks: result.chunks });
      }
      const hashes = [...new Set(prepared.flatMap((p) => p.chunks.map((c) => c.inputSha256)))];
      // A batch can hold more hashes than one lookup takes (64 files × 500 chunks).
      const known = new Map<string, number[]>();
      for (let i = 0; i < hashes.length; i += CODE_INDEX_MAX_HASHES) {
        const slice = hashes.slice(i, i + CODE_INDEX_MAX_HASHES);
        const found = await db.withOrg(orgId, (tx) =>
          reusableVectors(tx, target.repoId, space, slice),
        );
        for (const [hash, vector] of found) known.set(hash, vector);
      }
      // Chunks to embed, once per distinct input (path and text) in the batch.
      const toEmbed = new Map<string, string>();
      for (const p of prepared) {
        for (const draft of p.chunks) {
          if (!known.has(draft.inputSha256) && !toEmbed.has(draft.inputSha256)) {
            toEmbed.set(draft.inputSha256, embeddingInput(p.file.path, draft));
          }
        }
      }
      const entries = [...toEmbed.entries()];
      for (let i = 0; i < entries.length; i += embedBatch) {
        const slice = entries.slice(i, i + embedBatch);
        const inputs = slice.map(([, input]) => input);
        const estimate = embeddingTokens(inputs);
        if (counts.spentTokens + estimate > hardCap) {
          throw new OverLimit(counts.spentTokens + estimate);
        }
        const result = await embedder.embed({
          inputs,
          purpose: "document",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.vectors.length !== inputs.length) {
          throw Object.assign(new Error("index: vector count mismatch"), {
            code: "llm_vector_count",
          });
        }
        counts.spentTokens += result.usage?.inputTokens ?? estimate;
        counts.chunksEmbedded += inputs.length;
        slice.forEach(([hash], j) => {
          const vector = result.vectors[j];
          if (vector !== undefined) known.set(hash, [...vector]);
        });
        await keepLease();
      }
      for (const p of prepared) {
        writes.push({
          path: p.file.path,
          blobSha: p.file.blobSha,
          language: p.language,
          status: "indexed",
          chunks: p.chunks.map((draft, ordinal) => {
            const vector = known.get(draft.inputSha256);
            if (vector === undefined) throw new Error("index: vector missing");
            return {
              ordinal,
              startLine: draft.startLine,
              endLine: draft.endLine,
              kind: draft.kind,
              inputSha256: draft.inputSha256,
              vector,
            };
          }),
        });
      }
      counts.chunksReused += prepared.reduce((n, p) => n + p.chunks.length, 0) - toEmbed.size;
      // Writes of at most CODE_INDEX_MAX_WRITE_CHUNKS chunks each (a batch of 64 files can hold
      // 64 × 500), each in its own lease-checked transaction.
      let group: IndexedFileWrite[] = [];
      let groupChunks = 0;
      const writeGroup = async (): Promise<void> => {
        if (group.length === 0) return;
        const written = await db.withOrg(orgId, (tx) =>
          writeIndexedFiles(tx, claim, target.repoId, space, group),
        );
        counts.filesWritten += written.files;
        counts.chunksWritten += written.chunks;
        group = [];
        groupChunks = 0;
      };
      for (const write of writes) {
        if (groupChunks + write.chunks.length > 5_000) await writeGroup();
        group.push(write);
        groupChunks += write.chunks.length;
      }
      await writeGroup();
    };

    for await (const file of files) {
      pending.push(file);
      if (pending.length >= fileBatch) await flush();
    }
    await flush();

    // --- Removals and the end ----------------------------------------------------------------
    const gone = removals();
    for (let i = 0; i < gone.length; i += CODE_INDEX_MAX_PATHS) {
      const slice = gone.slice(i, i + CODE_INDEX_MAX_PATHS);
      counts.filesRemoved += await db.withOrg(orgId, (tx) =>
        removeIndexedFiles(tx, claim, target.repoId, slice),
      );
    }
    return await finish({ kind: "done", indexedSha: head, spentTokens: counts.spentTokens });
  } catch (error) {
    if (error instanceof CodeIndexLeaseLostError) {
      log.warn({ indexId, attempt: claim.attempts }, "code index lease lost");
      return report("lease_lost");
    }
    if (error instanceof OverLimit) {
      return finish({
        kind: "over_limit",
        estimatedTokens: error.estimatedTokens,
        limitTokens: limit,
      });
    }
    const errorCode = codeOf(error);
    if (options.signal?.aborted === true || isTransient(error)) {
      return finish({ kind: "retry", errorCode, delaySeconds: retryDelaySeconds(claim.attempts) });
    }
    return finish({ kind: "failed", errorCode });
  } finally {
    await session?.close().catch(() => undefined);
  }
};

const skipped = (file: Fetched, reason: IndexSkipReason): IndexedFileWrite => ({
  path: file.path,
  blobSha: file.blobSha,
  // A skipped file has no parsed language; the column records "none".
  language: "none",
  status: "skipped",
  skipReason: reason,
  chunks: [],
});

/** A few changed files: one blob read each, a few in flight. A blob that is gone is left out. */
async function* fromBlobs(
  code: CodeSession,
  entries: readonly IndexTreeEntry[],
): AsyncIterable<Fetched> {
  for (let i = 0; i < entries.length; i += INDEX_FILE_BATCH) {
    const slice = entries.slice(i, i + INDEX_FILE_BATCH);
    const reads = await mapLimited(slice, INDEX_FETCH_CONCURRENCY, (entry) =>
      code.readBlob(entry.blobSha, { maxBytes: INDEX_LIMITS.maxFileBytes }),
    );
    for (const [j, read] of reads.entries()) {
      const entry = slice[j];
      if (entry === undefined || read.kind === "not_found") continue;
      yield {
        path: entry.path,
        blobSha: entry.blobSha,
        bytes: read.kind === "too_large" ? "too_large" : read.bytes,
      };
    }
  }
}

/** Many changed files: one archive download, keeping only the planned paths. */
async function* fromArchive(
  code: CodeSession,
  commitSha: string,
  entries: readonly IndexTreeEntry[],
): AsyncIterable<Fetched> {
  const wanted = new Map(entries.map((e) => [e.path, e.blobSha]));
  for await (const file of code.readArchive(commitSha, {
    maxFileBytes: INDEX_LIMITS.maxFileBytes,
    wanted: (path) => wanted.has(path),
  })) {
    const blobSha = wanted.get(file.path);
    if (blobSha === undefined) continue;
    wanted.delete(file.path);
    yield { path: file.path, blobSha, bytes: file.bytes ?? "too_large" };
  }
}

/**
 * A truncated listing: the archive lists the commit. Paths eligible by name are compared with
 * the stored blob (computed from the bytes) and yielded only when changed; `seen` collects every
 * eligible path, so what the index holds beyond it is removed afterwards.
 */
async function* fromFullArchive(
  code: CodeSession,
  commitSha: string,
  stored: readonly StoredIndexFile[],
  seen: Set<string>,
): AsyncIterable<Fetched> {
  const storedBlob = new Map(stored.map((f) => [f.path, f.blobSha]));
  for await (const file of code.readArchive(commitSha, {
    maxFileBytes: INDEX_LIMITS.maxFileBytes,
    // By name only here (a size of 1: not empty, not too large); the size is checked below.
    wanted: (path) => classifyPath(path, 1).kind !== "skip",
  })) {
    if (file.bytes === null || classifyPath(file.path, file.size).kind === "skip") continue;
    seen.add(file.path);
    const blobSha = gitBlobSha(file.bytes);
    if (storedBlob.get(file.path) === blobSha) continue;
    yield { path: file.path, blobSha, bytes: file.bytes };
  }
}
