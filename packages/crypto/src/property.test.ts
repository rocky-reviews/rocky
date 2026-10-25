/**
 * Property tests: for random plaintexts and contexts the round trip holds, and every single
 * change to the ciphertext string, to any byte of its decoded form, or to the context makes
 * decryption fail with a typed error. The seed is fixed so CI is deterministic.
 */
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import { LocalKeyWrapper } from "./key-wrapper.js";
import {
  CIPHERTEXT_PREFIX,
  OrgKeyring,
  PURPOSES,
  generateWrappedDataKey,
  rotateDataKey,
} from "./keyring.js";

const RUNS = { seed: 2003, numRuns: 200 };
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const arbPlaintext = fc.uint8Array({ minLength: 0, maxLength: 300 });
const arbId = fc.stringMatching(/^[A-Za-z0-9_.:-]{1,40}$/);
const arbPurpose = fc.constantFrom(...PURPOSES);
const arbContext = fc.record({ purpose: arbPurpose, recordId: arbId });

let keyring: OrgKeyring;

beforeAll(async () => {
  const wrapper = new LocalKeyWrapper({ k1: randomBytes(32) });
  const keys = await rotateDataKey(wrapper, "org-prop", [
    await generateWrappedDataKey(wrapper, "org-prop"),
  ]);
  keyring = await OrgKeyring.open(wrapper, "org-prop", keys);
});

const expectTypedFailure = (fn: () => unknown) => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoError);
  expect([
    "malformed_ciphertext",
    "unsupported_format",
    "unknown_key_version",
    "authentication_failed",
  ]).toContain((caught as CryptoError).code);
};

describe("envelope encryption properties", () => {
  it("round-trips any plaintext under any context", () => {
    fc.assert(
      fc.property(arbPlaintext, arbContext, (plaintext, ctx) => {
        const ct = keyring.encrypt(plaintext, ctx);
        expect(ct.startsWith(CIPHERTEXT_PREFIX)).toBe(true);
        expect(Buffer.from(keyring.decrypt(ct, ctx)).equals(Buffer.from(plaintext))).toBe(true);
      }),
      RUNS,
    );
  });

  it("fails when any character of the ciphertext string changes", () => {
    fc.assert(
      fc.property(arbPlaintext, arbContext, fc.nat(), fc.nat({ max: 63 }), (pt, ctx, pos, alt) => {
        const ct = keyring.encrypt(pt, ctx);
        const index = pos % ct.length;
        const current = ct[index]!;
        const replacement = BASE64URL[(BASE64URL.indexOf(current) + 1 + alt) % 64]!;
        const tampered =
          ct.slice(0, index) + (replacement === current ? "*" : replacement) + ct.slice(index + 1);
        expect(tampered).not.toBe(ct);
        expectTypedFailure(() => keyring.decrypt(tampered, ctx));
      }),
      RUNS,
    );
  });

  it("fails when any byte of the decoded payload (version, nonce, tag or body) flips", () => {
    fc.assert(
      fc.property(
        arbPlaintext,
        arbContext,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (pt, ctx, pos, mask) => {
          const ct = keyring.encrypt(pt, ctx);
          const bytes = Buffer.from(ct.slice(CIPHERTEXT_PREFIX.length), "base64url");
          const index = pos % bytes.length;
          bytes[index] = bytes[index]! ^ mask;
          const tampered = CIPHERTEXT_PREFIX + bytes.toString("base64url");
          expectTypedFailure(() => keyring.decrypt(tampered, ctx));
        },
      ),
      RUNS,
    );
  });

  it("fails when the context differs in any field", () => {
    fc.assert(
      fc.property(arbPlaintext, arbContext, arbContext, (pt, ctx, other) => {
        fc.pre(ctx.purpose !== other.purpose || ctx.recordId !== other.recordId);
        const ct = keyring.encrypt(pt, ctx);
        expectTypedFailure(() => keyring.decrypt(ct, other));
      }),
      RUNS,
    );
  });
});
