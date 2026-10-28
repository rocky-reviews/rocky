import type { Clock, Forge, LlmRoles, OrgErasers, OrgId } from "@rocky-reviews/core";
import { runRetention, type Db } from "@rocky-reviews/db";
import type { LlmUsageTargets } from "@rocky-reviews/llm";
import type { Logger } from "@rocky-reviews/log";
import { runAnalysis } from "./analysis.js";
import { createAnalysisLane, type AnalysisLane } from "./analysis-lane.js";
import { createAppCheck } from "./app-check.js";
import { sweepOrgDeletions } from "./deletion-sweep.js";
import { drainInstallationEvents, drainOrgMemberEvents, drainPullRequestEvents } from "./inbox.js";

/**
 * The worker's recurring jobs (P3-3, P3-4; the analysis lane P4-6). Each runs on its own timer,
 * never overlapping itself;
 * all are idempotent and safe with several workers (the inbox claim skips locked rows, retention
 * deletes by cutoff, the sweep locks each org). A failing run is logged by code and retried at
 * the next tick. The inbox lanes (installations, pull requests) and the sweep act on GitHub's
 * answers, so they need the app credentials and wait for the app check (review round 1, M2,
 * S1c); retention does not.
 */

export interface JobIntervals {
  /** Inbox polling (default 2 s; immediately again while batches come back full). */
  readonly inboxMs: number;
  /** Deletion sweep (default 15 min). */
  readonly sweepMs: number;
  /** Retention purge (default 6 h). */
  readonly retentionMs: number;
  /** Analysis queue claims (default 2 s). */
  readonly analysisMs: number;
}

export const DEFAULT_INTERVALS: JobIntervals = {
  inboxMs: 2_000,
  analysisMs: 2_000,
  sweepMs: 15 * 60_000,
  retentionMs: 6 * 60 * 60_000,
};

export interface JobDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly clock: Clock;
  readonly erasers: OrgErasers;
  readonly newOrgId: () => OrgId;
  /**
   * Without it (no app credentials, development only) installation and pull request events wait
   * in the inbox and no org is erased (the sweep re-verifies every uninstall with GitHub first).
   */
  readonly forge: Forge | undefined;
  /**
   * The analysis lane (P4-6), only with `ROCKY_ANALYSIS_AUTO=on`. Without it the mirror queues
   * nothing and nothing is claimed. Needs `forge`.
   */
  readonly analysis?: AnalysisJobConfig;
  readonly intervals?: Partial<JobIntervals>;
}

export interface AnalysisJobConfig {
  /** Built and validated at boot (P4-3). */
  readonly llm: LlmRoles;
  /** `unitKeySaltFor(config.llm)`. */
  readonly unitKeySalt: string;
  /** `usageTargetsFor(config.llm)`: every run's roles are metered (P4-5, ADR 0016). */
  readonly usageTargets: LlmUsageTargets;
  readonly tokenLimit: number;
  /** Analyses this worker runs at once. */
  readonly concurrency: number;
  /** Analyses one org runs at once, across every worker. */
  readonly orgConcurrency: number;
  readonly version?: string;
}

export interface RunningJobs {
  /** Stops scheduling and waits for runs in progress. Idempotent. */
  stop(): Promise<void>;
}

const codeOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$|^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "internal_error";
};

export const startJobs = (deps: JobDeps): RunningJobs => {
  const intervals = { ...DEFAULT_INTERVALS, ...deps.intervals };
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const running = new Set<Promise<void>>();
  let lane: AnalysisLane | undefined;

  /** `task` returns true to run again right away (more work is waiting). */
  const every = (name: string, ms: number, task: () => Promise<boolean>): void => {
    const tick = (): void => {
      if (stopped) return;
      const run = (async () => {
        let again = false;
        try {
          again = await task();
        } catch (error) {
          deps.log.error({ job: name, errorCode: codeOf(error) }, "job failed");
        }
        if (!stopped) {
          const timer = setTimeout(
            () => {
              timers.delete(timer);
              tick();
            },
            again ? 0 : ms,
          );
          timers.add(timer);
        }
      })();
      running.add(run);
      void run.finally(() => running.delete(run));
    };
    tick();
  };

  // People who left the GitHub organization (P7-2): no GitHub read, so it runs without the app
  // credentials too. GitHub is the only forge adapter.
  const memberBatchSize = 20;
  const alwaysReady = { ready: () => Promise.resolve(true) };
  every("org_members", intervals.inboxMs, async () => {
    const report = await drainOrgMemberEvents({
      db: deps.db,
      forge: { kind: deps.forge?.kind ?? "github" },
      appCheck: alwaysReady,
      clock: deps.clock,
      log: deps.log,
      batchSize: memberBatchSize,
    });
    if (report.claimed > 0) deps.log.info({ job: "org_members", ...report }, "inbox drained");
    return (
      report.claimed === memberBatchSize && report.processed + report.parked === memberBatchSize
    );
  });

  if (deps.forge === undefined) {
    deps.log.warn(
      "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY not set: installation and pull request events stay in the inbox and no org is erased (development only)",
    );
  } else {
    const forge = deps.forge;
    const appCheck = createAppCheck({ forge, clock: deps.clock, log: deps.log });
    const batchSize = 10;
    every("inbox", intervals.inboxMs, async () => {
      const report = await drainInstallationEvents({
        db: deps.db,
        forge,
        appCheck,
        clock: deps.clock,
        log: deps.log,
        newOrgId: deps.newOrgId,
        batchSize,
      });
      if (report.claimed > 0) deps.log.info({ job: "inbox", ...report }, "inbox drained");
      // Again at once only after a full batch that all went through: a batch with released,
      // retried or lost rows waits for the next tick (no hot loop, review round 2 SF3).
      return report.claimed === batchSize && report.processed + report.parked === batchSize;
    });

    // Pull requests: their own lane and batch (each row may read a diff, PR_ROW_BUDGET_SECONDS).
    const prBatchSize = 5;
    every("pull_requests", intervals.inboxMs, async () => {
      const report = await drainPullRequestEvents({
        db: deps.db,
        forge,
        appCheck,
        clock: deps.clock,
        log: deps.log,
        batchSize: prBatchSize,
        // New heads are queued for analysis only with the lane configured (ROCKY_ANALYSIS_AUTO).
        enqueueAnalyses: deps.analysis !== undefined,
      });
      if (report.claimed > 0) deps.log.info({ job: "pull_requests", ...report }, "inbox drained");
      return report.claimed === prBatchSize && report.processed + report.parked === prBatchSize;
    });

    // Analyses (P4-6, ADR 0017): claimed fairly across orgs, run without blocking this timer.
    if (deps.analysis !== undefined) {
      const analysis = deps.analysis;
      const analysisLane = createAnalysisLane(
        {
          db: deps.db,
          log: deps.log,
          run: (claim, signal) =>
            runAnalysis(
              {
                db: deps.db,
                forge,
                llm: analysis.llm,
                clock: deps.clock,
                log: deps.log,
                unitKeySalt: analysis.unitKeySalt,
                usageTargets: analysis.usageTargets,
                tokenLimit: analysis.tokenLimit,
                ...(analysis.version === undefined ? {} : { version: analysis.version }),
              },
              claim,
              { signal },
            ),
        },
        { slots: analysis.concurrency, orgConcurrency: analysis.orgConcurrency },
      );
      lane = analysisLane;
      every("analyses", intervals.analysisMs, async () => {
        const started = await analysisLane.tick();
        if (started > 0) {
          deps.log.info(
            { job: "analyses", started, inFlight: analysisLane.inFlight },
            "analyses started",
          );
        }
        return false;
      });
    }

    every("org_deletion_sweep", intervals.sweepMs, async () => {
      const report = await sweepOrgDeletions({
        db: deps.db,
        forge,
        appCheck,
        erasers: deps.erasers,
        log: deps.log,
      });
      if (report.due > 0) deps.log.info({ job: "org_deletion_sweep", ...report }, "sweep done");
      return false;
    });
  }

  every("retention", intervals.retentionMs, async () => {
    const report = await runRetention(deps.db, { clock: deps.clock });
    deps.log.info(
      {
        job: "retention",
        deleted: Object.fromEntries(report.categories.map((c) => [c.category, c.deleted])),
      },
      "retention done",
    );
    return false;
  });

  let stopping: Promise<void> | undefined;
  return {
    stop: () => {
      stopping ??= (async () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        await Promise.allSettled([...running, ...(lane === undefined ? [] : [lane.stop()])]);
      })();
      return stopping;
    },
  };
};
