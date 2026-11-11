/**
 * Drizzle mirror of the SQL migrations in ../migrations (the source of truth). Column names,
 * nullability and table set are checked against the live database by schema-drift.test.ts;
 * constraints, RLS policies and triggers live only in SQL.
 */
import { INDEX_VECTOR_DIMENSIONS } from "@rocky-reviews/core";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** Ciphertext written by packages/crypto. Never store plaintext secrets in any column. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * `vector(1024)` since migration 0022 (P9-1, ADR 0040 §3): every embedding space is stored at
 * this one indexed width, its own `dimensions` on the row, zero-padded beyond them.
 */
export const EMBEDDING_DIMENSIONS = INDEX_VECTOR_DIMENSIONS;

const orgIdColumn = () =>
  uuid("org_id")
    .notNull()
    .default(sql`app.current_org_id()`)
    .references(() => orgs.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const identity = () => bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey();

export const orgs = pgTable("orgs", {
  id: uuid("id")
    .primaryKey()
    .default(sql`app.current_org_id()`),
  forge: text("forge").notNull().default("github"),
  /**
   * How the org reaches the forge (P10-4, migration 0024): `app` through an installation (every
   * org before P10-4), `token` through its owner's personal access token (self-host only).
   */
  connection: text("connection", { enum: ["app", "token"] })
    .notNull()
    .default("app"),
  /** The installation an `app` org is bound to; `null` exactly for a `token` org (CHECK). */
  installationId: bigint("installation_id", { mode: "number" }),
  /** The forge's immutable account id: orgs bind by it, never by `login` (ADR 0009). */
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  /** Display only; the forge can rename and reuse logins. */
  login: text("login").notNull(),
  kind: text("kind", { enum: ["organization", "user"] }).notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  dataKeyCiphertext: bytea("data_key_ciphertext"),
  dataKeyVersion: integer("data_key_version"),
  llmApiKeyCiphertext: bytea("llm_api_key_ciphertext"),
  llmApiKeyVersion: integer("llm_api_key_version"),
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  /** The installer reported by the webhook: a candidate first admin, unverified (ADR 0009). */
  installerForgeUserId: bigint("installer_forge_user_id", { mode: "number" }),
  /** Set when the deletion sweep starts erasing the org; a reinstall then gets a new org. */
  erasingAt: timestamp("erasing_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  forgeUserId: bigint("forge_user_id", { mode: "number" }).notNull(),
  login: text("login").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] })
    .notNull()
    .default("member"),
  forgeTokenCiphertext: bytea("forge_token_ciphertext"),
  forgeTokenKeyVersion: integer("forge_token_key_version"),
  /** When the stored user token expires (P7-1); null for a non-expiring token or none stored. */
  forgeAccessExpiresAt: timestamp("forge_access_expires_at", { withTimezone: true }),
  /** Removed in Rocky (P7-1 review round 1); sign-in does not revive it (re-adding is P7-2's). */
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  forgeRepoId: bigint("forge_repo_id", { mode: "number" }).notNull(),
  fullName: text("full_name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  private: boolean("private").notNull().default(true),
  enabled: boolean("enabled").notNull().default(true),
  /** Whether reviews of the repository use project memory (P8-3, migration 0020). */
  memoryEnabled: boolean("memory_enabled").notNull().default(true),
  /** When the pull requests were last read from the forge on a token (P10-4, migration 0024). */
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pullRequests = pgTable("pull_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  repoId: uuid("repo_id").notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  authorLogin: text("author_login"),
  state: text("state", { enum: ["open", "closed", "merged"] }).notNull(),
  headSha: text("head_sha").notNull(),
  baseSha: text("base_sha").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  /** The forge's last-modified time of this snapshot: older snapshots never overwrite it. */
  forgeUpdatedAt: timestamp("forge_updated_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const prRevisions = pgTable("pr_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  pullRequestId: uuid("pull_request_id").notNull(),
  headSha: text("head_sha").notNull(),
  baseSha: text("base_sha").notNull(),
  diffTruncated: boolean("diff_truncated").notNull().default(false),
  stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
  /** What was read of the diff (P3-4): size and sha256; the text is not stored. */
  diffBytes: integer("diff_bytes"),
  diffSha256: bytea("diff_sha256"),
  diffTruncation: text("diff_truncation", { enum: ["max_bytes", "forge_limit", "unavailable"] }),
  createdAt: createdAt(),
});

export const analyses = pgTable("analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  revisionId: uuid("revision_id").notNull(),
  status: text("status", {
    enum: ["queued", "running", "awaiting_approval", "done", "failed"],
  }).notNull(),
  document: jsonb("document").$type<AnalysisDocument | Record<string, unknown>>(),
  errorCode: text("error_code"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Unit keys of the files a finished analysis analysed (P4-3, migration 0010). */
  fileUnits: jsonb("file_units").$type<{ path: string; key: string; reviewMinutes: number }[]>(),
  /** The queue lane (P4-6, migration 0012): claims so far, backoff, the lease while running. */
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  leaseId: uuid("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  /** The per-PR token limit: the estimate, the limit it exceeded, and "Analyze anyway". */
  estimatedTokens: integer("estimated_tokens"),
  limitTokens: integer("limit_tokens"),
  approvedTokens: integer("approved_tokens"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});

export const findingsState = pgTable("findings_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  analysisId: uuid("analysis_id").notNull(),
  findingId: text("finding_id").notNull(),
  state: text("state", { enum: ["draft", "accepted", "dismissed"] })
    .notNull()
    .default("draft"),
  /** A fixed code (migration 0015): not_an_issue, intentional, not_worth_it, handled_elsewhere. */
  reason: text("reason"),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** Whose decision this is: drafts are per reviewer (P6-4, migration 0015). */
  memberId: uuid("member_id").notNull(),
  /** When the reviewer last copied the finding's fix prompt ("Send to agent"). */
  agentPromptCopiedAt: timestamp("agent_prompt_copied_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const commentsPending = pgTable("comments_pending", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  pullRequestId: uuid("pull_request_id").notNull(),
  revisionId: uuid("revision_id").notNull(),
  authorId: uuid("author_id").notNull(),
  findingId: text("finding_id"),
  path: text("path"),
  line: integer("line"),
  body: text("body").notNull(),
  /** P6-4 (migration 0015): the analysis the reviewer saw; set for every comment written since. */
  analysisId: uuid("analysis_id"),
  /** `own`, or an accepted draft: `ai` (the finding's body) or `ai_edited` (the reviewer's). */
  source: text("source", { enum: ["own", "ai", "ai_edited"] })
    .notNull()
    .default("own"),
  /** First line of a multi-line range (GitHub's `start_line`); `line` is the last. */
  startLine: integer("start_line"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One attempt to post a review as the user (P3-5, migration 0016, ADR 0026): written before the
 * forge is called, finished after. Digests and counts only; the content lives on the forge.
 */
export const reviewSubmissions = pgTable("review_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  pullRequestId: uuid("pull_request_id").notNull(),
  revisionId: uuid("revision_id").notNull(),
  /** The member who clicked: never a system actor. */
  submittedBy: uuid("submitted_by").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  headSha: text("head_sha").notNull(),
  verdict: text("verdict", { enum: ["approve", "request_changes", "comment"] }).notNull(),
  contentSha256: bytea("content_sha256").notNull(),
  bodySha256: bytea("body_sha256").notNull(),
  draftCount: integer("draft_count").notNull(),
  commentCount: integer("comment_count").notNull(),
  status: text("status", { enum: ["posting", "posted", "failed"] })
    .notNull()
    .default("posting"),
  forgeReviewId: bigint("forge_review_id", { mode: "number" }),
  errorCode: text("error_code"),
  createdAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** What a submission carried, in order: the item's id and the sha256 of its body as posted. */
export const reviewSubmissionItems = pgTable("review_submission_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  submissionId: uuid("submission_id").notNull(),
  seq: integer("seq").notNull(),
  kind: text("kind", { enum: ["draft", "comment"] }).notNull(),
  itemId: uuid("item_id").notNull(),
  bodySha256: bytea("body_sha256").notNull(),
});

/**
 * Project memory (P8-1, migration 0017, ADR 0036): what a repository's reviewers decided, with
 * its evidence. `content` is scrubbed of personal identifiers before it is stored; the author is
 * a member id only (`created_by`, set to null when the member row goes).
 */
export const memoryEntries = pgTable("memory_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  repoId: uuid("repo_id").notNull(),
  kind: text("kind", { enum: ["convention", "decision", "dismissal"] }).notNull(),
  /** `member` (a person wrote it) or `learned` (P8-2 derived it from a decision). */
  origin: text("origin", { enum: ["member", "learned"] }).notNull(),
  content: text("content").notNull(),
  evidencePath: text("evidence_path").notNull(),
  evidenceSha: text("evidence_sha").notNull(),
  evidenceStart: integer("evidence_start").notNull(),
  evidenceEnd: integer("evidence_end").notNull(),
  sourcePrNumber: integer("source_pr_number").notNull(),
  confidence: integer("confidence").notNull(),
  /** The dismissal reason code, exactly for `dismissal` entries. */
  reason: text("reason"),
  /** For a learned dismissal: the dismissed finding's severity, the highest it covers (0018). */
  severity: text("severity", { enum: ["critical", "high", "medium", "low"] }),
  /** The reviewer's role when the entry was learned (0018), kept by an edit (0020). */
  learnerRole: text("learner_role", { enum: ["owner", "admin", "member"] }),
  /**
   * For a learned dismissal: the triage level the dismissed finding's file had in the stored
   * document (0021, P8-2b); `critical` lets it stand on a critical file. Null otherwise.
   */
  learnedLevel: text("learned_level", { enum: ["critical", "important", "normal", "low"] }),
  createdBy: uuid("created_by"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  /** When the decay job (P8-4, migration 0019) last lowered the confidence; null until it does. */
  decayedAt: timestamp("decayed_at", { withTimezone: true }),
  supersededBy: uuid("superseded_by"),
  /** When an admin switched the entry off (P8-3, migration 0020); null while it applies. */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  /** What a learned entry is about, kept across edits (P8-3, migration 0020); null otherwise. */
  learnedSubject: text("learned_subject"),
  /** When the entry was last switched on again (P8-3, migration 0020); decay counts from it. */
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const embeddings = pgTable("embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  repoId: uuid("repo_id"),
  memoryEntryId: uuid("memory_entry_id"),
  sourceKind: text("source_kind").notNull(),
  sourceRef: text("source_ref").notNull(),
  model: text("model").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  createdAt: createdAt(),
  /** The embedding space of the vector (migration 0022): never compared across spaces. */
  provider: text("provider").notNull(),
  dimensions: integer("dimensions").notNull(),
  /** A code chunk's vector (P9-1); null for memory entries. */
  codeChunkId: uuid("code_chunk_id"),
});

/** One per repository (P9-1, migration 0022): the index's state and its job. */
export const codeIndexes = pgTable("code_indexes", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  repoId: uuid("repo_id").notNull(),
  status: text("status", { enum: ["queued", "running", "done", "failed", "over_limit"] })
    .notNull()
    .default("queued"),
  requestedSha: text("requested_sha"),
  generation: integer("generation").notNull().default(1),
  indexedSha: text("indexed_sha"),
  embeddingProvider: text("embedding_provider"),
  embeddingModel: text("embedding_model"),
  embeddingDimensions: integer("embedding_dimensions"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  leaseId: uuid("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  errorCode: text("error_code"),
  estimatedTokens: integer("estimated_tokens"),
  limitTokens: integer("limit_tokens"),
  approvedTokens: integer("approved_tokens"),
  filesIndexed: integer("files_indexed").notNull().default(0),
  chunksIndexed: integer("chunks_indexed").notNull().default(0),
  spentTokens: integer("spent_tokens").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A file the index holds (P9-1): which blob it was read from. Never its content. */
export const codeFiles = pgTable("code_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  repoId: uuid("repo_id").notNull(),
  path: text("path").notNull(),
  blobSha: text("blob_sha").notNull(),
  language: text("language").notNull(),
  status: text("status", { enum: ["indexed", "skipped"] }).notNull(),
  skipReason: text("skip_reason"),
  chunkCount: integer("chunk_count").notNull().default(0),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A chunk of an indexed file (P9-1): its line range and the sha256 of its embedded input. */
export const codeChunks = pgTable("code_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  repoId: uuid("repo_id").notNull(),
  fileId: uuid("file_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  kind: text("kind").notNull(),
  /** sha256 of the embedded input (path, newline, text); the text is not stored. */
  inputSha256: bytea("input_sha256").notNull(),
});

/** Append-only (trigger in migration 0004). Identifiers only, never code/diffs/tokens/emails. */
export const auditEvents = pgTable("audit_events", {
  id: identity(),
  orgId: orgIdColumn(),
  actorType: text("actor_type", { enum: ["user", "system", "forge"] }).notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

/**
 * Append-only metering ledger (migration 0011, ADR 0016): one row per attempt of an LLM call.
 * Ids, enums and numbers only. Token counts are null only when nothing was reported; the cost is
 * null unless the row is priced at list price.
 */
export const llmUsage = pgTable("llm_usage", {
  id: identity(),
  orgId: orgIdColumn(),
  analysisId: uuid("analysis_id"),
  repoId: uuid("repo_id"),
  pullRequestId: uuid("pull_request_id"),
  callId: uuid("call_id").notNull(),
  attempt: smallint("attempt").notNull(),
  role: text("role", { enum: ["triage", "review", "graph", "ask", "embed"] }).notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  outcome: text("outcome", {
    enum: ["ok", "refused", "truncated", "invalid_output", "error"],
  }).notNull(),
  errorKind: text("error_kind"),
  usageStatus: text("usage_status", { enum: ["reported", "partial", "unreported"] }).notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWrite5mTokens: integer("cache_write_5m_tokens"),
  cacheWrite1hTokens: integer("cache_write_1h_tokens"),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
  costStatus: text("cost_status", {
    enum: ["priced", "no_price", "billing_unverified", "no_usage"],
  }).notNull(),
  priceVersion: text("price_version").notNull(),
  createdAt: createdAt(),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status", { enum: ["queued", "running", "done", "failed", "cancelled"] })
    .notNull()
    .default("queued"),
  attempts: integer("attempts").notNull().default(0),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  error: text("error"),
  createdAt: createdAt(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
