import type {
  Clock,
  CodeReader,
  EmbeddingSpace,
  Forge,
  LlmRoles,
  OrgErasers,
  OrgId,
} from "@rocky-reviews/core";
import { runMemoryDecay, runRetention, type Db } from "@rocky-reviews/db";
import type { LlmUsageTargets } from "@rocky-reviews/llm";
import type { Logger } from "@rocky-reviews/log";
import { runAnalysis } from "./analysis.js";
import { createAnalysisLane, type AnalysisLane } from "./analysis-lane.js";
import { createAppCheck } from "./app-check.js";
import { runCodeIndex } from "./code-index.js";
import { sweepOrgDeletions } from "./deletion-sweep.js";
import type { FileChunker } from "@rocky-reviews/indexer";
import {
  drainInstallationEvents,
  drainOrgMemberEvents,
  drainPullRequestEvents,
  drainRepositoryEvents,
} from "./inbox.js";
import { createIndexLane, type IndexLane } from "./index-lane.js";

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
  /** Project memory decay (P8-4; default 6 h). */
  readonly memoryDecayMs: number;
  /** Analysis queue claims (default 2 s). */
  readonly analysisMs: number;
  /** Repository index claims (P9-1; default 10 s). */
  readonly indexMs: number;
}

export const DEFAULT_INTERVALS: JobIntervals = {
  inboxMs: 2_000,
  analysisMs: 2_000,
  indexMs: 10_000,
  sweepMs: 15 * 60_000,
  retentionMs: 6 * 60 * 60_000,
  memoryDecayMs: 6 * 60 * 60_000,
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
  readonly forge: (Forge & CodeReader) | undefined;
  /**
   * The analysis lane (P4-6), only with `ROCKY_ANALYSIS_AUTO=on`. Without it the mirror queues
   * nothing and nothing is claimed. Needs `forge`.
   */
  readonly analysis?: AnalysisJobConfig;
  /**
   * The repository index (P9-1), only with `ROCKY_INDEX_AUTO=on` and an embed role. Without it
   * push events are finished as `indexing_off` and nothing is claimed. Needs `forge`.
   */
  readonly index?: IndexJobConfig;
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

export interface IndexJobConfig {
  readonly llm: LlmRoles;
  readonly usageTargets: LlmUsageTargets;
  /** The embed role's space (`ROCKY_LLM_EMBED_*`). */
  readonly space: EmbeddingSpace;
  readonly chunker: FileChunker;
  readonly tokenLimit: number;
  /** Index runs this worker runs at once (default 1). */
  readonly concurrency?: number;
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
  let indexLane: IndexLane | undefined;

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

    // Pushes to default branches (P9-1): queue the repository's index, or finish as off.
    const pushBatchSize = 10;
    every("repository_events", intervals.inboxMs, async () => {
      const report = await drainRepositoryEvents({
        db: deps.db,
        forge,
        appCheck,
        clock: deps.clock,
        log: deps.log,
        batchSize: pushBatchSize,
        indexing: deps.index !== undefined,
      });
      if (report.claimed > 0) {
        deps.log.info({ job: "repository_events", ...report }, "inbox drained");
      }
      return report.claimed === pushBatchSize && report.processed + report.parked === pushBatchSize;
    });

    // Repository index runs (P9-1, ADR 0040): one per org at a time, across every worker.
    if (deps.index !== undefined) {
      const index = deps.index;
      const created = createIndexLane(
        {
          db: deps.db,
          log: deps.log,
          run: (claim, signal) =>
            runCodeIndex(
              {
                db: deps.db,
                forge,
                llm: index.llm,
                usageTargets: index.usageTargets,
                space: index.space,
                chunker: index.chunker,
                log: deps.log,
                clock: deps.clock,
                tokenLimit: index.tokenLimit,
              },
              claim,
              { signal },
            ),
        },
        { slots: index.concurrency ?? 1 },
      );
      indexLane = created;
      every("code_index", intervals.indexMs, async () => {
        if (!(await appCheck.ready())) return false;
        const started = await created.tick();
        if (started > 0) {
          deps.log.info(
            { job: "code_index", started, inFlight: created.inFlight },
            "index started",
          );
        }
        return false;
      });
    }

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

  // Project memory decay (P8-4, ADR 0038): per org inside withOrg, no GitHub read, so it runs
  // without the app credentials like retention. Counts and codes only.
  every("memory_decay", intervals.memoryDecayMs, async () => {
    const report = await runMemoryDecay(deps.db, { clock: deps.clock });
    deps.log.info(
      {
        job: "memory_decay",
        orgs: report.orgs,
        decayed: report.decayed,
        retired: report.retired,
        purged: report.purged,
        failed: report.failures.length,
        // Distinct error codes of the failed orgs (a key with "code" in it would be redacted).
        failures: [...new Set(report.failures.map((f) => f.errorCode))],
      },
      "memory decay done",
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
        await Promise.allSettled([
          ...running,
          ...(lane === undefined ? [] : [lane.stop()]),
          ...(indexLane === undefined ? [] : [indexLane.stop()]),
        ]);
      })();
      return stopping;
    },
  };
};
