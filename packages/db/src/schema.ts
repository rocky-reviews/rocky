/**
 * Drizzle mirror of the SQL migrations in ../migrations (the source of truth). Column names,
 * nullability and table set are checked against the live database by schema-drift.test.ts;
 * constraints, RLS policies and triggers live only in SQL.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** Ciphertext written by packages/crypto. Never store plaintext secrets in any column. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** `vector(1536)` in the migration; P9-1 settles the final dimension and index. */
export const EMBEDDING_DIMENSIONS = 1536;

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
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
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
  role: text("role", { enum: ["admin", "member"] })
    .notNull()
    .default("member"),
  forgeTokenCiphertext: bytea("forge_token_ciphertext"),
  forgeTokenKeyVersion: integer("forge_token_key_version"),
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
  createdAt: createdAt(),
});

export const analyses = pgTable("analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  revisionId: uuid("revision_id").notNull(),
  status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull(),
  document: jsonb("document").$type<AnalysisDocument | Record<string, unknown>>(),
  errorCode: text("error_code"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const findingsState = pgTable("findings_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  analysisId: uuid("analysis_id").notNull(),
  findingId: text("finding_id").notNull(),
  state: text("state", { enum: ["draft", "accepted", "dismissed"] })
    .notNull()
    .default("draft"),
  reason: text("reason"),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memoryEntries = pgTable("memory_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgIdColumn(),
  repoId: uuid("repo_id"),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid("created_by"),
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

export const llmUsage = pgTable("llm_usage", {
  id: identity(),
  orgId: orgIdColumn(),
  analysisId: uuid("analysis_id"),
  role: text("role").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull(),
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
