import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CryptoError } from "./errors.js";

/** AES-256-GCM from `node:crypto`; the only primitive this package uses (ADR-0006). */
const ALGORITHM = "aes-256-gcm";
export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;

export interface Sealed {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export const assertKey = (key: Uint8Array): void => {
  if (!(key instanceof Uint8Array) || key.length !== KEY_LENGTH) {
    throw new CryptoError("invalid_key");
  }
};

/** Encrypts `plaintext` under `key`, binding `aad`. A fresh random 96-bit nonce every call. */
export const seal = (key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Sealed => {
  assertKey(key);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
};

/**
 * Decrypts a sealed value. Any change to nonce, ciphertext, tag, key or AAD fails with
 * `authentication_failed`; nothing about the inputs is attached to the error.
 */
export const open = (key: Uint8Array, sealed: Sealed, aad: Uint8Array): Buffer => {
  assertKey(key);
  if (sealed.nonce.length !== NONCE_LENGTH || sealed.tag.length !== TAG_LENGTH) {
    throw new CryptoError("malformed_ciphertext");
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce, { authTagLength: TAG_LENGTH });
  decipher.setAAD(aad, { plaintextLength: sealed.ciphertext.length });
  decipher.setAuthTag(sealed.tag);
  // The cipher hands back plaintext in chunks; they are copied into one buffer and then zeroed,
  // so only the returned buffer (which the caller owns and zeroes) holds the plaintext.
  const chunks: Buffer[] = [];
  try {
    chunks.push(decipher.update(sealed.ciphertext));
    chunks.push(decipher.final());
    return Buffer.concat(chunks);
  } catch {
    throw new CryptoError("authentication_failed");
  } finally {
    for (const chunk of chunks) zero(chunk);
  }
};

/** Overwrites a buffer with zeros. Best effort: V8 may hold copies, but the primary one is gone. */
export const zero = (buffer: Uint8Array): void => {
  buffer.fill(0);
};
