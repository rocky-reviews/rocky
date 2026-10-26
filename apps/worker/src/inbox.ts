import {
  ForgeReadError,
  INSTALLATION_EVENT_TYPES,
  isInstallationEvent,
  type Clock,
} from "@rocky-reviews/core";
import {
  decodeClaimedDelivery,
  isErrorCode,
  LeaseLostError,
  type ClaimedDelivery,
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

/**
 * Drains installation events from the webhook inbox (P3-3, ADR 0009). Claims a batch of this
 * worker's forge with a lease (at most one row per installation at a time, older duplicates
 * superseded: migration 0007), re-validates each row, reconciles it with GitHub and records the
 * outcome. Nothing is claimed until the app check passed (review round 1, M2). Pull request
 * events are not claimed here: they wait for their consumer (P3-4).
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
 * S4). The lease covers a whole batch of these; a row whose lease has less than this left is
 * released untouched instead of started.
 */
export const ROW_BUDGET_SECONDS = 2 * 10 + 10;

export interface InboxDeps extends InstallationDeps {
  readonly log: Logger;
  /** Gate: nothing is claimed until the configured app is verified (M2). */
  readonly appCheck: AppCheck;
  /** Local clock for the lease budget (default: system time). */
  readonly clock?: Clock;
  /** Rows per claim (default 10). */
  readonly batchSize?: number;
  /** Lease per claim (default batchSize × ROW_BUDGET_SECONDS; never less). */
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

/** The lease for a batch: enough for every row's worst case (S4). */
export const leaseSecondsFor = (batchSize: number, requested?: number): number =>
  Math.max(requested ?? 0, batchSize * ROW_BUDGET_SECONDS);

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
  if (error instanceof ContradictionError) return "strike";
  const code = errorCodeOf(error);
  return TRANSIENT_SQLSTATE.test(code) ? "transient" : "strike";
};

type RowResult = "processed" | "retried" | "parked" | "lost";

const resultOf = (result: "retry" | "parked" | "stale"): RowResult =>
  result === "stale" ? "lost" : result === "parked" ? "parked" : "retried";

const processRow = async (deps: InboxDeps, row: ClaimedDelivery): Promise<RowResult> => {
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
  if (!decoded.ok || !isInstallationEvent(decoded.event)) {
    const result = await deps.db.failWebhookDelivery(row, {
      error: "invalid_event",
      retryAfterSeconds: 0,
      kind: "permanent",
    });
    deps.log.warn({ ...base, errorCode: "invalid_event", result }, "inbox row refused");
    return resultOf(result);
  }
  const event = decoded.event;
  try {
    const { outcome, completed } = await reconcileInstallation(deps, row, event);
    if (!completed && !(await deps.db.completeWebhookDelivery(row, outcome))) {
      deps.log.warn({ ...base, outcome }, "inbox lease lost before completion");
      return "lost";
    }
    deps.log.info(
      { ...base, eventType: event.type, installationId: event.installationId, outcome },
      "installation event processed",
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
    const line = { ...base, installationId: event.installationId, errorCode: code, kind, result };
    if (result === "parked") deps.log.error(line, "installation event parked");
    else deps.log.warn(line, "installation event failed");
    return resultOf(result);
  }
};

/** Claims and processes one batch. Returns what happened; never throws for a single row. */
export const drainInstallationEvents = async (deps: InboxDeps): Promise<DrainReport> => {
  if (!(await deps.appCheck.ready())) return EMPTY;
  const clock = deps.clock ?? { now: () => new Date() };
  const batchSize = deps.batchSize ?? 10;
  const rows = await deps.db.claimWebhookDeliveries({
    forge: deps.forge.kind,
    eventTypes: INSTALLATION_EVENT_TYPES,
    limit: batchSize,
    leaseSeconds: leaseSecondsFor(batchSize, deps.leaseSeconds),
  });
  const counts = { processed: 0, retried: 0, parked: 0, lost: 0 };
  for (const row of rows) {
    let result: RowResult;
    try {
      if (clock.now().getTime() + ROW_BUDGET_SECONDS * 1000 > row.leaseUntil.getTime()) {
        // Not enough lease left to finish this row safely: hand it back untouched (S4).
        const released = await deps.db.failWebhookDelivery(row, {
          error: "lease_budget",
          retryAfterSeconds: 0,
          kind: "transient",
        });
        deps.log.warn(
          { deliveryId: row.deliveryId, errorCode: "lease_budget", result: released },
          "inbox row released unstarted",
        );
        result = resultOf(released);
      } else {
        result = await processRow(deps, row);
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
