import {
  releaseAnalysis,
  renewAnalysisLease,
  type AnalysisStoreError,
  type ClaimedAnalysis,
  type Db,
} from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";
import { WorkerStopping, type AnalysisRun } from "./analysis.js";

/**
 * The analysis queue lane (P4-6, ADR 0017). Each tick claims as many queued analyses as this
 * worker has free slots, through `Db.claimAnalyses` (cross-tenant, fair: a per-org cap on
 * running rows across every worker, round-robin across orgs, expired leases reclaimed first),
 * and starts each one without waiting for it. While a run lasts its lease is renewed; a renewal
 * that finds the lease gone aborts the run (another worker may hold the row now, and nothing of
 * this run can be written anyway). Stopping aborts every run with `WorkerStopping` and waits for
 * them: `runAnalysis` hands the row back without spending an attempt (review round 1, SF5), or
 * it is left to its lease.
 *
 * Logs carry ids, counts and codes; `runAnalysis` logs each outcome.
 */

export interface AnalysisLaneOptions {
  /** Analyses this worker runs at once. */
  readonly slots: number;
  /** Running analyses per org, across every worker (enforced by the claim). */
  readonly orgConcurrency: number;
  /** Lease per claim (default 600 s); renewed every third of it while the run lasts. */
  readonly leaseSeconds?: number;
  /** Renewal period (default a third of the lease). */
  readonly renewEveryMs?: number;
}

export interface AnalysisLaneDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly run: (claim: ClaimedAnalysis, signal: AbortSignal) => Promise<AnalysisRun>;
}

export interface AnalysisLane {
  /** Claims into the free slots and starts the runs; resolves with how many started. */
  tick(): Promise<number>;
  /** Resolves once nothing is running. */
  idle(): Promise<void>;
  /** Runs in progress. */
  readonly inFlight: number;
  /** No more claims; aborts the runs in progress and waits for them. Idempotent. */
  stop(): Promise<void>;
}

export const DEFAULT_ANALYSIS_LEASE_SECONDS = 600;

const codeOf = (error: unknown): string => {
  const code = (error as Partial<AnalysisStoreError> | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$|^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "internal_error";
};

export const createAnalysisLane = (
  deps: AnalysisLaneDeps,
  options: AnalysisLaneOptions,
): AnalysisLane => {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_ANALYSIS_LEASE_SECONDS;
  const renewEveryMs = options.renewEveryMs ?? Math.floor((leaseSeconds * 1000) / 3);
  const runs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let idleWaiters: (() => void)[] = [];
  let stopped = false;
  let claiming: Promise<number> | undefined;

  const settle = (): void => {
    if (runs.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const renew = async (claim: ClaimedAnalysis, controller: AbortController): Promise<void> => {
    try {
      const held = await deps.db.withOrg(claim.orgId, (tx) =>
        renewAnalysisLease(tx, claim, leaseSeconds),
      );
      if (!held && !controller.signal.aborted) {
        deps.log.warn({ analysisId: claim.analysisId }, "analysis lease lost; run aborted");
        controller.abort();
      }
    } catch (error) {
      // The database is unreachable: keep running; the run's own writes check the lease.
      deps.log.warn(
        { analysisId: claim.analysisId, errorCode: codeOf(error) },
        "analysis lease not renewed",
      );
    }
  };

  const start = (claim: ClaimedAnalysis): void => {
    const controller = new AbortController();
    const timer = setInterval(() => void renew(claim, controller), renewEveryMs);
    timer.unref();
    const done = (async () => {
      try {
        await deps.run(claim, controller.signal);
      } catch (error) {
        // Recording the outcome failed too (a database outage): the lease expires and the next
        // claim takes the row again (ADR 0014 R3).
        deps.log.error(
          { analysisId: claim.analysisId, errorCode: codeOf(error) },
          "analysis left to its lease",
        );
      } finally {
        clearInterval(timer);
        runs.delete(claim.analysisId);
        settle();
      }
    })();
    runs.set(claim.analysisId, { controller, done });
  };

  const claimNow = async (): Promise<number> => {
    const free = options.slots - runs.size;
    if (stopped || free <= 0) return 0;
    const claims = await deps.db.claimAnalyses({
      limit: free,
      leaseSeconds,
      orgConcurrency: options.orgConcurrency,
    });
    const released: Promise<unknown>[] = [];
    for (const claim of claims) {
      if (stopped) {
        // Claimed while stopping: handed back at once, attempt returned (or left to its lease).
        released.push(
          deps.db.withOrg(claim.orgId, (tx) => releaseAnalysis(tx, claim)).catch(() => undefined),
        );
        continue;
      }
      start(claim);
    }
    await Promise.all(released);
    return stopped ? 0 : claims.length;
  };

  let stopping: Promise<void> | undefined;
  return {
    tick: () => {
      // One claim at a time per lane: overlapping ticks would over-fill the slots.
      claiming ??= claimNow().finally(() => {
        claiming = undefined;
      });
      return claiming;
    },
    idle: () =>
      runs.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
    get inFlight() {
      return runs.size;
    },
    stop: () => {
      stopping ??= (async () => {
        stopped = true;
        await claiming?.catch(() => undefined);
        for (const { controller } of runs.values()) controller.abort(new WorkerStopping());
        await Promise.allSettled([...runs.values()].map((r) => r.done));
      })();
      return stopping;
    },
  };
};
