import {
  ForgeReadError,
  isInstallationEvent,
  isPullRequestEvent,
  type Clock,
  type ForgeEvent,
  type InstallationEvent,
  type PullRequestEvent,
} from "@rocky-reviews/core";
import {
  decodeClaimedDelivery,
  isErrorCode,
  laneEventTypes,
  LeaseLostError,
  type ClaimedDelivery,
  type Db,
  type InboxFailure,
} from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";
import type { AppCheck } from "./app-check.js";
import {
  ContradictionError,
  ParkDeliveryError,
  reconcileInstallation,
  type InstallationDeps,
} from "./installations.js";
import {
  OrgNotReadyError,
  PR_ROW_BUDGET_SECONDS,
  reconcilePullRequest,
  type PullRequestDeps,
} from "./pull-requests.js";

/**
 * Drains installation events from the webhook inbox (P3-3, ADR 0009). Claims a batch of this
 * worker's forge with a lease (at most one row per installation at a time, oldest first:
 * migration 0007), re-validates each row, reconciles it with GitHub and records the
 * outcome. Nothing is claimed until the app check passed (review round 1, M2). The same drain
 * consumes pull request events (P3-4, ADR 0010) in their own lane, with their own row budget.
 * Each drain claims whole lanes (`laneEventTypes`), so no lane head is ever skipped for its type;
 * a row of a type the lane's handler does not know is parked (`unhandled_event_type`).
 *
 * Failures never lose a row (review round 1, S3):
 * - transient (GitHub timeout, network, 5xx, 429, 401/403, a database outage): retried with
 *   exponential backoff up to an hour, no strike; parked only once the row is 72 h old;
 * - strike (GitHub contradicts the event, answers something malformed, a concurrent change):
 *   retried; parked after WEBHOOK_MAX_STRIKES;
 * - permanent (does not decode, another forge's row, contradicts an org binding): parked now.
 * Logs carry the delivery id, the outcome or error code and the attempt; never the event content.
 */

/**
 * Worst-case time for one row: two GitHub reads (the event's installation and, for a reinstall,
 * the previous one) at the reader's 10 s timeout, plus slack for the database (review round 1,
 * S4). The lease covers a whole batch of these plus one; a row whose lease has less than this
 * left is released untouched instead of started. "Left" is measured on the worker's own clock
 * from just before the claim, never against the database's `lease_until`, so clock skew cannot
 * release every row (review round 2, SF3).
 */
export const ROW_BUDGET_SECONDS = 2 * 10 + 10;

interface DrainDeps {
  readonly db: Db;
  readonly log: Logger;
  /** Gate: nothing is claimed until the configured app is verified (M2). */
  readonly appCheck: AppCheck;
  /** Local clock for the lease budget (default: system time). */
  readonly clock?: Clock;
  /** Rows per claim (default 10). */
  readonly batchSize?: number;
  /** Lease per claim (default (batchSize + 1) × ROW_BUDGET_SECONDS; never less). */
  readonly leaseSeconds?: number;
}

export interface DrainReport {
  readonly claimed: number;
  readonly processed: number;
  readonly retried: number;
  readonly parked: number;
  readonly lost: number;
}

const EMPTY: DrainReport = { claimed: 0, processed: 0, retried: 0, parked: 0, lost: 0 };

/** First retry after 30 s, doubling, at most an hour. */
export const retryDelaySeconds = (attempts: number): number =>
  Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);

/**
 * The lease for a batch: every row's worst case plus one budget of slack, so even the last row
 * of a full-speed batch (or the only row of a batch of one) starts with a full budget left (S4,
 * SF3). Strictly more than `batchSize × ROW_BUDGET_SECONDS`.
 */
export const leaseSecondsFor = (
  batchSize: number,
  requested?: number,
  rowBudgetSeconds: number = ROW_BUDGET_SECONDS,
): number => Math.max(requested ?? 0, (batchSize + 1) * rowBudgetSeconds);

const errorCodeOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return isErrorCode(code) ? code : "internal_error";
};

/**
 * SQLSTATE classes that describe the database's state, not the row: connection (08), rollback
 * such as serialization failures (40), resources (53), operator intervention (57), system (58).
 */
const TRANSIENT_SQLSTATE = /^(?:08|40|53|57|58)[0-9A-Z]{3}$/;

export const failureKindOf = (error: unknown): InboxFailure["kind"] => {
  if (error instanceof ParkDeliveryError) return "permanent";
  if (error instanceof ForgeReadError) return error.transient ? "transient" : "strike";
  if (error instanceof ContradictionError || error instanceof OrgNotReadyError) return "strike";
  const code = errorCodeOf(error);
  return TRANSIENT_SQLSTATE.test(code) ? "transient" : "strike";
};

type RowResult = "processed" | "retried" | "parked" | "lost";

const resultOf = (result: "retry" | "parked" | "stale"): RowResult =>
  result === "stale" ? "lost" : result === "parked" ? "parked" : "retried";

/** One lane of the inbox and what to do with its rows. */
interface Lane<E extends ForgeEvent> {
  readonly name: "installation" | "pull_request";
  /** Worst-case time for one row (the lease budget). */
  readonly rowBudgetSeconds: number;
  readonly accepts: (event: ForgeEvent) => event is E;
  readonly handle: (
    row: ClaimedDelivery,
    event: E,
  ) => Promise<{ readonly outcome: string; readonly completed: boolean }>;
  /** Ids worth logging for this lane's events (never content). */
  readonly ids: (event: E) => Record<string, number>;
  readonly label: string;
}

type LaneDeps = DrainDeps & { readonly forge: { readonly kind: ClaimedDelivery["forge"] } };

const processRow = async <E extends ForgeEvent>(
  deps: LaneDeps,
  lane: Lane<E>,
  row: ClaimedDelivery,
): Promise<RowResult> => {
  const base = { deliveryId: row.deliveryId, attempt: row.attempts, strikes: row.strikes };
  // Defence in depth: the claim already filters by forge (M3).
  if (row.forge !== deps.forge.kind) {
    const result = await deps.db.failWebhookDelivery(row, {
      error: "forge_mismatch",
      retryAfterSeconds: 0,
      kind: "permanent",
    });
    deps.log.error({ ...base, errorCode: "forge_mismatch", result }, "inbox row refused");
    return resultOf(result);
  }
  const decoded = decodeClaimedDelivery(row);
  if (!decoded.ok || !lane.accepts(decoded.event)) {
    // Whole-lane claims hand out every head; one this lane cannot handle is parked, never left
    // in front of the rows behind it.
    const error = decoded.ok ? "unhandled_event_type" : "invalid_event";
    const result = await deps.db.failWebhookDelivery(row, {
      error,
      retryAfterSeconds: 0,
      kind: "permanent",
    });
    deps.log.warn({ ...base, errorCode: error, result }, "inbox row refused");
    return resultOf(result);
  }
  const event = decoded.event;
  try {
    const { outcome, completed } = await lane.handle(row, event);
    if (!completed && !(await deps.db.completeWebhookDelivery(row, outcome))) {
      deps.log.warn({ ...base, outcome }, "inbox lease lost before completion");
      return "lost";
    }
    deps.log.info(
      { ...base, eventType: event.type, ...lane.ids(event), outcome },
      `${lane.label} event processed`,
    );
    return "processed";
  } catch (error) {
    if (error instanceof LeaseLostError) {
      // Another worker holds the row now; nothing was committed here.
      deps.log.warn({ ...base, errorCode: error.code }, "inbox lease lost");
      return "lost";
    }
    const kind = failureKindOf(error);
    const code = errorCodeOf(error);
    const result = await deps.db.failWebhookDelivery(row, {
      error: code,
      retryAfterSeconds: kind === "permanent" ? 0 : retryDelaySeconds(row.attempts),
      kind,
    });
    const line = { ...base, ...lane.ids(event), errorCode: code, kind, result };
    if (result === "parked") deps.log.error(line, `${lane.label} event parked`);
    else deps.log.warn(line, `${lane.label} event failed`);
    return resultOf(result);
  }
};

/** Claims and processes one batch of a lane. Returns what happened; never throws for a row. */
const drainLane = async <E extends ForgeEvent>(
  deps: LaneDeps,
  lane: Lane<E>,
): Promise<DrainReport> => {
  if (!(await deps.appCheck.ready())) return EMPTY;
  const clock = deps.clock ?? { now: () => new Date() };
  const batchSize = deps.batchSize ?? 10;
  const leaseSeconds = leaseSecondsFor(batchSize, deps.leaseSeconds, lane.rowBudgetSeconds);
  // Read before the claim, so the local deadline is never later than the database's.
  const deadline = clock.now().getTime() + leaseSeconds * 1000;
  const rows = await deps.db.claimWebhookDeliveries({
    forge: deps.forge.kind,
    eventTypes: laneEventTypes(lane.name),
    limit: batchSize,
    leaseSeconds,
  });
  const counts = { processed: 0, retried: 0, parked: 0, lost: 0 };
  for (const row of rows) {
    let result: RowResult;
    try {
      if (clock.now().getTime() + lane.rowBudgetSeconds * 1000 > deadline) {
        // Not enough lease left to finish this row safely: hand it back untouched (S4), with a
        // delay so a slow worker does not reclaim it at once (SF3).
        const released = await deps.db.failWebhookDelivery(row, {
          error: "lease_budget",
          retryAfterSeconds: lane.rowBudgetSeconds,
          kind: "transient",
        });
        deps.log.warn(
          { deliveryId: row.deliveryId, errorCode: "lease_budget", result: released },
          "inbox row released unstarted",
        );
        result = resultOf(released);
      } else {
        result = await processRow(deps, lane, row);
      }
    } catch (error) {
      // Even recording the failure failed (database down): the lease expires and the row is
      // claimed again later.
      deps.log.error(
        { deliveryId: row.deliveryId, errorCode: errorCodeOf(error) },
        "inbox row left to its lease",
      );
      result = "lost";
    }
    counts[result]++;
  }
  return { claimed: rows.length, ...counts };
};

export interface InboxDeps extends DrainDeps, InstallationDeps {}

/** Installation events (P3-3): the installation lifecycle. */
export const drainInstallationEvents = (deps: InboxDeps): Promise<DrainReport> =>
  drainLane<InstallationEvent>(deps, {
    name: "installation",
    rowBudgetSeconds: ROW_BUDGET_SECONDS,
    accepts: isInstallationEvent,
    handle: (row, event) => reconcileInstallation(deps, row, event),
    ids: (event) => ({ installationId: event.installationId }),
    label: "installation",
  });

export interface PullRequestInboxDeps extends DrainDeps, PullRequestDeps {}

/** Pull request events (P3-4): the mirror. */
export const drainPullRequestEvents = (deps: PullRequestInboxDeps): Promise<DrainReport> =>
  drainLane<PullRequestEvent>(deps, {
    name: "pull_request",
    rowBudgetSeconds: PR_ROW_BUDGET_SECONDS,
    accepts: isPullRequestEvent,
    handle: (row, event) => reconcilePullRequest(deps, row, event),
    ids: (event) => ({
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      number: event.number,
    }),
    label: "pull request",
  });
