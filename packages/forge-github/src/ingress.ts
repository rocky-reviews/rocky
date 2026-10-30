import type {
  WebhookIngress,
  WebhookReceipt,
  WebhookRejection,
  WebhookRequest,
} from "@rocky-reviews/core";
import { decodeGitHubEvent, HANDLED_EVENTS } from "./events.js";
import {
  isWellFormedSignatureHeader,
  payloadSha256,
  SIGNATURE_HEADER,
  webhookVerifier,
} from "./signature.js";

export const DELIVERY_HEADER = "x-github-delivery";
export const EVENT_HEADER = "x-github-event";
/** Set by GitHub on every delivery: what the hook belongs to (`integration` = a GitHub App). */
export const HOOK_TARGET_TYPE_HEADER = "x-github-hook-installation-target-type";
export const HOOK_TARGET_ID_HEADER = "x-github-hook-installation-target-id";

/** GitHub delivery ids are GUIDs; normalised to lower case so a re-cased replay is the same key. */
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAME = /^[a-z_]{1,64}$/;
const JSON_MEDIA_TYPE = /^application\/json[ \t]*(?:;.*)?$/i;

const HANDLED: ReadonlySet<string> = new Set(HANDLED_EVENTS);
const utf8 = new TextDecoder("utf-8", { fatal: true });

const rejected = (reason: WebhookRejection) => ({ outcome: "rejected", reason }) as const;

/**
 * The non-signature header rules, shared by `precheck` (before the body is read) and `receive`
 * (after authentication), so the two can never disagree.
 */
const checkHeaders = (
  header: WebhookRequest["header"],
): { rejection: WebhookRejection } | { deliveryId: string; eventName: string } => {
  const rawDelivery = header(DELIVERY_HEADER);
  const eventName = header(EVENT_HEADER);
  if (rawDelivery === undefined || !DELIVERY_ID.test(rawDelivery)) {
    return { rejection: "bad_headers" };
  }
  if (eventName === undefined || !EVENT_NAME.test(eventName)) return { rejection: "bad_headers" };
  const contentType = header("content-type");
  if (contentType === undefined || !JSON_MEDIA_TYPE.test(contentType)) {
    return { rejection: "unsupported_media_type" };
  }
  return { deliveryId: rawDelivery.toLowerCase(), eventName };
};

/**
 * The GitHub webhook receiver's decoding step (P3-2). Order matters and is the security
 * property: the signature over the raw bytes is checked first, and nothing else about the
 * request (headers, media type, JSON) is looked at until it holds. Pure: no I/O, never throws.
 */
export const createGitHubWebhookIngress = (options: {
  secret: string;
  /** This deployment's GitHub App id (`GITHUB_APP_ID`), for `claimsOwnSender`. */
  appId?: number;
}): WebhookIngress => {
  const verify = webhookVerifier(options.secret);
  const ownAppId = options.appId === undefined ? undefined : String(options.appId);

  const authenticate = (request: WebhookRequest): boolean => {
    try {
      return verify(request.body, request.header(SIGNATURE_HEADER));
    } catch {
      return false;
    }
  };

  const decode = (request: WebhookRequest): WebhookReceipt => {
    const headers = checkHeaders(request.header);
    if ("rejection" in headers) return rejected(headers.rejection);
    const { deliveryId, eventName } = headers;
    // Events the domain does not consume are acknowledged without parsing the body.
    if (eventName !== "ping" && !HANDLED.has(eventName)) {
      return { outcome: "ignored", deliveryId, eventName };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(utf8.decode(request.body));
    } catch {
      return rejected("bad_payload");
    }
    if (eventName === "ping") return { outcome: "ping", deliveryId };

    const decoded = decodeGitHubEvent(eventName, payload);
    if (decoded.kind === "invalid") return rejected("bad_payload");
    if (decoded.kind === "ignored") {
      return decoded.reason === undefined
        ? { outcome: "ignored", deliveryId, eventName }
        : { outcome: "ignored", deliveryId, eventName, reason: decoded.reason };
    }
    return {
      outcome: "accepted",
      delivery: {
        forge: "github",
        deliveryId,
        payloadSha256: payloadSha256(request.body),
        event: decoded.event,
      },
    };
  };

  return {
    forge: "github",
    precheck: (header) => {
      try {
        if (!isWellFormedSignatureHeader(header(SIGNATURE_HEADER))) return "unauthenticated";
        const headers = checkHeaders(header);
        return "rejection" in headers ? headers.rejection : undefined;
      } catch {
        return "unauthenticated";
      }
    },
    // GitHub sets these from the hook's owner, so another app's deliveries cannot claim ours;
    // a direct client can, but then it is counted at its own address. Without an app id nothing
    // is ours (one bucket per address).
    claimsOwnSender: (header) => {
      try {
        return (
          ownAppId !== undefined &&
          header(HOOK_TARGET_TYPE_HEADER) === "integration" &&
          header(HOOK_TARGET_ID_HEADER) === ownAppId
        );
      } catch {
        return false;
      }
    },
    receive: (request) => {
      if (!authenticate(request)) return rejected("unauthenticated");
      try {
        return decode(request);
      } catch {
        // Authenticated but undecodable in a way the checks above did not anticipate: refuse it
        // as a bad payload (4xx) rather than letting the request path fail.
        return rejected("bad_payload");
      }
    },
  };
};
