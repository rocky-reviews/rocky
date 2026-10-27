import {
  belowVerdictFloor,
  FileUnits,
  type DiffTruncation,
  type FileUnit,
  type PreviousAnalysis,
} from "@rocky-reviews/core";
import { parseAnalysisDocument, parseAnalysisDocumentJson } from "@rocky-reviews/schema";
import type { TenantTx } from "./client.js";

/**
 * Analysis rows (P4-3, migration 0010, ADR 0014 §7). Every function runs inside `withOrg` (the
 * org's tenant transaction, RLS) and filters by `tx.orgId` as well, as the other modules do.
 *
 * A row moves `queued` → `running` → `done` | `failed` (or back to `queued` for a retry). Only two
 * things are ever stored as the outcome:
 * - `done`: a document that passes `parseAnalysisDocumentJson` here, again, at the write, whose
 *   verdict is not below an unanalysed migration or auth file, plus the file units of the files
 *   it analysed (every unit names a triaged file of that document);
 * - `failed`: a fixed error code and no document.
 * A partial or unvalidated document cannot be written through this module.
 */

export class AnalysisStoreError extends Error {
  override readonly name = "AnalysisStoreError";
}

/** Messages name the field, never the value. */
const invalid = (field: string): never => {
  throw new AnalysisStoreError(`analyses: invalid ${field}`);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const TRUNCATIONS: ReadonlySet<string> = new Set(["max_bytes", "forge_limit", "unavailable"]);

const checkId = (value: unknown, field: string): void => {
  if (typeof value !== "string" || !UUID.test(value)) invalid(field);
};

/** What the worker needs to analyse one queued row: the revision, its pull request and repo. */
export interface AnalysisTarget {
  readonly analysisId: string;
  readonly revisionId: string;
  readonly pullRequestId: string;
  readonly number: number;
  /** Untrusted PR text: reaches a model only as an untrusted part; never logged. */
  readonly title: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly forgeRepoId: number;
  readonly fullName: string;
  /** What the mirror recorded about the revision's diff (null: complete, or not read yet). */
  readonly diffTruncation: DiffTruncation | null;
}

/** Queues an analysis of one revision of `tx.orgId`; returns the row id. */
export const enqueueAnalysis = async (tx: TenantTx, revisionId: string): Promise<string> => {
  checkId(revisionId, "revision id");
  const { rows } = await tx.query<{ id: string }>(
    "insert into analyses (revision_id, status) values ($1, 'queued') returning id",
    [revisionId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new AnalysisStoreError("analyses: row missing");
  return id;
};

/**
 * Claims a queued row (`running`) and returns its target, or `undefined` when the row is not
 * queued (another worker has it, it finished, or it is not this org's: RLS hides it).
 */
export const startAnalysis = async (
  tx: TenantTx,
  analysisId: string,
): Promise<AnalysisTarget | undefined> => {
  checkId(analysisId, "analysis id");
  const { rows } = await tx.query<{
    revision_id: string;
    pull_request_id: string;
    number: number;
    title: string;
    head_sha: string;
    base_sha: string;
    forge_repo_id: string;
    full_name: string;
    diff_truncation: string | null;
  }>(
    `with claimed as (
       update analyses set status = 'running'
        where org_id = $1 and id = $2 and status = 'queued'
        returning revision_id)
     select r.id as revision_id, p.id as pull_request_id, p.number, p.title, r.head_sha,
            r.base_sha, rp.forge_repo_id, rp.full_name, r.diff_truncation
       from claimed c
       join pr_revisions r on r.org_id = $1 and r.id = c.revision_id
       join pull_requests p on p.org_id = $1 and p.id = r.pull_request_id
       join repos rp on rp.org_id = $1 and rp.id = p.repo_id`,
    [tx.orgId, analysisId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const forgeRepoId = Number(row.forge_repo_id);
  if (!Number.isSafeInteger(forgeRepoId) || forgeRepoId < 1) invalid("repository id");
  if (row.diff_truncation !== null && !TRUNCATIONS.has(row.diff_truncation)) {
    invalid("diff truncation");
  }
  return {
    analysisId,
    revisionId: row.revision_id,
    pullRequestId: row.pull_request_id,
    number: row.number,
    title: row.title,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    forgeRepoId,
    fullName: row.full_name,
    diffTruncation: row.diff_truncation as DiffTruncation | null,
  };
};

/**
 * The pull request's most recent finished analysis other than `excludingAnalysisId`, with its
 * units, re-validated as it is read back. Anything that does not validate is not offered for
 * reuse (the pipeline then analyses every file afresh).
 */
export const loadPreviousAnalysis = async (
  tx: TenantTx,
  pullRequestId: string,
  excludingAnalysisId: string,
): Promise<PreviousAnalysis | undefined> => {
  checkId(pullRequestId, "pull request id");
  checkId(excludingAnalysisId, "analysis id");
  const { rows } = await tx.query<{ document: unknown; file_units: unknown }>(
    `select a.document, a.file_units
       from analyses a
       join pr_revisions r on r.org_id = a.org_id and r.id = a.revision_id
      where a.org_id = $1 and r.pull_request_id = $2 and a.id <> $3
        and a.status = 'done' and a.file_units is not null
      order by a.completed_at desc nulls last, a.created_at desc
      limit 1`,
    [tx.orgId, pullRequestId, excludingAnalysisId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const document = parseAnalysisDocument(row.document);
  const units = FileUnits.safeParse(row.file_units);
  if (!document.ok || !units.success) return undefined;
  return { document: document.value, units: units.data };
};

const finish = async (
  tx: TenantTx,
  analysisId: string,
  set: string,
  values: readonly unknown[],
): Promise<boolean> => {
  const { rowCount } = await tx.query(
    `update analyses set ${set}, completed_at = now()
      where org_id = $1 and id = $2 and status = 'running'`,
    [tx.orgId, analysisId, ...values],
  );
  return rowCount === 1;
};

/**
 * Stores a finished analysis. The document is validated again here (a write never trusts its
 * caller), and every unit must name a triaged file of it. Returns false when the row is not
 * `running` (lost to another worker, or not this org's).
 */
export const completeAnalysis = async (
  tx: TenantTx,
  analysisId: string,
  document: unknown,
  units: readonly FileUnit[],
): Promise<boolean> => {
  checkId(analysisId, "analysis id");
  let text: string;
  try {
    text = JSON.stringify(document);
  } catch {
    return invalid("document");
  }
  const parsed = parseAnalysisDocumentJson(text);
  if (!parsed.ok) invalid("document");
  const checked = FileUnits.safeParse(units);
  if (!parsed.ok || !checked.success) return invalid("file units");
  // The verdict never sits below an unanalysed file: high for a migration or auth path, medium
  // otherwise (review round 1 Fix A, round 2 SF2).
  if (belowVerdictFloor(parsed.value)) invalid("document verdict");
  const triaged = new Set(parsed.value.triage.files.map((file) => file.path));
  if (!checked.data.every((unit) => triaged.has(unit.path))) invalid("file units");
  // Store the validated value (defaults filled in), not the caller's object.
  return finish(
    tx,
    analysisId,
    "status = 'done', document = $3::jsonb, file_units = $4::jsonb, error_code = null",
    [JSON.stringify(parsed.value), JSON.stringify(checked.data)],
  );
};

/** Stores a failure: a fixed code (`[a-z][a-z0-9_]*`), no document, no units. */
export const failAnalysis = async (
  tx: TenantTx,
  analysisId: string,
  code: string,
): Promise<boolean> => {
  checkId(analysisId, "analysis id");
  if (typeof code !== "string" || !ERROR_CODE.test(code)) invalid("error code");
  return finish(
    tx,
    analysisId,
    "status = 'failed', document = null, file_units = null, error_code = $3",
    [code],
  );
};

/** Puts a running row back in the queue (a retryable failure). False when it is not running. */
export const requeueAnalysis = async (tx: TenantTx, analysisId: string): Promise<boolean> => {
  checkId(analysisId, "analysis id");
  const { rowCount } = await tx.query(
    `update analyses set status = 'queued'
      where org_id = $1 and id = $2 and status = 'running'`,
    [tx.orgId, analysisId],
  );
  return rowCount === 1;
};
