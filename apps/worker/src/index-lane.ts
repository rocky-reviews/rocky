import { finishCodeIndex, type ClaimedCodeIndex, type Db } from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";
import { INDEX_LEASE_SECONDS, type CodeIndexRunReport } from "./code-index.js";

/**
 * The repository index lane (P9-1, ADR 0040). Each tick claims into this worker's free slots
 * through `Db.claimCodeIndexes` (cross-tenant; one running index per org across every worker,
 * expired leases reclaimed first) and starts each run without waiting for it. A run renews its
 * own lease between batches and stops when it is lost. Stopping aborts the runs (each ends as a
 * retry) and waits for them; rows claimed while stopping are handed back at once.
 */

export interface IndexLaneDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly run: (claim: ClaimedCodeIndex, signal: AbortSignal) => Promise<CodeIndexRunReport>;
}

export interface IndexLane {
  tick(): Promise<number>;
  idle(): Promise<void>;
  readonly inFlight: number;
  stop(): Promise<void>;
}

const codeOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$|^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "internal_error";
};

export const createIndexLane = (
  deps: IndexLaneDeps,
  options: { readonly slots: number; readonly leaseSeconds?: number },
): IndexLane => {
  const leaseSeconds = options.leaseSeconds ?? INDEX_LEASE_SECONDS;
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

  const start = (claim: ClaimedCodeIndex): void => {
    const controller = new AbortController();
    const done = (async () => {
      try {
        await deps.run(claim, controller.signal);
      } catch (error) {
        deps.log.error(
          { indexId: claim.indexId, errorCode: codeOf(error) },
          "code index run left to its lease",
        );
      } finally {
        runs.delete(claim.indexId);
        settle();
      }
    })();
    runs.set(claim.indexId, { controller, done });
  };

  const claimNow = async (): Promise<number> => {
    const free = options.slots - runs.size;
    if (stopped || free <= 0) return 0;
    const claims = await deps.db.claimCodeIndexes({ limit: free, leaseSeconds });
    const released: Promise<unknown>[] = [];
    for (const claim of claims) {
      if (stopped) {
        released.push(
          deps.db
            .withOrg(claim.orgId, (tx) =>
              finishCodeIndex(tx, claim, {
                kind: "retry",
                errorCode: "worker_stopping",
                delaySeconds: 0,
              }),
            )
            .catch(() => undefined),
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
        for (const { controller } of runs.values()) controller.abort();
        await Promise.allSettled([...runs.values()].map((r) => r.done));
      })();
      return stopping;
    },
  };
};
