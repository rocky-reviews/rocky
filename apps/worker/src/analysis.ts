import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  ForgeReadError,
  isLlmCallError,
  type Clock,
  type Forge,
  type ForgeDiff,
  type LlmRoles,
  type OrgId,
} from "@rocky-reviews/core";
import {
  completeAnalysis,
  failAnalysis,
  loadPreviousAnalysis,
  recordLlmUsage,
  requeueAnalysis,
  startAnalysis,
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
 * Runs one queued analysis (P4-3, ADR 0014 §7): claim the row, read the revision's diff from the
 * forge on a repository-scoped, read-only session, run the pipeline, store the outcome.
 *
 * - Everything tenant-scoped happens inside `withOrg` for the analysis's org.
 * - The forge is only read: `RepositorySession` has no write methods, and nothing here posts.
 *   Model output ends in `analyses.document` as data for a human (ADR 0004 §5).
 * - Logs carry ids, counts, sizes and fixed codes; never the title, a path, the diff, a prompt or
 *   model output.
 * - Retryable failures (LLM outages, cancellation, forge outages) put the row back in the queue
 *   and return the provider's retry hint; the lane that calls this (with the queue's org
 *   concurrency cap, P4-6) schedules the retry. Everything else stores a failure code.
 * - Metering (P4-5, ADR 0015): the pipeline only ever sees the roles wrapped by `meterRoles`, so
 *   every call writes its `llm_usage` rows (in its own short tenant transaction, before its result
 *   is used) for this org and analysis. A usage write that fails for good stops the run: the
 *   usage is logged as numbers, nothing else is sent to a model, and the row fails as
 *   `metering_failed` (not retried automatically, so a broken ledger cannot loop spend).
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
}

export type AnalysisRun =
  | { readonly outcome: "done" }
  | { readonly outcome: "failed"; readonly code: string }
  | { readonly outcome: "not_queued" }
  | { readonly outcome: "retry"; readonly code: string; readonly retryAfterMs?: number };

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
  orgId: OrgId,
  analysisId: string,
): Promise<AnalysisRun> => {
  const { db, log } = deps;
  // Fail closed: no run without metering.
  if (typeof deps.usageTargets !== "object" || deps.usageTargets === null) {
    throw new TypeError("runAnalysis needs usageTargets (metering, P4-5)");
  }
  const target = await db.withOrg(orgId, (tx) => startAnalysis(tx, analysisId));
  if (target === undefined) return { outcome: "not_queued" };

  const llm: MeteredRoles = meterRoles(deps.llm, {
    // Its own transaction per call: usage survives whatever happens to the analysis row.
    sink: { record: (records) => db.withOrg(orgId, (tx) => recordLlmUsage(tx, records)) },
    targets: deps.usageTargets,
    log,
    analysisId,
    clock: deps.clock,
  });

  const fail = async (code: string): Promise<AnalysisRun> => {
    await db.withOrg(orgId, (tx) => failAnalysis(tx, analysisId, code));
    log.warn({ analysisId, code }, "analysis failed");
    return { outcome: "failed", code };
  };
  const retry = async (code: string, retryAfterMs?: number): Promise<AnalysisRun> => {
    await db.withOrg(orgId, (tx) => requeueAnalysis(tx, analysisId));
    log.warn({ analysisId, code, retryAfterMs }, "analysis requeued");
    return { outcome: "retry", code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  };

  try {
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
    const outcome = await analyzePullRequest(
      {
        repo: { owner, name },
        pullRequest: { number: target.number, title: target.title },
        base: { sha: target.baseSha },
        head: { sha: target.headSha },
        diff: text,
        diffTruncated: diff.truncated,
        previous,
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
      completeAnalysis(tx, analysisId, outcome.document, outcome.units),
    );
    // Lost the row (another worker requeued and finished it): nothing of ours was written.
    return stored ? { outcome: "done" } : { outcome: "not_queued" };
  } catch (error) {
    if (llm.failed) return fail("metering_failed");
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
