import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  DEFAULT_ANALYSIS_TOKEN_LIMIT,
  estimateAnalysisTokens,
  ForgeReadError,
  isLlmCallError,
  type Clock,
  type Forge,
  type ForgeDiff,
  type LlmRoles,
} from "@rocky-reviews/core";
import {
  ANALYSIS_MAX_ATTEMPTS,
  ANALYSIS_MAX_RETRY_DELAY_MS,
  completeAnalysis,
  failAnalysis,
  holdAnalysis,
  loadAnalysisTarget,
  loadPreviousAnalysis,
  recordLlmUsage,
  releaseAnalysis,
  requeueAnalysis,
  type ClaimedAnalysis,
  type Db,
} from "@rocky-reviews/db";
import {
  meterRoles,
  type LlmConfig,
  type LlmUsageTargets,
  type MeteredRoles,
} from "@rocky-reviews/llm";
import type { Logger } from "@rocky-reviews/log";

/**
 * Runs one claimed analysis (P4-3, ADR 0014 §7; the queue lane and the token limit P4-6, ADR
 * 0017): load the row this lease holds, read the revision's diff from the forge on a
 * repository-scoped, read-only session, estimate its tokens, run the pipeline, store the outcome.
 *
 * - Everything tenant-scoped happens inside `withOrg` for the analysis's org.
 * - The forge is only read: `RepositorySession` has no write methods, and nothing here posts.
 *   Model output ends in `analyses.document` as data for a human (ADR 0004 §5).
 * - Logs carry ids, counts, sizes and fixed codes; never the title, a path, the diff, a prompt or
 *   model output.
 * - Before any model call, the diff after rules pre-triage is estimated (`estimateAnalysisTokens`);
 *   over the per-PR limit, and over what a person approved for this row ("Analyze anyway"), the
 *   row waits as `awaiting_approval` with the estimate and nothing is sent to a model.
 * - Retryable failures (LLM outages, cancellation, forge outages) put the row back in the queue
 *   after a backoff that honours the provider's retry hint, up to ANALYSIS_MAX_ATTEMPTS claims;
 *   then the failure code is stored. Everything else stores a failure code at once.
 * - Every write needs the claim's lease: a run whose lease expired (and was reclaimed by another
 *   worker) writes nothing (`lease_lost`).
 * - Metering (P4-5, ADR 0016): the pipeline only ever sees the roles wrapped by `meterRoles`, so
 *   every call writes its `llm_usage` rows (in its own short tenant transaction, before its result
 *   is used) for this org and analysis. A usage write that fails for good stops the run: the
 *   usage is logged as numbers, nothing else is sent to a model, and the row fails as
 *   `metering_failed` (not retried automatically, so a broken ledger cannot loop spend). The
 *   totals are logged next to the token estimate, which is how the estimate is checked against
 *   real usage (ADR 0017 §8).
 */

/** The longest diff read for an analysis; a longer one fails as `diff_truncated` (P4-6). */
export const ANALYSIS_DIFF_MAX_BYTES = 1024 * 1024;

export interface AnalysisRunnerDeps {
  /** A login under which `withOrg` applies RLS (the worker's or the server's). */
  readonly db: Db;
  readonly forge: Forge;
  /** The configured roles, unmetered: `runAnalysis` wraps them for each run. */
  readonly llm: LlmRoles;
  /** From `usageTargetsFor(config)`: names provider and model for calls that never answered. */
  readonly usageTargets: LlmUsageTargets;
  readonly clock: Clock;
  readonly log: Logger;
  /** From `unitKeySaltFor(config)`: a role-config change re-analyses every file. */
  readonly unitKeySalt: string;
  readonly version?: string;
  readonly maxDiffBytes?: number;
  /** The per-PR token limit (`ROCKY_ANALYSIS_TOKEN_LIMIT`, default 150 000). */
  readonly tokenLimit?: number;
}

export type AnalysisRun =
  | { readonly outcome: "done" }
  | { readonly outcome: "failed"; readonly code: string }
  | {
      readonly outcome: "awaiting_approval";
      readonly estimatedTokens: number;
      readonly tokenLimit: number;
    }
  /** The lease is no longer held (expired and reclaimed, or not this org's): nothing written. */
  | { readonly outcome: "lease_lost" }
  /** The worker is stopping: handed back, claimable now, no attempt spent (review round 1, SF5). */
  | { readonly outcome: "released" }
  | { readonly outcome: "retry"; readonly code: string; readonly retryAfterMs: number };

/**
 * First retry after 30 s, doubling, at most an hour; never sooner than the provider asks. A hint
 * that is not a finite number is ignored (review round 1, N5).
 */
export const analysisRetryDelayMs = (attempts: number, retryAfterMs?: number): number => {
  const hint = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.min(
    Math.max(Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000), Math.ceil(hint)),
    ANALYSIS_MAX_RETRY_DELAY_MS,
  );
};

/**
 * The abort reason the lane gives when the worker stops (review round 1, SF5): the run hands
 * its row back instead of spending a retry on it.
 */
export class WorkerStopping extends Error {
  override readonly name = "WorkerStopping";
  constructor() {
    super("worker stopping");
  }
}

const MAX_STORED_ESTIMATE = 2 ** 31 - 1;

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * A digest of what shapes triage and review answers: the two roles' provider, model, effort and
 * platform model, and their providers' non-secret settings. Config holds no secrets (ADR 0012 §4).
 */
export const unitKeySaltFor = (config: LlmConfig): string =>
  sha256Hex(
    JSON.stringify(
      (["triage", "review"] as const).map((role) => {
        const target = config.roles[role];
        return [role, target, config.providers[target.provider] ?? null];
      }),
    ),
  );

const utf8 = new TextDecoder("utf-8", { fatal: true });

const decode = (diff: ForgeDiff): string | undefined => {
  try {
    return utf8.decode(diff.bytes);
  } catch {
    return undefined;
  }
};

class RunFailed extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const runAnalysis = async (
  deps: AnalysisRunnerDeps,
  claim: ClaimedAnalysis,
  options: { readonly signal?: AbortSignal } = {},
): Promise<AnalysisRun> => {
  const { db, log } = deps;
  const { orgId, analysisId } = claim;
  // Fail closed: no run without metering.
  if (typeof deps.usageTargets !== "object" || deps.usageTargets === null) {
    throw new TypeError("runAnalysis needs usageTargets (metering, P4-5)");
  }
  const target = await db.withOrg(orgId, (tx) => loadAnalysisTarget(tx, claim));
  if (target === undefined) return { outcome: "lease_lost" };

  const llm: MeteredRoles = meterRoles(deps.llm, {
    // Its own transaction per call: usage survives whatever happens to the analysis row.
    sink: { record: (records) => db.withOrg(orgId, (tx) => recordLlmUsage(tx, records)) },
    targets: deps.usageTargets,
    log,
    analysisId,
    clock: deps.clock,
  });

  const lost = (): AnalysisRun => {
    log.warn({ analysisId, attempt: claim.attempts }, "analysis lease lost");
    return { outcome: "lease_lost" };
  };
  const fail = async (code: string): Promise<AnalysisRun> => {
    if (!(await db.withOrg(orgId, (tx) => failAnalysis(tx, claim, code)))) return lost();
    log.warn({ analysisId, code, attempt: claim.attempts }, "analysis failed");
    return { outcome: "failed", code };
  };
  const stopping = (): boolean =>
    options.signal?.aborted === true && options.signal.reason instanceof WorkerStopping;
  const release = async (): Promise<AnalysisRun> => {
    if (!(await db.withOrg(orgId, (tx) => releaseAnalysis(tx, claim)))) return lost();
    log.info({ analysisId, attempt: claim.attempts }, "analysis released");
    return { outcome: "released" };
  };
  const retry = async (code: string, hintMs?: number): Promise<AnalysisRun> => {
    // Bounded: the last attempt stores the code as the failure.
    if (claim.attempts >= ANALYSIS_MAX_ATTEMPTS) return fail(code);
    const retryAfterMs = analysisRetryDelayMs(claim.attempts, hintMs);
    if (!(await db.withOrg(orgId, (tx) => requeueAnalysis(tx, claim, code, retryAfterMs)))) {
      return lost();
    }
    log.warn({ analysisId, code, attempt: claim.attempts, retryAfterMs }, "analysis requeued");
    return { outcome: "retry", code, retryAfterMs };
  };

  try {
    // Review round 1, SF3: a revision a later push replaced, or of a pull request that is no
    // longer open, is not analysed at all (no forge read, no estimate, no model call).
    if (target.superseded) throw new RunFailed("superseded");
    const installation = await db.withOrg(orgId, (tx) =>
      tx.query<{ installation_id: string }>("select installation_id from orgs where id = $1", [
        tx.orgId,
      ]),
    );
    const installationId = Number(installation.rows[0]?.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw new RunFailed("no_org");
    const [owner, name, ...rest] = target.fullName.split("/");
    if (owner === undefined || name === undefined || rest.length > 0) {
      throw new RunFailed("invalid_request");
    }

    const session = await deps.forge.openRepository({
      installationId,
      repositoryId: target.forgeRepoId,
    });
    if (session === null) throw new RunFailed("repository_inaccessible");
    let diff: ForgeDiff;
    try {
      diff = await session.getDiff(
        { baseSha: target.baseSha, headSha: target.headSha },
        { maxBytes: deps.maxDiffBytes ?? ANALYSIS_DIFF_MAX_BYTES },
      );
    } finally {
      await session.close();
    }
    if (diff.truncation === "unavailable") throw new RunFailed("diff_unavailable");
    const text = decode(diff);
    if (text === undefined) throw new RunFailed("diff_not_utf8");

    const previous = await db.withOrg(orgId, (tx) =>
      loadPreviousAnalysis(tx, target.pullRequestId, analysisId),
    );

    // The per-PR token limit, before any model call. A truncated diff is refused by the pipeline
    // itself (no model call), so it is not held for approval first.
    const tokenLimit = deps.tokenLimit ?? DEFAULT_ANALYSIS_TOKEN_LIMIT;
    const estimate = diff.truncated
      ? undefined
      : estimateAnalysisTokens(text, { previous, sha256Hex, unitKeySalt: deps.unitKeySalt });
    if (
      estimate !== undefined &&
      estimate.tokens > Math.max(tokenLimit, target.approvedTokens ?? 0)
    ) {
      const estimatedTokens = Math.min(estimate.tokens, MAX_STORED_ESTIMATE);
      const held = await db.withOrg(orgId, (tx) =>
        holdAnalysis(tx, claim, { estimatedTokens, tokenLimit }),
      );
      if (!held) return lost();
      log.info(
        // `estimate`, not `estimatedTokens`: the logger redacts unknown *tokens keys (a safety net).
        {
          analysisId,
          estimate: estimatedTokens,
          tokenLimit,
          files: estimate.files,
          sent: estimate.sent,
        },
        "analysis awaiting approval",
      );
      return { outcome: "awaiting_approval", estimatedTokens, tokenLimit };
    }

    if (stopping()) return await release();
    const outcome = await analyzePullRequest(
      {
        repo: { owner, name },
        pullRequest: { number: target.number, title: target.title },
        base: { sha: target.baseSha },
        head: { sha: target.headSha },
        diff: text,
        diffTruncated: diff.truncated,
        previous,
        signal: options.signal,
      },
      {
        llm,
        clock: deps.clock,
        sha256Hex,
        generator: {
          name: "rocky",
          ...(deps.version === undefined ? {} : { version: deps.version }),
        },
        unitKeySalt: deps.unitKeySalt,
      },
    );
    const metered = llm.totals();
    log.info(
      {
        analysisId,
        outcome: outcome.status,
        diffBytes: diff.bytes.byteLength,
        estimate: estimate?.tokens,
        ...outcome.stats,
        llmCalls: metered.calls,
        llmUsageRecords: metered.records,
        costMicroUsd: metered.costMicroUsd,
        unpricedRecords: metered.unpriced,
      },
      "analysis ran",
    );
    if (llm.failed) return await fail("metering_failed");
    if (outcome.status === "failed") return await fail(outcome.code);
    const stored = await db.withOrg(orgId, (tx) =>
      completeAnalysis(tx, claim, outcome.document, outcome.units),
    );
    // The lease expired and another worker holds the row now: nothing of ours was written.
    return stored ? { outcome: "done" } : lost();
  } catch (error) {
    // A broken ledger fails closed first, even during a stop (never retried or released).
    if (llm.failed) return fail("metering_failed");
    // Whatever the stop interrupted (a cancelled call, a forge read), the row goes back as it was.
    if (stopping()) return release();
    if (error instanceof RunFailed) return fail(error.code);
    if (isLlmCallError(error)) {
      // Fatal kinds came back as failure codes from the pipeline; only these reach here.
      return retry(`llm_${error.kind}`, error.retryAfterMs);
    }
    if (error instanceof ForgeReadError) {
      return error.transient ? retry(error.code) : fail(error.code);
    }
    return fail("internal_error");
  }
};
