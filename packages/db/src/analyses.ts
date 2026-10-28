import {
  belowVerdictFloor,
  FileUnits,
  type DiffTruncation,
  type FileUnit,
  type OrgId,
  type PreviousAnalysis,
} from "@rocky-reviews/core";
import { parseAnalysisDocument, parseAnalysisDocumentJson } from "@rocky-reviews/schema";
import { audit } from "./audit.js";
import type { TenantTx } from "./client.js";

/**
 * Analysis rows (P4-3, migration 0010, ADR 0014 §7; the queue lane P4-6, migration 0012, ADR
 * 0017). Every function runs inside `withOrg` (the org's tenant transaction, RLS) and filters by
 * `tx.orgId` as well, as the other modules do. Only the claim is cross-tenant: it runs through
 * `worker.claim_analyses` (`Db.claimAnalyses`, worker login only).
 *
 * A row moves `queued` → `running` (claimed with a lease) → `done` | `failed`, back to `queued`
 * for a retry, or to `awaiting_approval` when its estimate is over the per-PR token limit (and
 * from there to `queued` only through `approveAnalysisOverLimit`). While `running`, only the
 * holder of the lease token can finish, requeue, hold or renew it; an expired lease is reclaimed
 * by the next claim. Only two things are ever stored as the outcome:
 * - `done`: a document that passes `parseAnalysisDocumentJson` here, again, at the write, whose
 *   verdict is not below an unanalysed migration or auth file, plus the file units of the files
 *   it analysed (every unit names a triaged file of that document);
 * - `failed`: a fixed error code and no document.
 * A partial or unvalidated document cannot be written through this module.
 */

export class AnalysisStoreError extends Error {
  override readonly name = "AnalysisStoreError";
  /** A SQLSTATE when the database refused (the claim); never a message. */
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Claims of one row after which it fails instead of retrying (mirrors migration 0012). */
export const ANALYSIS_MAX_ATTEMPTS = 5;
/** A claim gives up after this long, waiting for the claim lock included (as the inbox's). */
export const ANALYSIS_CLAIM_STATEMENT_TIMEOUT_MS = 5_000;
/** The longest retry delay `requeueAnalysis` accepts (the database clamps too). */
export const ANALYSIS_MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;

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

/** What a worker holds while it runs one row. Only the current holder can finish it. */
export interface AnalysisLease {
  readonly analysisId: string;
  readonly leaseId: string;
}

/** One row handed out by the claim. */
export interface ClaimedAnalysis extends AnalysisLease {
  readonly orgId: OrgId;
  /** Claims so far, this one included (1 on the first). */
  readonly attempts: number;
  /** When the lease runs out (database clock), unless renewed. */
  readonly leaseUntil: Date;
}

const checkLease = (lease: AnalysisLease): void => {
  if (typeof lease !== "object" || lease === null) invalid("lease");
  checkId(lease.analysisId, "analysis id");
  checkId(lease.leaseId, "lease");
};

export interface AnalysisClaimOptions {
  /** Rows per claim (the database clamps to 1..100). */
  readonly limit: number;
  /** Lease length (the database clamps to 30..3600 s); renewed while the run lasts. */
  readonly leaseSeconds: number;
  /** Running rows per org, across every worker (the database clamps to 1..100). */
  readonly orgConcurrency: number;
}

export const claimAnalysesSql = (
  options: AnalysisClaimOptions,
): { readonly text: string; readonly values: unknown[] } => {
  for (const value of [options.limit, options.leaseSeconds, options.orgConcurrency]) {
    if (!Number.isInteger(value)) invalid("claim bounds");
  }
  return {
    text: `select org_id, analysis_id, lease_id::text as lease_id, attempts, lease_until
             from worker.claim_analyses($1, $2, $3)`,
    values: [options.limit, options.leaseSeconds, options.orgConcurrency],
  };
};

export interface ClaimedAnalysisRow {
  org_id: string;
  analysis_id: string;
  lease_id: string;
  attempts: number;
  lease_until: Date;
}

export const claimedAnalysisFromRow = (row: ClaimedAnalysisRow): ClaimedAnalysis => ({
  orgId: row.org_id as OrgId,
  analysisId: row.analysis_id,
  leaseId: row.lease_id,
  attempts: row.attempts,
  leaseUntil: row.lease_until,
});

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
  /**
   * "Analyze anyway" for this row: the estimate a person approved over the token limit (null:
   * none). It covers this revision only; a new push is a new row.
   */
  readonly approvedTokens: number | null;
  /**
   * The revision is no longer the pull request's head (a later push), or the pull request is not
   * open: analysing it would spend on something nobody will review (review round 1, SF3).
   */
  readonly superseded: boolean;
}

const LIVE = "status in ('queued', 'running', 'awaiting_approval')";

/**
 * Queues an analysis of one revision of `tx.orgId`; returns the row id. Idempotent: a revision
 * with a live analysis (queued, running or awaiting approval) keeps it, and its id is returned.
 */
export const enqueueAnalysis = async (tx: TenantTx, revisionId: string): Promise<string> => {
  checkId(revisionId, "revision id");
  const { rows } = await tx.query<{ id: string }>(
    `insert into analyses (revision_id, status) values ($1, 'queued')
     on conflict (org_id, revision_id) where ${LIVE} do nothing
     returning id`,
    [revisionId],
  );
  const id =
    rows[0]?.id ??
    (
      await tx.query<{ id: string }>(
        `select id from analyses where org_id = $1 and revision_id = $2 and ${LIVE}`,
        [tx.orgId, revisionId],
      )
    ).rows[0]?.id;
  if (id === undefined) throw new AnalysisStoreError("analyses: row missing");
  return id;
};

/**
 * Queues an analysis of a pull request's revision at `headSha` (the mirror, P4-6), unless that
 * revision already has an analysis of any state or its diff could not be read. Returns the new
 * row's id, or undefined when nothing was queued.
 */
export const enqueueHeadAnalysis = async (
  tx: TenantTx,
  pullRequestId: string,
  headSha: string,
): Promise<string | undefined> => {
  checkId(pullRequestId, "pull request id");
  if (typeof headSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) {
    invalid("head sha");
  }
  const { rows } = await tx.query<{ id: string }>(
    `insert into analyses (revision_id, status)
     select r.id, 'queued' from pr_revisions r
      where r.org_id = $1 and r.pull_request_id = $2 and r.head_sha = $3
        and r.diff_bytes is not null and r.diff_truncation is distinct from 'unavailable'
        and not exists (select 1 from analyses a where a.org_id = r.org_id and a.revision_id = r.id)
     on conflict (org_id, revision_id) where ${LIVE} do nothing
     returning id`,
    [tx.orgId, pullRequestId, headSha],
  );
  return rows[0]?.id;
};

/**
 * The target of a row this lease holds (`running`, same token, lease not expired), or undefined
 * when the lease is no longer held (expired and reclaimed, finished, or not this org's: RLS).
 */
export const loadAnalysisTarget = async (
  tx: TenantTx,
  lease: AnalysisLease,
): Promise<AnalysisTarget | undefined> => {
  checkLease(lease);
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
    approved_tokens: number | null;
    superseded: boolean;
  }>(
    `select r.id as revision_id, p.id as pull_request_id, p.number, p.title, r.head_sha,
            r.base_sha, rp.forge_repo_id, rp.full_name, r.diff_truncation, a.approved_tokens,
            (p.head_sha <> r.head_sha or p.state <> 'open') as superseded
       from analyses a
       join pr_revisions r on r.org_id = $1 and r.id = a.revision_id
       join pull_requests p on p.org_id = $1 and p.id = r.pull_request_id
       join repos rp on rp.org_id = $1 and rp.id = p.repo_id
      where a.org_id = $1 and a.id = $2 and a.status = 'running' and a.lease_id = $3
        and a.lease_until > now()`,
    [tx.orgId, lease.analysisId, lease.leaseId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const forgeRepoId = Number(row.forge_repo_id);
  if (!Number.isSafeInteger(forgeRepoId) || forgeRepoId < 1) invalid("repository id");
  if (row.diff_truncation !== null && !TRUNCATIONS.has(row.diff_truncation)) {
    invalid("diff truncation");
  }
  return {
    analysisId: lease.analysisId,
    revisionId: row.revision_id,
    pullRequestId: row.pull_request_id,
    number: row.number,
    title: row.title,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    forgeRepoId,
    fullName: row.full_name,
    diffTruncation: row.diff_truncation as DiffTruncation | null,
    approvedTokens: row.approved_tokens,
    superseded: row.superseded,
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

/** The lease-guarded update every finishing write goes through; false when it is not held. */
const finish = async (
  tx: TenantTx,
  lease: AnalysisLease,
  set: string,
  values: readonly unknown[],
): Promise<boolean> => {
  const { rowCount } = await tx.query(
    `update analyses set ${set}, lease_id = null, lease_until = null
      where org_id = $1 and id = $2 and status = 'running' and lease_id = $3`,
    [tx.orgId, lease.analysisId, lease.leaseId, ...values],
  );
  return rowCount === 1;
};

/**
 * Stores a finished analysis. The document is validated again here (a write never trusts its
 * caller), and every unit must name a triaged file of it. Returns false when the lease is no
 * longer held (expired and reclaimed by another worker, or not this org's).
 */
export const completeAnalysis = async (
  tx: TenantTx,
  lease: AnalysisLease,
  document: unknown,
  units: readonly FileUnit[],
): Promise<boolean> => {
  checkLease(lease);
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
    lease,
    `status = 'done', document = $4::jsonb, file_units = $5::jsonb, error_code = null,
     completed_at = now()`,
    [JSON.stringify(parsed.value), JSON.stringify(checked.data)],
  );
};

const checkCode = (code: unknown): void => {
  if (typeof code !== "string" || !ERROR_CODE.test(code)) invalid("error code");
};

/** Stores a failure: a fixed code (`[a-z][a-z0-9_]*`), no document, no units. */
export const failAnalysis = async (
  tx: TenantTx,
  lease: AnalysisLease,
  code: string,
): Promise<boolean> => {
  checkLease(lease);
  checkCode(code);
  return finish(
    tx,
    lease,
    "status = 'failed', document = null, file_units = null, error_code = $4, completed_at = now()",
    [code],
  );
};

/**
 * Puts a running row back in the queue (a retryable failure), claimable again after `delayMs`
 * (0..ANALYSIS_MAX_RETRY_DELAY_MS, database clock). The code is kept as the row's last error.
 * False when the lease is no longer held.
 */
export const requeueAnalysis = async (
  tx: TenantTx,
  lease: AnalysisLease,
  code: string,
  delayMs: number,
): Promise<boolean> => {
  checkLease(lease);
  checkCode(code);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > ANALYSIS_MAX_RETRY_DELAY_MS) {
    invalid("retry delay");
  }
  return finish(
    tx,
    lease,
    `status = 'queued', error_code = $4,
     available_at = now() + make_interval(secs => $5::double precision / 1000)`,
    [code, delayMs],
  );
};

/**
 * Hands a running row back untouched (the worker is stopping, review round 1, SF5): queued,
 * claimable now, and the attempt this claim spent is given back, so restarts never fail a row.
 * False when the lease is no longer held.
 */
export const releaseAnalysis = async (tx: TenantTx, lease: AnalysisLease): Promise<boolean> => {
  checkLease(lease);
  return finish(
    tx,
    lease,
    "status = 'queued', attempts = greatest(attempts - 1, 0), available_at = now()",
    [],
  );
};

/**
 * The per-PR token limit (P4-6): the row waits for a person, with the estimate and the limit it
 * exceeded. Nothing was sent to a model. False when the lease is no longer held.
 */
export const holdAnalysis = async (
  tx: TenantTx,
  lease: AnalysisLease,
  estimate: { readonly estimatedTokens: number; readonly tokenLimit: number },
): Promise<boolean> => {
  checkLease(lease);
  const { estimatedTokens, tokenLimit } = estimate;
  if (
    !Number.isSafeInteger(estimatedTokens) ||
    estimatedTokens < 0 ||
    estimatedTokens > 2 ** 31 - 1
  ) {
    invalid("estimate");
  }
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1 || tokenLimit > 2 ** 31 - 1) {
    invalid("token limit");
  }
  return finish(
    tx,
    lease,
    "status = 'awaiting_approval', estimated_tokens = $4, limit_tokens = $5, error_code = null",
    [estimatedTokens, tokenLimit],
  );
};

/**
 * Extends a lease this worker still holds to `seconds` from now (database clock; 30..3600). An
 * expired lease is not renewed: the next claim may already have handed the row out again.
 */
export const renewAnalysisLease = async (
  tx: TenantTx,
  lease: AnalysisLease,
  seconds: number,
): Promise<boolean> => {
  checkLease(lease);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) invalid("lease seconds");
  const { rowCount } = await tx.query(
    `update analyses set lease_until = greatest(lease_until, now() + make_interval(secs => $4))
      where org_id = $1 and id = $2 and status = 'running' and lease_id = $3
        and lease_until > now()`,
    [tx.orgId, lease.analysisId, lease.leaseId, seconds],
  );
  return rowCount === 1;
};

/**
 * The forge repository id of an analysis of this org (P7-2: the repository access check runs
 * before "Analyze anyway"), or `null` when there is no such analysis here (unknown, another
 * org's: RLS).
 */
export const analysisRepository = async (
  tx: TenantTx,
  analysisId: string,
): Promise<{ readonly forgeRepoId: number } | null> => {
  checkId(analysisId, "analysis id");
  const { rows } = await tx.query<{ forge_repo_id: string }>(
    `select r.forge_repo_id::text as forge_repo_id
       from analyses a
       join pr_revisions v on v.org_id = a.org_id and v.id = a.revision_id
       join pull_requests p on p.org_id = v.org_id and p.id = v.pull_request_id
       join repos r on r.org_id = p.org_id and r.id = p.repo_id
      where a.org_id = $1 and a.id = $2`,
    [tx.orgId, analysisId],
  );
  const row = rows[0];
  return row === undefined ? null : { forgeRepoId: Number(row.forge_repo_id) };
};

/** Who said "Analyze anyway": an admin or the owner of the org (P7-2, ADR 0024). */
export interface AnalysisApprover {
  readonly memberId: string;
}

export interface AnalysisApproval {
  readonly analysisId: string;
  readonly revisionId: string;
  readonly estimatedTokens: number;
  readonly tokenLimit: number;
}

/**
 * "Analyze anyway" (P4-6): an analysis waiting over the per-PR token limit goes back to the queue,
 * approved up to the estimate the person saw, with an audit event in the same transaction. It is
 * explicit (a member id; the server's policy requires `analysis.approve_over_limit`, and this
 * re-checks the role in the same transaction), applies to this row, that is
 * this revision, only (a new push is a new row, estimated again), and resets the attempts: the
 * hold was not a failure. Returns undefined when the row is not waiting (already approved,
 * finished, unknown, or another org's: RLS), when its revision is no longer the head of an open
 * pull request (review round 1, SF3), or when the approver is not an active admin or owner of the
 * org (removed, a plain member, another org's).
 */
export const approveAnalysisOverLimit = async (
  tx: TenantTx,
  analysisId: string,
  approver: AnalysisApprover,
): Promise<AnalysisApproval | undefined> => {
  checkId(analysisId, "analysis id");
  if (typeof approver !== "object" || approver === null) invalid("approver");
  checkId(approver.memberId, "member id");
  const member = await tx.query(
    `select 1 from members
      where org_id = $1 and id = $2 and removed_at is null and role in ('owner', 'admin')
      for share`,
    [tx.orgId, approver.memberId],
  );
  if (member.rowCount !== 1) return undefined;
  const { rows } = await tx.query<{
    revision_id: string;
    estimated_tokens: number;
    limit_tokens: number;
  }>(
    `update analyses
        set status = 'queued', approved_tokens = estimated_tokens, approved_by = $3,
            approved_at = now(), available_at = now(), attempts = 0
      where org_id = $1 and id = $2 and status = 'awaiting_approval'
        and exists (
          select 1 from pr_revisions r
            join pull_requests p on p.org_id = r.org_id and p.id = r.pull_request_id
           where r.org_id = $1 and r.id = analyses.revision_id
             and p.head_sha = r.head_sha and p.state = 'open')
      returning revision_id, estimated_tokens, limit_tokens`,
    [tx.orgId, analysisId, approver.memberId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  await audit(
    tx,
    { type: "user", id: approver.memberId },
    "analysis.limit_overridden",
    { type: "analysis", id: analysisId },
    {
      revisionId: row.revision_id,
      estimatedTokens: row.estimated_tokens,
      tokenLimit: row.limit_tokens,
    },
  );
  return {
    analysisId,
    revisionId: row.revision_id,
    estimatedTokens: row.estimated_tokens,
    tokenLimit: row.limit_tokens,
  };
};
