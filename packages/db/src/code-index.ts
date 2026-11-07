import {
  INDEX_LIMITS,
  INDEX_VECTOR_DIMENSIONS,
  isSameSpace,
  toIndexVector,
  type EmbeddingSpace,
  type IndexSkipReason,
  type OrgId,
  type StoredIndexFile,
} from "@rocky-reviews/core";
import { audit, type AuditActor } from "./audit.js";
import type { TenantTx } from "./client.js";

/**
 * The repository index (P9-1, migration 0022, ADR 0040). Every function runs inside `withOrg`
 * (RLS) and filters by `tx.orgId` as well, as the other modules do; only the claim is
 * cross-tenant (`worker.claim_code_indexes`, `Db.claimCodeIndexes`, worker login only).
 *
 * One `code_indexes` row per repository moves `queued` → `running` (claimed with a lease) →
 * `done` | `failed` | `over_limit`, or back to `queued` (a retry, or a push that arrived while it
 * ran: every enqueue bumps `generation`, and a run that finishes behind it queues itself again).
 * Every write of a run checks its lease first and locks the row, so a run whose lease was lost
 * (expired and reclaimed) cannot write over its successor.
 *
 * What is stored: paths, blob ids, line ranges, node kinds, a sha256 per chunk and the vectors,
 * each with its embedding space. Never the code itself (ADR 0040 §5): a reader re-fetches a
 * chunk's text from the forge by its blob id.
 */

export class CodeIndexStoreError extends Error {
  override readonly name = "CodeIndexStoreError";
  /** A SQLSTATE when the database refused (the claim); never a message. */
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** The run no longer holds its lease: stop, write nothing more. */
export class CodeIndexLeaseLostError extends Error {
  override readonly name = "CodeIndexLeaseLostError";
  constructor() {
    super("code index: lease lost");
  }
}

/** Claims of one row after which it fails instead of retrying (mirrors migration 0022). */
export const CODE_INDEX_MAX_ATTEMPTS = 5;
/** A claim gives up after this long, waiting for the claim lock included. */
export const CODE_INDEX_CLAIM_STATEMENT_TIMEOUT_MS = 5_000;
/** The longest retry delay `finishCodeIndex` accepts. */
export const CODE_INDEX_MAX_RETRY_DELAY_SECONDS = 6 * 60 * 60;
/** Files per `writeIndexedFiles` call, and chunks across them. */
export const CODE_INDEX_MAX_WRITE_FILES = 500;
export const CODE_INDEX_MAX_WRITE_CHUNKS = 20_000;
/** Paths per `removeIndexedFiles` call; content hashes per `reusableVectors` call. */
export const CODE_INDEX_MAX_PATHS = 20_000;
export const CODE_INDEX_MAX_HASHES = 20_000;
/** Nearest chunks one search returns at most. */
export const CODE_SEARCH_MAX_K = 100;
/**
 * Up to this many vectors in a repository's space, `auto` search scans them all (exact, and fast
 * enough: a sequential scan of 20k 1024-wide vectors is a few milliseconds of distance math);
 * beyond it, the HNSW index with an iterative, filtered scan (ADR 0040 §3).
 */
export const CODE_SEARCH_EXACT_MAX_VECTORS = 20_000;

/** Messages name the field, never the value. */
const invalid = (field: string): never => {
  throw new CodeIndexStoreError(`code index: invalid ${field}`);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^(?:[0-9A-Z]{5}|[a-z][a-z0-9_]{0,63})$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const LANGUAGE = /^[a-z][a-z0-9_+-]{0,31}$/;
const KIND = /^[a-z][a-z0-9_]{0,63}$/;
const SKIP_REASONS: ReadonlySet<string> = new Set([
  "binary",
  "generated",
  "empty",
  "too_large",
  "unsupported",
  "invalid_path",
  "vendored",
]);

const checkId = (value: unknown, field: string): void => {
  if (typeof value !== "string" || !UUID.test(value)) invalid(field);
};

const checkCount = (value: unknown, field: string, max = 2_147_483_647): void => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    invalid(field);
  }
};

const checkSpace = (space: EmbeddingSpace): void => {
  if (typeof space !== "object" || space === null) invalid("embedding space");
  if (typeof space.provider !== "string" || !PROVIDER.test(space.provider)) invalid("provider");
  if (typeof space.model !== "string" || !MODEL.test(space.model)) invalid("model");
  if (
    !Number.isInteger(space.dimensions) ||
    space.dimensions < 1 ||
    space.dimensions > INDEX_VECTOR_DIMENSIONS
  ) {
    invalid("dimensions");
  }
};

const checkPath = (path: unknown): void => {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > INDEX_LIMITS.maxPathBytes ||
    path.startsWith("/") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    invalid("path");
  }
};

/** pgvector's text form; the values were checked finite by `toIndexVector`. */
const vectorLiteral = (vector: readonly number[]): string => `[${vector.join(",")}]`;

/** pgvector's text output back to numbers, cut to the space's own width. */
const parseVector = (text: string, dimensions: number): number[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== INDEX_VECTOR_DIMENSIONS) invalid("vector");
  return (parsed as number[]).slice(0, dimensions);
};

// --- The claim ---------------------------------------------------------------------------------

/** What a worker holds while it runs one row. Only the current holder can write or finish. */
export interface CodeIndexLease {
  readonly indexId: string;
  readonly leaseId: string;
}

/** One row handed out by the claim. */
export interface ClaimedCodeIndex extends CodeIndexLease {
  readonly orgId: OrgId;
  /** Claims so far, this one included (1 on the first). */
  readonly attempts: number;
  /** The request this run serves; a newer one queues the row again when it finishes. */
  readonly generation: number;
  /** When the lease runs out (database clock), unless renewed. */
  readonly leaseUntil: Date;
}

export interface CodeIndexClaimOptions {
  /** Rows per claim (the database clamps to 1..20; one per org). */
  readonly limit: number;
  /** Lease length (the database clamps to 60..3600 s); renewed while the run lasts. */
  readonly leaseSeconds: number;
}

export const claimCodeIndexesSql = (
  options: CodeIndexClaimOptions,
): { readonly text: string; readonly values: unknown[] } => {
  for (const value of [options.limit, options.leaseSeconds]) {
    if (!Number.isInteger(value)) invalid("claim bounds");
  }
  return {
    text: `select org_id, index_id, lease_id::text as lease_id, attempts, generation, lease_until
             from worker.claim_code_indexes($1, $2)`,
    values: [options.limit, options.leaseSeconds],
  };
};

export interface ClaimedCodeIndexRow {
  org_id: string;
  index_id: string;
  lease_id: string;
  attempts: number;
  generation: number;
  lease_until: Date;
}

export const claimedCodeIndexFromRow = (row: ClaimedCodeIndexRow): ClaimedCodeIndex => ({
  orgId: row.org_id as OrgId,
  indexId: row.index_id,
  leaseId: row.lease_id,
  attempts: row.attempts,
  generation: row.generation,
  leaseUntil: row.lease_until,
});

const checkLease = (lease: CodeIndexLease): void => {
  if (typeof lease !== "object" || lease === null) invalid("lease");
  checkId(lease.indexId, "index id");
  checkId(lease.leaseId, "lease");
};

// --- Queue -------------------------------------------------------------------------------------

/**
 * Asks for an index of one repository of `tx.orgId` at `requestedSha` (null: the default
 * branch's head when the run starts). One row per repository: a queued, finished or failed row
 * is queued again; a running one keeps running and, because the generation moves, queues itself
 * again when it finishes. An earlier "index anyway" approval does not carry over.
 */
export const enqueueCodeIndex = async (
  tx: TenantTx,
  repoId: string,
  requestedSha: string | null,
): Promise<{ readonly indexId: string; readonly generation: number }> => {
  checkId(repoId, "repository id");
  if (
    requestedSha !== null &&
    (typeof requestedSha !== "string" || !OBJECT_ID.test(requestedSha))
  ) {
    invalid("requested sha");
  }
  const { rows } = await tx.query<{ id: string; generation: number }>(
    `insert into code_indexes (repo_id, requested_sha) values ($1, $2)
     on conflict (org_id, repo_id) do update set
       requested_sha = excluded.requested_sha,
       generation = code_indexes.generation + 1,
       status = case when code_indexes.status = 'running' then 'running' else 'queued' end,
       available_at = case when code_indexes.status = 'running' then code_indexes.available_at
                           else now() end,
       attempts = case when code_indexes.status = 'running' then code_indexes.attempts else 0 end,
       error_code = case when code_indexes.status = 'running' then code_indexes.error_code end,
       approved_tokens = case when code_indexes.status = 'running'
                              then code_indexes.approved_tokens end,
       updated_at = now()
     returning id, generation`,
    [repoId, requestedSha],
  );
  const row = rows[0];
  if (row === undefined) throw new CodeIndexStoreError("code index: row missing");
  return { indexId: row.id, generation: row.generation };
};

/**
 * "Index anyway": a person lets an over-limit index run once, up to its estimate. Audited.
 * False when the repository's index is not waiting on the limit.
 */
export const approveCodeIndex = async (
  tx: TenantTx,
  repoId: string,
  actor: AuditActor,
): Promise<boolean> => {
  checkId(repoId, "repository id");
  const { rows } = await tx.query<{ id: string; estimated_tokens: number; limit_tokens: number }>(
    `update code_indexes
        set status = 'queued', approved_tokens = greatest(estimated_tokens, 1),
            available_at = now(), attempts = 0, error_code = null, updated_at = now()
      where org_id = $1 and repo_id = $2 and status = 'over_limit'
      returning id, estimated_tokens, limit_tokens`,
    [tx.orgId, repoId],
  );
  const row = rows[0];
  if (row === undefined) return false;
  await audit(
    tx,
    actor,
    "code_index.limit_overridden",
    { type: "repo", id: repoId },
    { indexId: row.id, estimatedTokens: row.estimated_tokens, tokenLimit: row.limit_tokens },
  );
  return true;
};

/** What the index of one repository holds and is doing; ids, commits and counts only. */
export interface CodeIndexState {
  readonly indexId: string;
  readonly status: "queued" | "running" | "done" | "failed" | "over_limit";
  readonly generation: number;
  readonly requestedSha: string | null;
  readonly indexedSha: string | null;
  readonly space: EmbeddingSpace | null;
  readonly errorCode: string | null;
  readonly estimatedTokens: number | null;
  readonly limitTokens: number | null;
  readonly approvedTokens: number | null;
  readonly filesIndexed: number;
  readonly chunksIndexed: number;
  readonly spentTokens: number;
  readonly completedAt: Date | null;
}

interface StateRow {
  id: string;
  status: CodeIndexState["status"];
  generation: number;
  requested_sha: string | null;
  indexed_sha: string | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  error_code: string | null;
  estimated_tokens: number | null;
  limit_tokens: number | null;
  approved_tokens: number | null;
  files_indexed: number;
  chunks_indexed: number;
  spent_tokens: number;
  completed_at: Date | null;
}

const STATE_COLUMNS = `i.id, i.status, i.generation, i.requested_sha, i.indexed_sha,
  i.embedding_provider, i.embedding_model, i.embedding_dimensions, i.error_code,
  i.estimated_tokens, i.limit_tokens, i.approved_tokens, i.files_indexed, i.chunks_indexed,
  i.spent_tokens, i.completed_at`;

const spaceOf = (row: StateRow): EmbeddingSpace | null =>
  row.embedding_provider === null ||
  row.embedding_model === null ||
  row.embedding_dimensions === null
    ? null
    : {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
      };

const stateOf = (row: StateRow): CodeIndexState => ({
  indexId: row.id,
  status: row.status,
  generation: row.generation,
  requestedSha: row.requested_sha,
  indexedSha: row.indexed_sha,
  space: spaceOf(row),
  errorCode: row.error_code,
  estimatedTokens: row.estimated_tokens,
  limitTokens: row.limit_tokens,
  approvedTokens: row.approved_tokens,
  filesIndexed: row.files_indexed,
  chunksIndexed: row.chunks_indexed,
  spentTokens: row.spent_tokens,
  completedAt: row.completed_at,
});

/** The index of one repository of `tx.orgId`, or undefined when it was never asked for. */
export const codeIndexState = async (
  tx: TenantTx,
  repoId: string,
): Promise<CodeIndexState | undefined> => {
  checkId(repoId, "repository id");
  const { rows } = await tx.query<StateRow>(
    `select ${STATE_COLUMNS} from code_indexes i where i.org_id = $1 and i.repo_id = $2`,
    [tx.orgId, repoId],
  );
  return rows[0] === undefined ? undefined : stateOf(rows[0]);
};

// --- A run -------------------------------------------------------------------------------------

/** What a run needs: the repository on the forge and what the index already holds. */
export interface CodeIndexTarget {
  readonly indexId: string;
  readonly repoId: string;
  readonly forgeRepoId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** False: reviews of the repository are off; its index is not refreshed. */
  readonly enabled: boolean;
  readonly installationId: number;
  readonly requestedSha: string | null;
  readonly indexedSha: string | null;
  readonly space: EmbeddingSpace | null;
  /** "Index anyway": this run may spend up to this many tokens over the limit (null: none). */
  readonly approvedTokens: number | null;
}

/**
 * The target of a row this lease holds (`running`, same token, lease not expired), or undefined
 * when the lease is no longer held (expired and reclaimed, finished, or not this org's: RLS).
 */
export const loadCodeIndexTarget = async (
  tx: TenantTx,
  lease: CodeIndexLease,
): Promise<CodeIndexTarget | undefined> => {
  checkLease(lease);
  const { rows } = await tx.query<
    StateRow & {
      repo_id: string;
      forge_repo_id: string;
      full_name: string;
      default_branch: string;
      enabled: boolean;
      installation_id: string;
    }
  >(
    `select ${STATE_COLUMNS}, r.id as repo_id, r.forge_repo_id, r.full_name, r.default_branch,
            r.enabled, o.installation_id
       from code_indexes i
       join repos r on r.org_id = $1 and r.id = i.repo_id
       join orgs o on o.id = $1
      where i.org_id = $1 and i.id = $2 and i.status = 'running' and i.lease_id = $3
        and i.lease_until > now()`,
    [tx.orgId, lease.indexId, lease.leaseId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const forgeRepoId = Number(row.forge_repo_id);
  const installationId = Number(row.installation_id);
  if (!Number.isSafeInteger(forgeRepoId) || forgeRepoId < 1) invalid("repository id");
  if (!Number.isSafeInteger(installationId) || installationId < 1) invalid("installation id");
  return {
    indexId: row.id,
    repoId: row.repo_id,
    forgeRepoId,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    enabled: row.enabled,
    installationId,
    requestedSha: row.requested_sha,
    indexedSha: row.indexed_sha,
    space: spaceOf(row),
    approvedTokens: row.approved_tokens,
  };
};

/**
 * Locks the row this lease holds (FOR UPDATE: a reclaim waits for this transaction) and returns
 * its repository and space; throws `CodeIndexLeaseLostError` when the lease is not held.
 */
const holdLease = async (
  tx: TenantTx,
  lease: CodeIndexLease,
): Promise<{ readonly repoId: string; readonly space: EmbeddingSpace | null }> => {
  checkLease(lease);
  const { rows } = await tx.query<StateRow & { repo_id: string }>(
    `select ${STATE_COLUMNS}, i.repo_id from code_indexes i
      where i.org_id = $1 and i.id = $2 and i.status = 'running' and i.lease_id = $3
        and i.lease_until > now()
      for update`,
    [tx.orgId, lease.indexId, lease.leaseId],
  );
  const row = rows[0];
  if (row === undefined) throw new CodeIndexLeaseLostError();
  return { repoId: row.repo_id, space: spaceOf(row) };
};

const holdRepoLease = async (
  tx: TenantTx,
  lease: CodeIndexLease,
  repoId: string,
): Promise<EmbeddingSpace | null> => {
  checkId(repoId, "repository id");
  const held = await holdLease(tx, lease);
  if (held.repoId !== repoId) invalid("repository id");
  return held.space;
};

/** Extends the lease while the run lasts; false when it is no longer held. */
export const renewCodeIndexLease = async (
  tx: TenantTx,
  lease: CodeIndexLease,
  leaseSeconds: number,
): Promise<boolean> => {
  checkLease(lease);
  if (!Number.isInteger(leaseSeconds)) invalid("lease seconds");
  const seconds = Math.min(Math.max(leaseSeconds, 60), 3600);
  const { rowCount } = await tx.query(
    `update code_indexes set lease_until = now() + make_interval(secs => $4), updated_at = now()
      where org_id = $1 and id = $2 and status = 'running' and lease_id = $3
        and lease_until > now()`,
    [tx.orgId, lease.indexId, lease.leaseId, seconds],
  );
  return rowCount === 1;
};

/**
 * Starts a run in `space`. When the index holds another space (or none), everything it holds
 * is removed first, so vectors of two spaces never sit side by side in one repository's index:
 * switching the embedding model is a full re-index (ADR 0040 §2).
 */
export const beginCodeIndexRun = async (
  tx: TenantTx,
  lease: CodeIndexLease,
  space: EmbeddingSpace,
): Promise<{ readonly reset: boolean }> => {
  checkSpace(space);
  const held = await holdLease(tx, lease);
  if (isSameSpace(space, held.space)) return { reset: false };
  await tx.query("delete from code_files where org_id = $1 and repo_id = $2", [
    tx.orgId,
    held.repoId,
  ]);
  // Vectors not tied to a chunk (none today) would be left alone; chunk vectors cascade above.
  await tx.query(
    `update code_indexes
        set embedding_provider = $3, embedding_model = $4, embedding_dimensions = $5,
            indexed_sha = null, files_indexed = 0, chunks_indexed = 0, updated_at = now()
      where org_id = $1 and id = $2`,
    [tx.orgId, lease.indexId, space.provider, space.model, space.dimensions],
  );
  return { reset: true };
};

/** Every path the index holds for one repository, with the blob it was read from. */
export const storedIndexFiles = async (
  tx: TenantTx,
  repoId: string,
): Promise<StoredIndexFile[]> => {
  checkId(repoId, "repository id");
  const { rows } = await tx.query<{ path: string; blob_sha: string }>(
    "select path, blob_sha from code_files where org_id = $1 and repo_id = $2",
    [tx.orgId, repoId],
  );
  return rows.map((r) => ({ path: r.path, blobSha: r.blob_sha }));
};

/**
 * Vectors already stored in `space` for chunks of this repository with these input hashes
 * (hex sha256 of path and text), keyed by hash: an unchanged function in a changed file is not
 * embedded again; the same text under another path is (its input differs).
 */
export const reusableVectors = async (
  tx: TenantTx,
  repoId: string,
  space: EmbeddingSpace,
  inputHashes: readonly string[],
): Promise<Map<string, number[]>> => {
  checkId(repoId, "repository id");
  checkSpace(space);
  if (!Array.isArray(inputHashes) || inputHashes.length > CODE_INDEX_MAX_HASHES) {
    invalid("input hashes");
  }
  for (const h of inputHashes) if (typeof h !== "string" || !SHA256_HEX.test(h)) invalid("hash");
  const out = new Map<string, number[]>();
  if (inputHashes.length === 0) return out;
  const { rows } = await tx.query<{ hash: string; vector: string }>(
    `select distinct on (c.input_sha256) encode(c.input_sha256, 'hex') as hash,
            e.embedding::text as vector
       from code_chunks c
       join embeddings e on e.org_id = c.org_id and e.code_chunk_id = c.id
      where c.org_id = $1 and c.repo_id = $2
        and c.input_sha256 = any (select decode(h, 'hex') from unnest($3::text[]) as h)
        and e.provider = $4 and e.model = $5 and e.dimensions = $6`,
    [tx.orgId, repoId, [...new Set(inputHashes)], space.provider, space.model, space.dimensions],
  );
  for (const row of rows) out.set(row.hash, parseVector(row.vector, space.dimensions));
  return out;
};

/** One chunk to store: where it is, the hash of its embedded input, and its vector in the run's space. */
export interface IndexedChunkWrite {
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  /** Hex sha256 of the embedded input: the path, a newline, the chunk's text. */
  readonly inputSha256: string;
  /** Exactly the space's `dimensions` wide. */
  readonly vector: readonly number[];
}

/** One file to store: indexed with its chunks, or skipped (kept so it is not fetched again). */
export type IndexedFileWrite =
  | {
      readonly path: string;
      readonly blobSha: string;
      readonly language: string;
      readonly status: "indexed";
      readonly chunks: readonly IndexedChunkWrite[];
    }
  | {
      readonly path: string;
      readonly blobSha: string;
      readonly language: string;
      readonly status: "skipped";
      readonly skipReason: IndexSkipReason;
      readonly chunks: readonly [];
    };

const checkFile = (file: IndexedFileWrite): void => {
  if (typeof file !== "object" || file === null) invalid("file");
  checkPath(file.path);
  if (typeof file.blobSha !== "string" || !OBJECT_ID.test(file.blobSha)) invalid("blob sha");
  if (typeof file.language !== "string" || !LANGUAGE.test(file.language)) invalid("language");
  if (!Array.isArray(file.chunks) || file.chunks.length > INDEX_LIMITS.maxChunksPerFile) {
    invalid("chunks");
  }
  if (file.status === "skipped") {
    if (!SKIP_REASONS.has(file.skipReason) || file.chunks.length > 0) invalid("skip reason");
    return;
  }
  if (file.status !== "indexed") invalid("status");
  file.chunks.forEach((chunk, i) => {
    if (chunk.ordinal !== i) invalid("ordinal");
    checkCount(chunk.startLine, "start line");
    checkCount(chunk.endLine, "end line");
    if (chunk.startLine < 1 || chunk.endLine < chunk.startLine) invalid("line range");
    if (typeof chunk.kind !== "string" || !KIND.test(chunk.kind)) invalid("kind");
    if (typeof chunk.inputSha256 !== "string" || !SHA256_HEX.test(chunk.inputSha256)) {
      invalid("input hash");
    }
  });
};

/**
 * Stores files for this run (replacing whatever the index held at the same paths) with their
 * chunks and vectors. The run's lease is checked and its row locked first; the space must be the
 * one `beginCodeIndexRun` set. Returns how many files and chunks were written.
 */
export const writeIndexedFiles = async (
  tx: TenantTx,
  lease: CodeIndexLease,
  repoId: string,
  space: EmbeddingSpace,
  files: readonly IndexedFileWrite[],
): Promise<{ readonly files: number; readonly chunks: number }> => {
  checkSpace(space);
  if (!Array.isArray(files) || files.length > CODE_INDEX_MAX_WRITE_FILES) invalid("files");
  let chunkTotal = 0;
  const paths = new Set<string>();
  for (const file of files) {
    checkFile(file);
    if (paths.has(file.path)) invalid("duplicate path");
    paths.add(file.path);
    chunkTotal += file.chunks.length;
  }
  if (chunkTotal > CODE_INDEX_MAX_WRITE_CHUNKS) invalid("chunks");
  // Vectors are checked before anything is written.
  // An all-zero vector has no direction (cosine distance NaN): refused, as a query vector is.
  const vectors = files.flatMap((f) =>
    f.chunks.map((c) => {
      const padded = toIndexVector(c.vector, space.dimensions);
      if (!padded.some((v) => v !== 0)) invalid("vector");
      return vectorLiteral(padded);
    }),
  );
  const held = await holdRepoLease(tx, lease, repoId);
  if (!isSameSpace(space, held)) invalid("embedding space");
  if (files.length === 0) return { files: 0, chunks: 0 };

  await tx.query("delete from code_files where org_id = $1 and repo_id = $2 and path = any ($3)", [
    tx.orgId,
    repoId,
    [...paths],
  ]);
  const inserted = await tx.query<{ id: string; path: string }>(
    `insert into code_files (repo_id, path, blob_sha, language, status, skip_reason, chunk_count)
     select $1, f.path, f.blob_sha, f.language, f.status, f.skip_reason, f.chunk_count
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[])
         as f (path, blob_sha, language, status, skip_reason, chunk_count)
     returning id, path`,
    [
      repoId,
      files.map((f) => f.path),
      files.map((f) => f.blobSha),
      files.map((f) => f.language),
      files.map((f) => f.status),
      files.map((f) => (f.status === "skipped" ? f.skipReason : null)),
      files.map((f) => f.chunks.length),
    ],
  );
  if (chunkTotal === 0) return { files: inserted.rowCount ?? 0, chunks: 0 };
  const fileIds = new Map(inserted.rows.map((r) => [r.path, r.id]));
  const chunkFiles: string[] = [];
  const ordinals: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const kinds: string[] = [];
  const hashes: string[] = [];
  for (const file of files) {
    const fileId = fileIds.get(file.path);
    if (fileId === undefined) throw new CodeIndexStoreError("code index: file row missing");
    for (const chunk of file.chunks) {
      chunkFiles.push(fileId);
      ordinals.push(chunk.ordinal);
      starts.push(chunk.startLine);
      ends.push(chunk.endLine);
      kinds.push(chunk.kind);
      hashes.push(chunk.inputSha256);
    }
  }
  // `with ordinality` keeps the input order, so the n-th vector belongs to the n-th chunk.
  const { rowCount } = await tx.query(
    `with input as (
       select * from unnest($2::uuid[], $3::int[], $4::int[], $5::int[], $6::text[], $7::text[],
                            $8::text[])
         with ordinality as c (file_id, ordinal, start_line, end_line, kind, hash, vector, n)
     ), chunks as (
       insert into code_chunks (repo_id, file_id, ordinal, start_line, end_line, kind,
                                input_sha256)
       select $1, file_id, ordinal, start_line, end_line, kind, decode(hash, 'hex') from input
       returning id, file_id, ordinal
     )
     insert into embeddings (repo_id, source_kind, source_ref, provider, model, dimensions,
                             code_chunk_id, embedding)
     select $1, 'code_chunk', c.id::text, $9, $10, $11, c.id, i.vector::vector
       from chunks c join input i on i.file_id = c.file_id and i.ordinal = c.ordinal`,
    [
      repoId,
      chunkFiles,
      ordinals,
      starts,
      ends,
      kinds,
      hashes,
      vectors,
      space.provider,
      space.model,
      space.dimensions,
    ],
  );
  if (rowCount !== chunkTotal) throw new CodeIndexStoreError("code index: chunk rows missing");
  return { files: inserted.rowCount ?? 0, chunks: chunkTotal };
};

/**
 * Removes paths from the index (deleted, renamed away, or no longer eligible); their chunks and
 * vectors cascade. Lease-checked. Returns how many files were removed.
 */
export const removeIndexedFiles = async (
  tx: TenantTx,
  lease: CodeIndexLease,
  repoId: string,
  paths: readonly string[],
): Promise<number> => {
  if (!Array.isArray(paths) || paths.length > CODE_INDEX_MAX_PATHS) invalid("paths");
  for (const path of paths) checkPath(path);
  await holdRepoLease(tx, lease, repoId);
  if (paths.length === 0) return 0;
  const { rowCount } = await tx.query(
    "delete from code_files where org_id = $1 and repo_id = $2 and path = any ($3)",
    [tx.orgId, repoId, [...new Set(paths)]],
  );
  return rowCount ?? 0;
};

/** How a run ends. */
export type CodeIndexOutcome =
  | { readonly kind: "done"; readonly indexedSha: string; readonly spentTokens: number }
  | {
      readonly kind: "over_limit";
      readonly estimatedTokens: number;
      readonly limitTokens: number;
    }
  | { readonly kind: "failed"; readonly errorCode: string }
  | { readonly kind: "retry"; readonly errorCode: string; readonly delaySeconds: number };

/**
 * Ends a run. `done` and `failed` queue the row again instead when a newer request arrived
 * while it ran (its generation moved); `retry` after `CODE_INDEX_MAX_ATTEMPTS` claims is
 * `failed`. Returns the status the row is left in, or `lost` when the lease is not held.
 */
export const finishCodeIndex = async (
  tx: TenantTx,
  claim: ClaimedCodeIndex,
  outcome: CodeIndexOutcome,
): Promise<"done" | "queued" | "failed" | "over_limit" | "lost"> => {
  checkLease(claim);
  if (!Number.isInteger(claim.generation) || claim.generation < 1) invalid("generation");
  let set: string;
  let values: unknown[];
  switch (outcome.kind) {
    case "done":
      if (typeof outcome.indexedSha !== "string" || !OBJECT_ID.test(outcome.indexedSha)) {
        invalid("indexed sha");
      }
      checkCount(outcome.spentTokens, "spent tokens");
      set = `status = case when generation > $4 then 'queued' else 'done' end,
             indexed_sha = $5, spent_tokens = $6, error_code = null,
             estimated_tokens = null, limit_tokens = null, approved_tokens = null,
             attempts = case when generation > $4 then 0 else attempts end,
             files_indexed = (select count(*) from code_files f
                               where f.org_id = $1 and f.repo_id = code_indexes.repo_id
                                 and f.status = 'indexed'),
             chunks_indexed = (select count(*) from code_chunks c
                                where c.org_id = $1 and c.repo_id = code_indexes.repo_id)`;
      values = [outcome.indexedSha, outcome.spentTokens];
      break;
    case "over_limit":
      checkCount(outcome.estimatedTokens, "estimated tokens");
      checkCount(outcome.limitTokens, "token limit");
      if (outcome.limitTokens < 1) invalid("token limit");
      set = `status = 'over_limit', estimated_tokens = $5, limit_tokens = $6,
             approved_tokens = null`;
      values = [outcome.estimatedTokens, outcome.limitTokens];
      break;
    case "failed":
      if (typeof outcome.errorCode !== "string" || !ERROR_CODE.test(outcome.errorCode)) {
        invalid("error code");
      }
      set = `status = case when generation > $4 then 'queued' else 'failed' end,
             attempts = case when generation > $4 then 0 else attempts end,
             error_code = $5`;
      values = [outcome.errorCode];
      break;
    case "retry":
      if (typeof outcome.errorCode !== "string" || !ERROR_CODE.test(outcome.errorCode)) {
        invalid("error code");
      }
      checkCount(outcome.delaySeconds, "retry delay", CODE_INDEX_MAX_RETRY_DELAY_SECONDS);
      set = `status = case when attempts >= ${CODE_INDEX_MAX_ATTEMPTS} then 'failed'
                           else 'queued' end,
             error_code = $5,
             available_at = now() + make_interval(secs => $6)`;
      values = [outcome.errorCode, outcome.delaySeconds];
      break;
    default:
      return invalid("outcome");
  }
  const { rows } = await tx.query<{ status: "done" | "queued" | "failed" | "over_limit" }>(
    `update code_indexes
        set ${set}, lease_id = null, lease_until = null, completed_at = now(), updated_at = now()
      where org_id = $1 and id = $2 and status = 'running' and lease_id = $3
        and $4::int > 0
      returning status`,
    [tx.orgId, claim.indexId, claim.leaseId, claim.generation, ...values],
  );
  return rows[0]?.status ?? "lost";
};

// --- Search (for P9-2) ---------------------------------------------------------------------------

export interface CodeSearchQuery {
  readonly repoId: string;
  /** The space the query vector was made in; only vectors of the same space are compared. */
  readonly space: EmbeddingSpace;
  /** Exactly the space's `dimensions` wide (made with purpose `query`). */
  readonly vector: readonly number[];
  /** 1..`CODE_SEARCH_MAX_K`. */
  readonly k: number;
  /** `auto` (default): exact up to `CODE_SEARCH_EXACT_MAX_VECTORS`, approximate beyond. */
  readonly mode?: "auto" | "exact" | "approximate";
}

/** A nearest chunk: where it is. Its text is re-fetched from the forge by blob id. */
export interface CodeSearchHit {
  readonly chunkId: string;
  readonly path: string;
  readonly blobSha: string;
  readonly language: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  /** Cosine similarity, -1..1 (1: same direction). */
  readonly score: number;
}

interface HitRow {
  chunk_id: string;
  path: string;
  blob_sha: string;
  language: string;
  start_line: number;
  end_line: number;
  kind: string;
  score: number;
}

const HIT_COLUMNS = `ch.id as chunk_id, f.path, f.blob_sha, f.language, ch.start_line,
  ch.end_line, ch.kind, 1 - (e.embedding <=> $6::vector) as score`;

/**
 * The `k` chunks of one repository of `tx.orgId` nearest to a query vector, in one space,
 * nearest first. The filter is explicit (org, repository, space) on top of RLS.
 */
export const searchCodeChunks = async (
  tx: TenantTx,
  query: CodeSearchQuery,
): Promise<CodeSearchHit[]> => {
  if (typeof query !== "object" || query === null) invalid("query");
  checkId(query.repoId, "repository id");
  checkSpace(query.space);
  if (!Number.isInteger(query.k) || query.k < 1 || query.k > CODE_SEARCH_MAX_K) invalid("k");
  const padded = toIndexVector(query.vector, query.space.dimensions);
  if (!padded.some((v) => v !== 0)) invalid("query vector");
  const mode = query.mode ?? "auto";
  if (mode !== "auto" && mode !== "exact" && mode !== "approximate") invalid("mode");
  const values = [
    tx.orgId,
    query.repoId,
    query.space.provider,
    query.space.model,
    query.space.dimensions,
    vectorLiteral(padded),
    query.k,
  ];
  const filter = `e.org_id = $1 and e.repo_id = $2 and e.provider = $3 and e.model = $4
    and e.dimensions = $5 and e.code_chunk_id is not null`;
  const joins = `join code_chunks ch on ch.org_id = e.org_id and ch.id = e.code_chunk_id
    join code_files f on f.org_id = ch.org_id and f.id = ch.file_id`;

  // Exact: the filtered rows first (materialized, so the planner cannot reach for the HNSW
  // index and drop rows its candidate list missed), then every distance.
  const exact = async (): Promise<HitRow[]> =>
    (
      await tx.query<HitRow>(
        `with candidates as materialized (
           select e.id, e.org_id, e.code_chunk_id, e.embedding from embeddings e where ${filter}
         )
         select ${HIT_COLUMNS} from candidates e ${joins}
          order by e.embedding <=> $6::vector, ch.id
          limit $7`,
        values,
      )
    ).rows;

  let rows: HitRow[];
  let approximate = mode === "approximate";
  if (mode === "auto") {
    const { rows: counted } = await tx.query<{ n: string }>(
      `select count(*) as n from embeddings e where ${filter}`,
      values.slice(0, 5),
    );
    approximate = Number(counted[0]?.n ?? 0) > CODE_SEARCH_EXACT_MAX_VECTORS;
  }
  if (approximate) {
    // The HNSW scan keeps going (in distance order) until `k` rows pass the tenant filter
    // (pgvector 0.8 iterative scans); constants, not input.
    await tx.query("set local hnsw.iterative_scan = strict_order");
    await tx.query("set local hnsw.ef_search = 200");
    rows = (
      await tx.query<HitRow>(
        `select ${HIT_COLUMNS} from embeddings e ${joins}
          where ${filter}
          order by e.embedding <=> $6::vector
          limit $7`,
        values,
      )
    ).rows;
    // An approximate scan can come back short; the exact one cannot.
    if (rows.length < query.k) rows = await exact();
  } else {
    rows = await exact();
  }
  return rows.map((r) => ({
    chunkId: r.chunk_id,
    path: r.path,
    blobSha: r.blob_sha,
    language: r.language,
    startLine: r.start_line,
    endLine: r.end_line,
    kind: r.kind,
    score: Number(r.score),
  }));
};
