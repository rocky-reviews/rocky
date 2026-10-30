import { CSRF_EXEMPT_HMAC } from "./auth/csrf.js";
import { publicRoute } from "./auth/policy.js";
import type {
  WebhookInbox,
  WebhookIngress,
  WebhookRejection,
  WebhookRequest,
} from "@rocky-reviews/core";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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
 * Bytes of request bodies the route may hold at once, across requests, counted as they are
 * actually received (not as declared: a client that announces 25 MiB and trickles bytes holds
 * only what it sent). Beyond it → 503. Only a client that really sends that much data, fast,
 * can exhaust it; under such a flood genuine deliveries can be refused (GitHub does not retry a
 * 503) in exchange for not running out of memory. Rate limits (P7-3) bound how often one
 * address can try.
 */
export const MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;

/**
 * Rate limits (P7-3, ADR 0025). The `…Allowed` checks return `false` after answering 429 (or
 * 503); the route then stops. They do not count: only the outcomes below spend a budget, so
 * genuine deliveries never use up the per-source budget and replays never use up an
 * installation's (review round 1).
 */
export interface WebhookRateLimit {
  /**
   * Per source, before the precheck and before the body is read (cheap). `ownSender`: the
   * unauthenticated headers claim this deployment's own app (`WebhookIngress.claimsOwnSender`).
   */
  sourceAllowed(request: FastifyRequest, reply: FastifyReply, ownSender: boolean): Promise<boolean>;
  /** A rejection that is the sender's fault: failed precheck, bad signature, oversized body. */
  sourceRejected(request: FastifyRequest, ownSender: boolean): Promise<void>;
  /** Per installation (`<forge>:<id>`), only after the signature holds. */
  installationAllowed(
    request: FastifyRequest,
    reply: FastifyReply,
    installation: string,
  ): Promise<boolean>;
  /** The inbox queued a new delivery for the installation (duplicates do not count). */
  installationQueued(request: FastifyRequest, installation: string): Promise<void>;
}

export interface WebhookDeps {
  ingress: WebhookIngress;
  inbox: WebhookInbox;
  /** Omitted only in tests of the HTTP layer; `startServer` always passes it. */
  rateLimit?: WebhookRateLimit;
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

/** The declared body length, when there is a usable one (chunked requests have none). */
const declaredBytes = (request: FastifyRequest): number | undefined => {
  const raw = request.headers["content-length"];
  return typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
};

/** The byte counter overflowed the in-flight budget mid-body; answered with 503. */
class InFlightBudgetError extends Error {
  override readonly name = "InFlightBudgetError";
  readonly statusCode = 503;
}

/** Body bytes one request holds in the budget; released once (close, abort or response). */
interface Holding {
  received: number;
  released: boolean;
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

export const registerWebhooks = (app: FastifyInstance, deps: WebhookDeps): void => {
  const forge = deps.ingress.forge;
  const recordTimeoutMs = deps.recordTimeoutMs ?? INBOX_RECORD_TIMEOUT_MS;
  const maxInFlightBytes = deps.maxInFlightBytes ?? MAX_IN_FLIGHT_BYTES;
  let inFlightBytes = 0;
  const holdings = new WeakMap<FastifyRequest, Holding>();
  const free = (holding: Holding | undefined): void => {
    if (holding === undefined || holding.released) return;
    holding.released = true;
    inFlightBytes -= holding.received;
  };
  const release = async (request: FastifyRequest): Promise<void> => free(holdings.get(request));
  // Whether each request's headers claimed our own app; read once in onRequest.
  const ownSenders = new WeakMap<FastifyRequest, boolean>();
  const sourceRejected = async (request: FastifyRequest): Promise<void> => {
    await deps.rateLimit?.sourceRejected(request, ownSenders.get(request) ?? false);
  };
  const overloaded = (request: FastifyRequest, bytes: number | undefined) =>
    request.log.warn(
      { webhook: { forge, outcome: "overloaded", ...(bytes === undefined ? {} : { bytes }) } },
      "webhook refused: in-flight byte budget exhausted",
    );

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
      const ownSender = deps.ingress.claimsOwnSender?.(headerOf(request)) ?? false;
      ownSenders.set(request, ownSender);
      if (
        deps.rateLimit !== undefined &&
        !(await deps.rateLimit.sourceAllowed(request, reply, ownSender))
      ) {
        return reply;
      }
      const rejection = deps.ingress.precheck(headerOf(request));
      if (rejection !== undefined) {
        await sourceRejected(request);
        request.log.warn(
          { webhook: { forge, outcome: "rejected", reason: rejection, stage: "precheck" } },
          "webhook rejected",
        );
        return reply.code(REJECTION_STATUS[rejection]).send({ error: rejection });
      }
      // Cheap early refusal: a declared length that cannot fit in what is left right now. Not a
      // reservation: the budget counts received bytes only (preParsing below). A length over the
      // body limit is left to Fastify's 413.
      const declared = declaredBytes(request);
      if (
        declared !== undefined &&
        declared <= WEBHOOK_BODY_LIMIT_BYTES &&
        inFlightBytes + declared > maxInFlightBytes
      ) {
        overloaded(request, declared);
        return reply.code(503).send({ error: "overloaded" });
      }
      const holding: Holding = { received: 0, released: false };
      holdings.set(request, holding);
      // Whichever comes first: response sent, request aborted, connection closed (e.g. a 408).
      reply.raw.once("close", () => free(holding));
      return undefined;
    });

    // Counts body bytes into the budget as they arrive, before the parser buffers them.
    scope.addHook("preParsing", async (request, _reply, payload) => {
      const holding = holdings.get(request);
      if (holding === undefined) return payload;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (!holding.released) {
            holding.received += chunk.length;
            inFlightBytes += chunk.length;
            if (inFlightBytes > maxInFlightBytes) {
              callback(new InFlightBudgetError("in-flight byte budget exhausted"));
              return;
            }
          }
          callback(null, chunk);
        },
      });
      payload.on("error", (error) => counter.destroy(error));
      payload.pipe(counter);
      return counter;
    });

    scope.addHook("onResponse", release);
    scope.addHook("onRequestAbort", release);

    scope.setErrorHandler(async (error, request, reply) => {
      if (error instanceof InFlightBudgetError) {
        overloaded(request, undefined);
        return reply.code(503).send({ error: "overloaded" });
      }
      if (errorCode(error) === "FST_ERR_CTP_BODY_TOO_LARGE") await sourceRejected(request);
      // Everything else (413, client aborts, …) goes on to the root error handler.
      throw error;
    });

    scope.post(
      `/webhooks/${forge}`,
      // Authenticated by the body's HMAC signature, never by a cookie (ADR 0020 §5).
      {
        bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
        config: {
          csrfExempt: CSRF_EXEMPT_HMAC,
          policy: publicRoute("authenticated by the HMAC signature over the body"),
        },
      },
      async (request, reply) => {
        const input = webhookRequest(request);
        const bytes = input.body.byteLength;
        const receipt = deps.ingress.receive(input);
        // Logged: forge, outcome, fixed reason codes, delivery id, event name (both
        // format-checked after authentication), body size. Never headers, body or signature.
        switch (receipt.outcome) {
          case "rejected":
            // Only a bad signature is the sender's fault; the other reasons are checked after it.
            if (receipt.reason === "unauthenticated") await sourceRejected(request);
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
            // Authenticated: the installation id is GitHub's, not the attacker's choice.
            const installation = `${forge}:${event.installationId}`;
            if (
              deps.rateLimit !== undefined &&
              !(await deps.rateLimit.installationAllowed(request, reply, installation))
            ) {
              return reply;
            }
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
            // Spent only for new deliveries: signatures carry no timestamp, so a replayed signed
            // delivery must not use up the installation's budget (the inbox dedups it).
            if (stored === "queued")
              await deps.rateLimit?.installationQueued(request, installation);
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
