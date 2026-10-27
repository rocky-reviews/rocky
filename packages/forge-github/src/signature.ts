import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook authentication: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, body)>`
 * over the raw request body. The comparison is constant-time over two fixed-length digests; the
 * only early exits are on the header's shape, which is public.
 */

export const SIGNATURE_HEADER = "x-hub-signature-256";
const PREFIX = "sha256=";
const HEX_DIGEST = /^[0-9a-f]{64}$/i;

/**
 * Shortest secret the receiver accepts. An empty or short secret makes the HMAC forgeable or
 * guessable, so it is refused at construction rather than used. `openssl rand -hex 32` gives 64.
 */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

export class WebhookSecretError extends Error {
  override readonly name = "WebhookSecretError";
}

/** Validates a webhook secret; the message never contains the value. */
export const checkWebhookSecret = (secret: unknown): string => {
  if (typeof secret !== "string" || secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new WebhookSecretError(
      `the webhook secret must be a string of at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
    );
  }
  if (secret.trim() !== secret || !secret.isWellFormed()) {
    throw new WebhookSecretError(
      "the webhook secret must not have surrounding whitespace or invalid characters",
    );
  }
  return secret;
};

/** `sha256=<hex>` for `body`, as GitHub sends it. Used by tests and test fixtures. */
export const signWebhookBody = (secret: string, body: Uint8Array): string =>
  PREFIX + createHmac("sha256", secret).update(body).digest("hex");

/** sha256 of the raw body, lower-case hex: the replay key for a signed body. */
export const payloadSha256 = (body: Uint8Array): string =>
  createHash("sha256").update(body).digest("hex");

/** Whether a signature header has the right shape (`sha256=` + 64 hex). Public; no secret. */
export const isWellFormedSignatureHeader = (header: unknown): header is string =>
  typeof header === "string" &&
  header.startsWith(PREFIX) &&
  HEX_DIGEST.test(header.slice(PREFIX.length));

/** A verifier bound to one secret. The secret is validated once and never leaves the closure. */
export const webhookVerifier = (
  secret: string,
): ((body: Uint8Array, header: unknown) => boolean) => {
  const key = Buffer.from(checkWebhookSecret(secret), "utf8");
  return (body, header) => {
    if (!isWellFormedSignatureHeader(header)) return false;
    const given = Buffer.from(header.slice(PREFIX.length), "hex");
    const expected = createHmac("sha256", key).update(body).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
};
