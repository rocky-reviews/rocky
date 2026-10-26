import { INSTALLATION_EVENT_TYPES, isInstallationEvent } from "@rocky-reviews/core";
import {
  decodeClaimedDelivery,
  isErrorCode,
  LeaseLostError,
  type ClaimedDelivery,
} from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";
import {
  ParkDeliveryError,
  reconcileInstallation,
  type InstallationDeps,
} from "./installations.js";

/**
 * Drains installation events from the webhook inbox (P3-3, ADR 0009). Claims a batch with a
 * lease, re-validates each row, reconciles it with GitHub and records the outcome. Pull request
 * events are not claimed here: they wait for their consumer (P3-4).
 *
 * Failures never lose a row: a transient one (forge outage, database error) is retried with
 * exponential backoff; a row that cannot succeed (it does not decode, or contradicts GitHub) is
 * parked at once; after WEBHOOK_MAX_ATTEMPTS the database parks it. Logs carry the delivery id,
 * the outcome or error code and the attempt; never the event content.
 */

export interface InboxDeps extends InstallationDeps {
  readonly log: Logger;
  /** Rows per claim (default 10). */
  readonly batchSize?: number;
  /** Lease per claim; must exceed the time to process a batch (default 120 s). */
  readonly leaseSeconds?: number;
}

export interface DrainReport {
  readonly claimed: number;
  readonly processed: number;
  readonly retried: number;
  readonly parked: number;
  readonly lost: number;
}

/** First retry after 30 s, doubling, at most an hour. */
export const retryDelaySeconds = (attempts: number): number =>
  Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);

const errorCodeOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return isErrorCode(code) ? code : "internal_error";
};

type RowResult = "processed" | "retried" | "parked" | "lost";

const processRow = async (deps: InboxDeps, row: ClaimedDelivery): Promise<RowResult> => {
  const base = { deliveryId: row.deliveryId, attempt: row.attempts };
  const decoded = decodeClaimedDelivery(row);
  if (!decoded.ok || !isInstallationEvent(decoded.event)) {
    const result = await deps.db.failWebhookDelivery(row, {
      error: "invalid_event",
      retryAfterSeconds: 0,
      permanent: true,
    });
    deps.log.warn({ ...base, errorCode: "invalid_event", result }, "inbox row refused");
    return result === "stale" ? "lost" : "parked";
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
    const permanent = error instanceof ParkDeliveryError;
    const code = permanent ? error.code : errorCodeOf(error);
    const result = await deps.db.failWebhookDelivery(row, {
      error: code,
      retryAfterSeconds: permanent ? 0 : retryDelaySeconds(row.attempts),
      permanent,
    });
    const line = { ...base, installationId: event.installationId, errorCode: code, result };
    if (result === "parked") deps.log.error(line, "installation event parked");
    else deps.log.warn(line, "installation event failed");
    return result === "stale" ? "lost" : result === "parked" ? "parked" : "retried";
  }
};

/** Claims and processes one batch. Returns what happened; never throws for a single row. */
export const drainInstallationEvents = async (deps: InboxDeps): Promise<DrainReport> => {
  const rows = await deps.db.claimWebhookDeliveries({
    eventTypes: INSTALLATION_EVENT_TYPES,
    limit: deps.batchSize ?? 10,
    leaseSeconds: deps.leaseSeconds ?? 120,
  });
  const counts = { processed: 0, retried: 0, parked: 0, lost: 0 };
  for (const row of rows) {
    let result: RowResult;
    try {
      result = await processRow(deps, row);
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
