import {
  isLlmErrorKind,
  LLM_COST_STATUSES,
  LLM_ROLES,
  LLM_USAGE_OUTCOMES,
  LLM_USAGE_STATUSES,
  type LlmUsageRecord,
} from "@rocky-reviews/core";
import type { TenantTx } from "./client.js";

/**
 * The llm_usage writer (P4-5, migration 0011, ADR 0016). Records are checked against the same
 * rules the table's CHECKs enforce, before any SQL, so a bad record fails with a fixed message
 * instead of a driver error that could echo values. Runs inside `withOrg` (the row's org is the
 * transaction's tenant). The worker login writes any record; the server login (P9-3, migration
 * 0023) may write `ask` and `embed` records with no analysis link, for the repository and pull
 * request the question was about. Idempotent per (call id, attempt): a write retried after an
 * unclear failure stores nothing new.
 */

/** A call has at most this many attempts (a fallback chain); a write never holds more. */
export const LLM_USAGE_MAX_RECORDS = 16;

export class UsageStoreError extends Error {
  override readonly name = "UsageStoreError";
  /** The SQLSTATE of the underlying database error, when there was one. */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const PRICE_VERSION = /^(none|\d{4}-\d{2}-\d{2}(\.\d{1,3})?)$/;
const MAX_INT4 = 2_147_483_647;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INT4;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const invalid = (what: string): never => {
  throw new UsageStoreError(`llm usage: invalid ${what}`);
};

const check = (r: LlmUsageRecord): void => {
  if (typeof r.callId !== "string" || !UUID.test(r.callId)) invalid("call id");
  if (!Number.isInteger(r.attempt) || r.attempt < 0 || r.attempt > 15) invalid("attempt");
  if (!oneOf(LLM_ROLES, r.role)) invalid("role");
  if (typeof r.provider !== "string" || !PROVIDER.test(r.provider)) invalid("provider");
  if (typeof r.model !== "string" || !MODEL.test(r.model)) invalid("model");
  if (r.analysisId !== undefined && (typeof r.analysisId !== "string" || !UUID.test(r.analysisId)))
    invalid("analysis id");
  if (r.repoId !== undefined && (typeof r.repoId !== "string" || !UUID.test(r.repoId)))
    invalid("repo id");
  if (
    r.pullRequestId !== undefined &&
    (typeof r.pullRequestId !== "string" || !UUID.test(r.pullRequestId) || r.repoId === undefined)
  )
    invalid("pull request id");
  if (!oneOf(LLM_USAGE_OUTCOMES, r.outcome)) invalid("outcome");
  if (r.errorKind !== undefined && (r.outcome !== "error" || !isLlmErrorKind(r.errorKind)))
    invalid("error kind");
  if (!oneOf(LLM_USAGE_STATUSES, r.usageStatus)) invalid("usage status");
  if (r.usageStatus === "partial" && r.outcome !== "error") invalid("usage status");
  if (!oneOf(LLM_COST_STATUSES, r.costStatus)) invalid("cost status");
  const unreported = r.usageStatus === "unreported";
  if (unreported !== (r.tokens === null)) invalid("tokens");
  if (r.tokens !== null && !Object.values(r.tokens).every(isCount)) invalid("tokens");
  if (r.tokens !== null && Object.keys(r.tokens).length !== 5) invalid("tokens");
  if (unreported !== (r.costStatus === "no_usage")) invalid("cost status");
  if ((r.costStatus === "priced") !== (r.costMicroUsd !== null)) invalid("cost");
  if (
    r.costMicroUsd !== null &&
    !(
      typeof r.costMicroUsd === "number" &&
      Number.isSafeInteger(r.costMicroUsd) &&
      r.costMicroUsd >= 0
    )
  )
    invalid("cost");
  if (typeof r.priceVersion !== "string" || !PRICE_VERSION.test(r.priceVersion))
    invalid("price version");
};

/** Drizzle wraps the driver's error as `cause`; the SQLSTATE is on one or the other. */
const sqlstateOf = (error: unknown): string | undefined => {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
};

export const recordLlmUsage = async (
  tx: TenantTx,
  records: readonly LlmUsageRecord[],
): Promise<void> => {
  if (records.length === 0) return;
  if (records.length > LLM_USAGE_MAX_RECORDS) invalid("batch size");
  for (const record of records) check(record);
  // The INSERT names only the columns the batch carries. The server's grant (migration 0023) is
  // column-scoped and a column written as NULL or DEFAULT still needs the privilege, which
  // rules out the query builder (it names every column of the table): a link column no record
  // names is left out, so an Ask write never mentions `analysis_id`.
  const links = [
    ["analysis_id", (r: LlmUsageRecord) => r.analysisId],
    ["repo_id", (r: LlmUsageRecord) => r.repoId],
    ["pull_request_id", (r: LlmUsageRecord) => r.pullRequestId],
  ] as const;
  const named = links.filter(([, of]) => records.some((r) => of(r) !== undefined));
  const columns = [
    "call_id",
    "attempt",
    "role",
    "provider",
    "model",
    "outcome",
    "error_kind",
    "usage_status",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_5m_tokens",
    "cache_write_1h_tokens",
    "cost_micro_usd",
    "cost_status",
    "price_version",
    ...named.map(([column]) => column),
  ];
  const values: unknown[] = [];
  const rows = records.map((r) => {
    const row: unknown[] = [
      r.callId,
      r.attempt,
      r.role,
      r.provider,
      r.model,
      r.outcome,
      r.errorKind ?? null,
      r.usageStatus,
      r.tokens?.inputTokens ?? null,
      r.tokens?.outputTokens ?? null,
      r.tokens?.cacheReadTokens ?? null,
      r.tokens?.cacheWrite5mTokens ?? null,
      r.tokens?.cacheWrite1hTokens ?? null,
      r.costMicroUsd,
      r.costStatus,
      r.priceVersion,
      ...named.map(([, of]) => of(r) ?? null),
    ];
    return `(${row.map((value) => `$${values.push(value)}`).join(", ")})`;
  });
  try {
    await tx.query(
      `insert into llm_usage (${columns.join(", ")}) values ${rows.join(", ")}
       on conflict (org_id, call_id, attempt) do nothing`,
      values,
    );
  } catch (error) {
    // Driver text can quote the row; only the SQLSTATE leaves.
    throw new UsageStoreError("llm usage: the database refused the write", sqlstateOf(error));
  }
};
