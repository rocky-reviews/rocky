import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkWebhookSecret,
  MIN_WEBHOOK_SECRET_LENGTH,
  payloadSha256,
  signWebhookBody,
  WebhookSecretError,
  webhookVerifier,
} from "./signature.js";
import { TEST_WEBHOOK_SECRET } from "./testing.js";

const body = Buffer.from('{"action":"opened"}');
const verify = webhookVerifier(TEST_WEBHOOK_SECRET);

describe("signWebhookBody", () => {
  it("matches GitHub's documented test vector (HMAC-SHA256 over the raw body)", () => {
    // docs.github.com, "Validating webhook deliveries": secret, payload and expected signature.
    expect(signWebhookBody("It's a Secret to Everybody", Buffer.from("Hello, World!"))).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });
});

describe("webhookVerifier", () => {
  it("accepts the signature of the exact bytes", () => {
    expect(verify(body, signWebhookBody(TEST_WEBHOOK_SECRET, body))).toBe(true);
  });

  it("accepts upper-case hex (the digest is compared as bytes)", () => {
    const sig = signWebhookBody(TEST_WEBHOOK_SECRET, body);
    expect(verify(body, `sha256=${sig.slice(7).toUpperCase()}`)).toBe(true);
  });

  it("rejects a missing, non-string or malformed header", () => {
    const good = signWebhookBody(TEST_WEBHOOK_SECRET, body);
    for (const header of [
      undefined,
      null,
      "",
      ["sha256=" + "0".repeat(64)],
      good.slice(7), // no prefix
      good.replace("sha256=", "sha1="),
      good.replace("sha256=", "SHA256="),
      ` ${good}`,
      `${good} `,
      `${good}00`, // too long
      good.slice(0, -2), // too short
      `sha256=${"z".repeat(64)}`, // not hex
      `sha256=${"0".repeat(64)}`,
    ]) {
      expect(verify(body, header), JSON.stringify(header)).toBe(false);
    }
  });

  it("rejects a signature made with another secret, over another body, or with one bit flipped", () => {
    const other = signWebhookBody(`${TEST_WEBHOOK_SECRET}x`, body);
    expect(verify(body, other)).toBe(false);
    expect(
      verify(Buffer.from('{"action":"closed"}'), signWebhookBody(TEST_WEBHOOK_SECRET, body)),
    ).toBe(false);
    const good = signWebhookBody(TEST_WEBHOOK_SECRET, body);
    const last = good.at(-1) === "0" ? "1" : "0";
    expect(verify(body, good.slice(0, -1) + last)).toBe(false);
  });

  it("verifies the raw bytes, not a re-encoding of the JSON (parser differential)", () => {
    const raw = Buffer.from('{ "action" : "opened", "x": "\\u00e9" }');
    const sig = signWebhookBody(TEST_WEBHOOK_SECRET, raw);
    expect(verify(raw, sig)).toBe(true);
    const reencoded = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))));
    expect(reencoded.equals(raw)).toBe(false);
    expect(verify(reencoded, sig)).toBe(false);
  });

  it("refuses to be built with an empty, short, padded or malformed secret (fail closed)", () => {
    for (const secret of [
      undefined,
      "",
      "x".repeat(MIN_WEBHOOK_SECRET_LENGTH - 1),
      ` ${"x".repeat(MIN_WEBHOOK_SECRET_LENGTH)}`,
      `${"x".repeat(MIN_WEBHOOK_SECRET_LENGTH)}\n`,
      `${"x".repeat(MIN_WEBHOOK_SECRET_LENGTH)}\ud800`,
      42,
    ]) {
      expect(() => webhookVerifier(secret as string), JSON.stringify(secret)).toThrow(
        WebhookSecretError,
      );
    }
  });

  it("never puts the secret in its error message", () => {
    const secret = "short-but-secret-value";
    try {
      checkWebhookSecret(secret);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});

describe("payloadSha256", () => {
  it("is the lower-case hex sha256 of the raw bytes", () => {
    expect(payloadSha256(body)).toBe(createHash("sha256").update(body).digest("hex"));
    expect(payloadSha256(body)).toMatch(/^[0-9a-f]{64}$/);
  });
});
