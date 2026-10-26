import {
  isForgeEventType,
  isInstallationEvent,
  type ForgeEvent,
  type WebhookDelivery,
} from "@rocky-reviews/core";

/**
 * The webhook inbox (migration 0006, ADR 0007): the receiver records each authenticated delivery
 * once. Dedup is the table's primary key (forge, delivery_id) and the unique (forge, payload
 * sha256), with `ON CONFLICT DO NOTHING`, so concurrent duplicates resolve in the database: one
 * insert wins and the others see no row inserted.
 */

/**
 * Thrown for an invalid delivery (before any SQL) or a database failure. Carries a fixed message
 * and, for database failures, only the SQLSTATE: driver messages and details can echo the row.
 */
export class WebhookInboxError extends Error {
  override readonly name = "WebhookInboxError";
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** A database error reduced to its SQLSTATE. */
export const inboxDatabaseError = (error: unknown): WebhookInboxError => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return new WebhookInboxError(
    "webhook inbox: database error",
    typeof code === "string" && SQLSTATE.test(code) ? code : undefined,
  );
};

const FORGES = new Set(["github", "gitlab", "gitea"]);
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PR_NUMBER = 2_147_483_647;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

const invalid = (field: string): never => {
  throw new WebhookInboxError(`webhook delivery: invalid ${field}`);
};

/**
 * Rebuilds the event from its known fields only, so nothing a caller attached (by mistake or
 * otherwise) reaches the table. Throws on anything outside the shape; messages name the field,
 * never the value.
 */
export const minimalEvent = (event: ForgeEvent): ForgeEvent => {
  if (typeof event !== "object" || event === null || !isForgeEventType(event.type)) {
    return invalid("event type");
  }
  if (!isId(event.installationId)) return invalid("installation id");
  if (isInstallationEvent(event)) {
    const account = event.account;
    if (typeof account !== "object" || account === null) return invalid("account");
    if (!isId(account.id)) return invalid("account id");
    if (typeof account.login !== "string" || !LOGIN.test(account.login)) return invalid("login");
    if (account.kind !== "organization" && account.kind !== "user") return invalid("account kind");
    const sender = event.sender;
    if (typeof sender !== "object" || sender === null) return invalid("sender");
    if (!isId(sender.id)) return invalid("sender id");
    if (typeof sender.login !== "string" || !LOGIN.test(sender.login)) {
      return invalid("sender login");
    }
    return {
      type: event.type,
      installationId: event.installationId,
      account: { id: account.id, login: account.login, kind: account.kind },
      sender: { id: sender.id, login: sender.login },
    };
  }
  if (!isId(event.repositoryId)) return invalid("repository id");
  if (!Number.isInteger(event.number) || event.number < 1 || event.number > MAX_PR_NUMBER) {
    return invalid("pull request number");
  }
  if (typeof event.headSha !== "string" || !OBJECT_ID.test(event.headSha)) {
    return invalid("head sha");
  }
  if (typeof event.merged !== "boolean") return invalid("merged");
  return {
    type: event.type,
    installationId: event.installationId,
    repositoryId: event.repositoryId,
    number: event.number,
    headSha: event.headSha,
    merged: event.merged,
  };
};

export interface InboxRow {
  readonly sql: string;
  readonly values: readonly unknown[];
}

/** Validates a delivery and builds the parameterised insert. Throws before any SQL. */
export const inboxInsert = (delivery: WebhookDelivery): InboxRow => {
  if (typeof delivery !== "object" || delivery === null) return invalid("delivery");
  if (!FORGES.has(delivery.forge)) return invalid("forge");
  if (typeof delivery.deliveryId !== "string" || !DELIVERY_ID.test(delivery.deliveryId)) {
    return invalid("delivery id");
  }
  if (typeof delivery.payloadSha256 !== "string" || !SHA256_HEX.test(delivery.payloadSha256)) {
    return invalid("payload digest");
  }
  const event = minimalEvent(delivery.event);
  return {
    sql: `insert into app.webhook_deliveries
            (forge, delivery_id, payload_sha256, event_type, installation_id, event)
          values ($1, $2, $3, $4, $5, $6::jsonb)
          on conflict do nothing`,
    values: [
      delivery.forge,
      delivery.deliveryId,
      Buffer.from(delivery.payloadSha256, "hex"),
      event.type,
      event.installationId,
      JSON.stringify(event),
    ],
  };
};
