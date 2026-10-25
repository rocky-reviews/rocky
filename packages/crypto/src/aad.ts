import { CryptoError } from "./errors.js";

/** Longest UTF-8 field (org id, purpose, record id) accepted in an encryption context. */
export const MAX_AAD_FIELD_BYTES = 1024;

/**
 * Canonical additional-authenticated-data encoding: each field as `u16 length || utf8 bytes`.
 * Length prefixes make the encoding injective, so `["ab","c"]` and `["a","bc"]` never collide
 * and a ciphertext can only be opened with exactly the fields it was sealed under.
 */
export const encodeAad = (fields: readonly string[]): Buffer => {
  const parts: Buffer[] = [];
  for (const field of fields) {
    if (typeof field !== "string") throw new CryptoError("invalid_context");
    const bytes = Buffer.from(field, "utf8");
    if (bytes.length > MAX_AAD_FIELD_BYTES) throw new CryptoError("invalid_context");
    const length = Buffer.allocUnsafe(2);
    length.writeUInt16BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
};
