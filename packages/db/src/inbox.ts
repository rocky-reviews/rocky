import {
  isForgeEventType,
  type ForgeEvent,
  type ForgeEventType,
  type ForgeKind,
} from "@rocky-reviews/core";
import type { TenantTx } from "./client.js";
import { minimalEvent, WebhookInboxError } from "./webhooks.js";

/**
 * The worker's side of the webhook inbox (migration 0007, ADR 0009). Rows are claimed with a
 * lease through SECURITY DEFINER functions in schema `worker` that only the worker role may
 * execute; the server's role keeps INSERT only. Every function takes fixed codes and ids, never
 * free text, and the SQL refuses anything else through its CHECKs.
 */

/**
 * Strikes (lost leases, contradictions, bad answers) after which a row is parked (mirrors the
 * constant in migration 0007). Transient failures do not strike.
 */
export const WEBHOOK_MAX_STRIKES = 5;
/**
 * A claim gives up after this long, waiting for the claim lock included (review round 3): a slow
 * claim must not hand out leases that are already short.
 */
export const CLAIM_STATEMENT_TIMEOUT_MS = 5_000;
/** A row that only ever failed transiently is parked once it is this old (migration 0007). */
export const WEBHOOK_TRANSIENT_PARK_HOURS = 72;

/** What a worker holds while processing one row. Only the current holder can finish it. */
export interface InboxLease {
  readonly forge: ForgeKind;
  readonly deliveryId: string;
  readonly leaseToken: string;
}

/**
 * One claimed row as stored. `event` is `unknown` on purpose: the app role can insert any row
 * its CHECKs allow, so the stored shape is never trusted; `decodeClaimedDelivery` re-validates.
 */
export interface ClaimedDelivery extends InboxLease {
  readonly eventType: string;
  readonly installationId: number;
  readonly event: unknown;
  /** Claims so far, this one included (1 on the first). */
  readonly attempts: number;
  /** Strikes so far (see WEBHOOK_MAX_STRIKES). */
  readonly strikes: number;
  /** When the lease runs out (database clock); a worker must not start a row past it. */
  readonly leaseUntil: Date;
}

export type DecodedDelivery =
  | { readonly ok: true; readonly event: ForgeEvent }
  | { readonly ok: false; readonly reason: "invalid_event" };

/**
 * Re-validates a claimed row (ADR 0007 §4): the event must pass `minimalEvent` again and agree
 * with its columns. Never throws.
 */
export const decodeClaimedDelivery = (row: ClaimedDelivery): DecodedDelivery => {
  let event: ForgeEvent;
  try {
    event = minimalEvent(row.event as ForgeEvent);
  } catch {
    return { ok: false, reason: "invalid_event" };
  }
  if (event.type !== row.eventType || event.installationId !== row.installationId) {
    return { ok: false, reason: "invalid_event" };
  }
  return { ok: true, event };
};

/** Fixed outcome and error codes: what may reach the table and the logs. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORGES: ReadonlySet<string> = new Set(["github", "gitlab", "gitea"]);

export const isOutcomeCode = (value: unknown): value is string =>
  typeof value === "string" && CODE.test(value);

export const isErrorCode = (value: unknown): value is string =>
  typeof value === "string" && (CODE.test(value) || SQLSTATE.test(value));

const checkLease = (lease: InboxLease): void => {
  if (
    typeof lease !== "object" ||
    lease === null ||
    !FORGES.has(lease.forge) ||
    typeof lease.deliveryId !== "string" ||
    !UUID.test(lease.deliveryId) ||
    typeof lease.leaseToken !== "string" ||
    !UUID.test(lease.leaseToken)
  ) {
    throw new WebhookInboxError("webhook inbox: invalid lease");
  }
};

export interface ClaimOptions {
  /** Only rows of this forge (the worker's adapter). */
  readonly forge: ForgeKind;
  readonly eventTypes: readonly ForgeEventType[];
  /** Rows per claim (the database clamps to 1..100). */
  readonly limit: number;
  /** Lease length (the database clamps to 5..3600 s). Longer than one row's processing. */
  readonly leaseSeconds: number;
}

export const claimSql = (
  options: ClaimOptions,
): { readonly text: string; readonly values: unknown[] } => {
  if (
    !Array.isArray(options.eventTypes) ||
    options.eventTypes.length === 0 ||
    !options.eventTypes.every(isForgeEventType)
  ) {
    throw new WebhookInboxError("webhook inbox: invalid event types");
  }
  if (!Number.isInteger(options.limit) || !Number.isInteger(options.leaseSeconds)) {
    throw new WebhookInboxError("webhook inbox: invalid claim bounds");
  }
  if (!FORGES.has(options.forge)) throw new WebhookInboxError("webhook inbox: invalid forge");
  return {
    text: `select forge, delivery_id, event_type, installation_id::text as installation_id, event,
                  attempts, strikes, lease_token::text as lease_token, lease_until
             from worker.claim_webhook_deliveries($1, $2::text[], $3, $4)`,
    values: [options.forge, [...options.eventTypes], options.limit, options.leaseSeconds],
  };
};

export interface ClaimRow {
  forge: ForgeKind;
  delivery_id: string;
  event_type: string;
  installation_id: string;
  event: unknown;
  attempts: number;
  strikes: number;
  lease_token: string;
  lease_until: Date;
}

export const claimedFromRow = (row: ClaimRow): ClaimedDelivery => ({
  forge: row.forge,
  deliveryId: row.delivery_id,
  leaseToken: row.lease_token,
  eventType: row.event_type,
  installationId: Number(row.installation_id),
  event: row.event,
  attempts: row.attempts,
  strikes: row.strikes,
  leaseUntil: row.lease_until,
});

export const completeSql = (
  lease: InboxLease,
  outcome: string,
): { readonly text: string; readonly values: unknown[] } => {
  checkLease(lease);
  if (!isOutcomeCode(outcome)) throw new WebhookInboxError("webhook inbox: invalid outcome code");
  return {
    text: "select worker.complete_webhook_delivery($1, $2, $3::uuid, $4) as ok",
    values: [lease.forge, lease.deliveryId, lease.leaseToken, outcome],
  };
};

export interface InboxFailure {
  /** A SQLSTATE or a fixed reason code. Never a message. */
  readonly error: string;
  /** When to retry (0..86400 s; clamped by the database). */
  readonly retryAfterSeconds: number;
  /**
   * `transient`: the forge or the database is unavailable; no strike, parked only after
   * WEBHOOK_TRANSIENT_PARK_HOURS. `strike`: the row itself is suspect; parked after
   * WEBHOOK_MAX_STRIKES. `permanent`: it can never succeed; parked now.
   */
  readonly kind: "transient" | "strike" | "permanent";
}

const FAILURE_KINDS: ReadonlySet<string> = new Set(["transient", "strike", "permanent"]);

export const failSql = (
  lease: InboxLease,
  failure: InboxFailure,
): { readonly text: string; readonly values: unknown[] } => {
  checkLease(lease);
  if (!isErrorCode(failure.error)) throw new WebhookInboxError("webhook inbox: invalid error code");
  if (!Number.isInteger(failure.retryAfterSeconds) || !FAILURE_KINDS.has(failure.kind)) {
    throw new WebhookInboxError("webhook inbox: invalid failure");
  }
  return {
    text: "select worker.fail_webhook_delivery($1, $2, $3::uuid, $4, $5, $6) as result",
    values: [
      lease.forge,
      lease.deliveryId,
      lease.leaseToken,
      failure.error,
      failure.retryAfterSeconds,
      failure.kind,
    ],
  };
};

/**
 * Marks the row processed inside the tenant transaction that applied its effect, so both commit
 * together. Throws when the lease is no longer held (another worker re-claimed the row after this
 * lease expired): the transaction rolls back and the effect is not applied twice.
 */
export const completeInTenantTx = async (
  tx: TenantTx,
  lease: InboxLease,
  outcome: string,
): Promise<void> => {
  const { text, values } = completeSql(lease, outcome);
  const { rows } = await tx.query<{ ok: boolean }>(text, values);
  if (rows[0]?.ok !== true) throw new LeaseLostError();
};

/** The lease expired and the row now belongs to another worker; nothing was committed. */
export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
  readonly code = "lease_lost";
  constructor() {
    super("webhook inbox: lease lost");
  }
}
