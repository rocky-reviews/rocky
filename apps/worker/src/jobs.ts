import type { Clock, InstallationReader, OrgErasers, OrgId } from "@rocky-reviews/core";
import { runRetention, type Db } from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";
import { createAppCheck } from "./app-check.js";
import { sweepOrgDeletions } from "./deletion-sweep.js";
import { drainInstallationEvents } from "./inbox.js";

/**
 * The worker's recurring jobs (P3-3). Each runs on its own timer, never overlapping itself; all
 * are idempotent and safe with several workers (the inbox claim skips locked rows, retention
 * deletes by cutoff, the sweep locks each org). A failing run is logged by code and retried at
 * the next tick. The inbox and the sweep both act on GitHub's answers, so both need the app
 * credentials and wait for the app check (review round 1, M2, S1c); retention does not.
 */

export interface JobIntervals {
  /** Inbox polling (default 2 s; immediately again while batches come back full). */
  readonly inboxMs: number;
  /** Deletion sweep (default 15 min). */
  readonly sweepMs: number;
  /** Retention purge (default 6 h). */
  readonly retentionMs: number;
}

export const DEFAULT_INTERVALS: JobIntervals = {
  inboxMs: 2_000,
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
   * Without it (no app credentials, development only) installation events wait in the inbox and
   * no org is erased (the sweep re-verifies every uninstall with GitHub first).
   */
  readonly forge: InstallationReader | undefined;
  readonly intervals?: Partial<JobIntervals>;
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

  if (deps.forge === undefined) {
    deps.log.warn(
      "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY not set: installation events stay in the inbox and no org is erased (development only)",
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
      return report.claimed === batchSize;
    });

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
        await Promise.allSettled([...running]);
      })();
      return stopping;
    },
  };
};
