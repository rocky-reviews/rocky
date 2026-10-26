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
 * those exact bytes has been checked.
 */

/**
 * GitHub's documented payload cap (25 MB). Anything GitHub sends fits; a 413 is never returned
 * for a genuine delivery (GitHub does not retry it). `installation.created` for an account with
 * many repositories is the large case.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * Longest the route waits for the inbox before answering 503: well inside GitHub's 10 s
 * delivery timeout, so the delivery is marked failed (and can be redelivered) instead of timing
 * out with an unknown outcome. The pool's own timeouts (connect 2 s, statement 3 s) fire first.
 */
export const INBOX_RECORD_TIMEOUT_MS = 5_000;

export interface WebhookDeps {
  ingress: WebhookIngress;
  inbox: WebhookInbox;
  /** Overrides INBOX_RECORD_TIMEOUT_MS (tests). */
  recordTimeoutMs?: number;
}

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
const webhookRequest = (request: FastifyRequest): WebhookRequest => ({
  body: Buffer.isBuffer(request.body) ? request.body : EMPTY,
  header: (name) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : undefined;
  },
});

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

export const registerWebhooks = (app: FastifyInstance, deps: WebhookDeps): void => {
  const forge = deps.ingress.forge;
  const recordTimeoutMs = deps.recordTimeoutMs ?? INBOX_RECORD_TIMEOUT_MS;
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      (_request, body, done) => done(null, body),
    );

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
