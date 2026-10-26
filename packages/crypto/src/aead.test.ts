import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeAad } from "./aad.js";
import { NONCE_LENGTH, TAG_LENGTH, open, seal } from "./aead.js";
import { CryptoError, isCryptoError } from "./errors.js";

const key = randomBytes(32);
const aad = encodeAad(["org-a", "github_token", "row-1"]);
const plaintext = Buffer.from("ghp_not_a_real_token_just_bytes");

const flip = (buf: Buffer, index: number): Buffer => {
  const copy = Buffer.from(buf);
  copy[index] = copy[index]! ^ 0x01;
  return copy;
};

describe("seal / open (AES-256-GCM)", () => {
  it("round-trips bytes under the same key and AAD", () => {
    const sealed = seal(key, plaintext, aad);
    expect(sealed.nonce).toHaveLength(NONCE_LENGTH);
    expect(sealed.tag).toHaveLength(TAG_LENGTH);
    expect(sealed.ciphertext).toHaveLength(plaintext.length);
    expect(open(key, sealed, aad).equals(plaintext)).toBe(true);
  });

  it("uses a fresh random nonce for every call", () => {
    const a = seal(key, plaintext, aad);
    const b = seal(key, plaintext, aad);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("handles an empty plaintext", () => {
    const sealed = seal(key, Buffer.alloc(0), aad);
    expect(open(key, sealed, aad)).toHaveLength(0);
  });

  it("fails with a different AAD", () => {
    const sealed = seal(key, plaintext, aad);
    const other = encodeAad(["org-b", "github_token", "row-1"]);
    expect(() => open(key, sealed, other)).toThrow(CryptoError);
    expect(() => open(key, sealed, other)).toThrow(
      expect.objectContaining({ code: "authentication_failed" }),
    );
  });

  it("fails with a different key", () => {
    const sealed = seal(key, plaintext, aad);
    expect(() => open(randomBytes(32), sealed, aad)).toThrow(
      expect.objectContaining({ code: "authentication_failed" }),
    );
  });

  it.each(["nonce", "ciphertext", "tag"] as const)("fails when a byte of the %s flips", (part) => {
    const sealed = seal(key, plaintext, aad);
    for (let i = 0; i < sealed[part].length; i++) {
      const tampered = { ...sealed, [part]: flip(sealed[part], i) };
      expect(() => open(key, tampered, aad)).toThrow(
        expect.objectContaining({ code: "authentication_failed" }),
      );
    }
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => seal(randomBytes(16), plaintext, aad)).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
    expect(() => open(randomBytes(31), seal(key, plaintext, aad), aad)).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
  });

  it("rejects a nonce or tag of the wrong length without touching the cipher", () => {
    const sealed = seal(key, plaintext, aad);
    expect(() => open(key, { ...sealed, nonce: sealed.nonce.subarray(1) }, aad)).toThrow(
      expect.objectContaining({ code: "malformed_ciphertext" }),
    );
    expect(() => open(key, { ...sealed, tag: sealed.tag.subarray(0, 12) }, aad)).toThrow(
      expect.objectContaining({ code: "malformed_ciphertext" }),
    );
  });

  it("never puts key material or plaintext in the error", () => {
    const sealed = seal(key, plaintext, aad);
    let caught: unknown;
    try {
      open(key, { ...sealed, tag: flip(sealed.tag, 0) }, aad);
    } catch (error) {
      caught = error;
    }
    const text = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
    expect(text).not.toContain(key.toString("hex"));
    expect(text).not.toContain(key.toString("base64"));
    expect(text).not.toContain(plaintext.toString());
    expect(text).not.toContain(sealed.ciphertext.toString("hex"));
  });
});

describe("CryptoError", () => {
  it("is recognised by isCryptoError and carries a stable code and name", () => {
    const error = new CryptoError("authentication_failed");
    expect(isCryptoError(error)).toBe(true);
    expect(isCryptoError(new Error("authentication_failed"))).toBe(false);
    expect(error.name).toBe("CryptoError");
    expect(error.code).toBe("authentication_failed");
  });
});

describe("encodeAad", () => {
  it("is unambiguous: moving a boundary between fields changes the AAD", () => {
    expect(encodeAad(["ab", "c"]).equals(encodeAad(["a", "bc"]))).toBe(false);
    expect(encodeAad(["a", ""]).equals(encodeAad(["a"]))).toBe(false);
  });

  it("is deterministic", () => {
    expect(encodeAad(["x", "y", "z"]).equals(encodeAad(["x", "y", "z"]))).toBe(true);
  });

  it("rejects fields that are too long", () => {
    expect(() => encodeAad(["a".repeat(1025)])).toThrow(
      expect.objectContaining({ code: "invalid_context" }),
    );
  });
});
