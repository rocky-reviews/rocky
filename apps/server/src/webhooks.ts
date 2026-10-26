import type {
  WebhookInbox,
  WebhookIngress,
  WebhookRejection,
  WebhookRequest,
} from "@rocky-reviews/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Webhook receiver (P3-2, ADR 0007). The request path does exactly three things: authenticate
 * and decode the raw body (`WebhookIngress`, pure), record the delivery in the inbox (one
 * INSERT), answer. No forge API calls and no processing here: the worker consumes the inbox.
 *
 * The route lives in its own Fastify scope with every content-type parser removed and one
 * catch-all that hands over the raw bytes, so nothing parses the body before the signature over
 * those exact bytes has been checked. Before the body is even read, an `onRequest` hook refuses
 * requests whose headers cannot be a valid delivery (`WebhookIngress.precheck`) and reserves the
 * body's size against an in-flight byte budget, so unauthenticated clients cannot make the
 * server buffer much (ADR 0007, "Memory").
 */

/**
 * GitHub's documented payload cap (25 MB). Anything GitHub sends fits; a 413 is never returned
 * for a genuine delivery (GitHub does not retry it). `installation.created` for an account with
 * many repositories is the large case.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * Longest the route waits for the inbox before answering 503: inside GitHub's 10 s delivery
 * timeout, so the delivery is marked failed (and can be redelivered) instead of timing out with
 * an unknown outcome. Above connect (2 s) + insert (3 s), so those fire first and are logged
 * with their own code; this guard is the backstop.
 */
export const INBOX_RECORD_TIMEOUT_MS = 6_000;

/**
 * Bytes of request bodies the route may hold at once, across requests (declared
 * `Content-Length`, or the body limit when none is declared). Beyond it → 503. Under a flood this
 * can refuse genuine deliveries (GitHub does not retry them) in exchange for not running out of
 * memory; rate limiting (P7-3) narrows that window.
 */
export const MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;

export interface WebhookDeps {
  ingress: WebhookIngress;
  inbox: WebhookInbox;
  /** Overrides INBOX_RECORD_TIMEOUT_MS (tests). */
  recordTimeoutMs?: number;
  /** Overrides MAX_IN_FLIGHT_BYTES (tests). */
  maxInFlightBytes?: number;
}

/**
 * The scope's only body parser: hands over the raw bytes. An object so tests can observe that it
 * never runs for a request refused in `onRequest`.
 */
export const rawBodyParser = {
  parse: (_request: FastifyRequest, body: Buffer, done: (err: null, body: Buffer) => void): void =>
    done(null, body),
};

class InboxTimeoutError extends Error {
  override readonly name = "InboxTimeoutError";
}

/** Settles with `promise`, or rejects with InboxTimeoutError after `ms`. Clears its timer. */
const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new InboxTimeoutError("inbox timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const REJECTION_STATUS: Readonly<Record<WebhookRejection, number>> = {
  unauthenticated: 401,
  bad_headers: 400,
  unsupported_media_type: 415,
  bad_payload: 400,
};

const EMPTY = Buffer.alloc(0);

/** Single-valued headers only; Node joins repeated ones, which then fail the format checks. */
const headerOf =
  (request: FastifyRequest): WebhookRequest["header"] =>
  (name) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : undefined;
  };

const webhookRequest = (request: FastifyRequest): WebhookRequest => ({
  body: Buffer.isBuffer(request.body) ? request.body : EMPTY,
  header: headerOf(request),
});

/** Bytes to reserve for a request: its declared length (capped at the limit), else the limit. */
const declaredBytes = (request: FastifyRequest): number => {
  const raw = request.headers["content-length"];
  const declared = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(declared)
    ? Math.min(declared, WEBHOOK_BODY_LIMIT_BYTES)
    : WEBHOOK_BODY_LIMIT_BYTES;
};

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

export const registerWebhooks = (app: FastifyInstance, deps: WebhookDeps): void => {
  const forge = deps.ingress.forge;
  const recordTimeoutMs = deps.recordTimeoutMs ?? INBOX_RECORD_TIMEOUT_MS;
  const maxInFlightBytes = deps.maxInFlightBytes ?? MAX_IN_FLIGHT_BYTES;
  let inFlightBytes = 0;
  const releases = new WeakMap<FastifyRequest, () => void>();
  const release = async (request: FastifyRequest): Promise<void> => releases.get(request)?.();

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      (request, body, done) => rawBodyParser.parse(request, body as Buffer, done),
    );

    // Runs before the body is read: no buffering for requests that cannot be valid deliveries,
    // and none beyond the in-flight budget.
    scope.addHook("onRequest", async (request, reply) => {
      const rejection = deps.ingress.precheck(headerOf(request));
      if (rejection !== undefined) {
        request.log.warn(
          { webhook: { forge, outcome: "rejected", reason: rejection, stage: "precheck" } },
          "webhook rejected",
        );
        return reply.code(REJECTION_STATUS[rejection]).send({ error: rejection });
      }
      const reserve = declaredBytes(request);
      if (inFlightBytes + reserve > maxInFlightBytes) {
        request.log.warn(
          { webhook: { forge, outcome: "overloaded", bytes: reserve } },
          "webhook refused: in-flight byte budget exhausted",
        );
        return reply.code(503).send({ error: "overloaded" });
      }
      inFlightBytes += reserve;
      let held = true;
      const free = (): void => {
        if (!held) return;
        held = false;
        inFlightBytes -= reserve;
      };
      releases.set(request, free);
      // Whichever comes first: response sent, request aborted, connection closed.
      reply.raw.once("close", free);
      return undefined;
    });
    scope.addHook("onResponse", release);
    scope.addHook("onRequestAbort", release);

    scope.post(
      `/webhooks/${forge}`,
      { bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const input = webhookRequest(request);
        const bytes = input.body.byteLength;
        const receipt = deps.ingress.receive(input);
        // Logged: forge, outcome, fixed reason codes, delivery id, event name (both
        // format-checked after authentication), body size. Never headers, body or signature.
        switch (receipt.outcome) {
          case "rejected":
            request.log.warn(
              { webhook: { forge, outcome: "rejected", reason: receipt.reason, bytes } },
              "webhook rejected",
            );
            return reply.code(REJECTION_STATUS[receipt.reason]).send({ error: receipt.reason });
          case "ping":
            request.log.info(
              { webhook: { forge, outcome: "ping", deliveryId: receipt.deliveryId } },
              "webhook ping",
            );
            return reply.code(200).send({ status: "pong" });
          case "ignored":
            request.log.info(
              {
                webhook: {
                  forge,
                  outcome: "ignored",
                  deliveryId: receipt.deliveryId,
                  eventName: receipt.eventName,
                  ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
                  bytes,
                },
              },
              "webhook ignored",
            );
            return reply.code(200).send({ status: "ignored" });
          case "accepted": {
            const { deliveryId, event } = receipt.delivery;
            let stored: "queued" | "duplicate";
            try {
              // A timed-out insert may still commit later; a redelivery then reads `duplicate`.
              stored = await withTimeout(deps.inbox.record(receipt.delivery), recordTimeoutMs);
            } catch (error) {
              // Infrastructure failure: 503 so the delivery shows as failed on the forge and can
              // be redelivered. Only the error code is logged (driver messages can echo values).
              request.log.error(
                {
                  webhook:
                    error instanceof InboxTimeoutError
                      ? { forge, outcome: "inbox_timeout", deliveryId, timeoutMs: recordTimeoutMs }
                      : { forge, outcome: "inbox_error", deliveryId, sqlstate: errorCode(error) },
                },
                "webhook inbox unavailable",
              );
              return reply.code(503).send({ error: "unavailable" });
            }
            request.log.info(
              { webhook: { forge, outcome: stored, deliveryId, eventType: event.type, bytes } },
              stored === "queued" ? "webhook queued" : "webhook duplicate",
            );
            return stored === "queued"
              ? reply.code(202).send({ status: "queued" })
              : reply.code(200).send({ status: "duplicate" });
          }
        }
      },
    );
  });
};
