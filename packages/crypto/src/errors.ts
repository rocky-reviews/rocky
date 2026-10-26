/**
 * Every failure in this package is a `CryptoError` with a stable `code`. Messages are fixed
 * strings: they never carry key material, plaintext, ciphertext or the caller's context.
 */
export type CryptoErrorCode =
  | "invalid_key"
  | "invalid_context"
  | "malformed_ciphertext"
  | "unsupported_format"
  | "unknown_key_version"
  | "authentication_failed"
  | "keyring_destroyed";

const MESSAGES: Record<CryptoErrorCode, string> = {
  invalid_key: "key material has the wrong shape",
  invalid_context: "encryption context is invalid",
  malformed_ciphertext: "ciphertext is malformed",
  unsupported_format: "ciphertext format version is not supported",
  unknown_key_version: "no key with that version is available",
  authentication_failed: "ciphertext, tag, nonce, version or context does not authenticate",
  keyring_destroyed: "keyring has been destroyed",
};

export class CryptoError extends Error {
  override readonly name = "CryptoError";

  constructor(readonly code: CryptoErrorCode) {
    super(MESSAGES[code]);
  }
}

export const isCryptoError = (error: unknown): error is CryptoError => error instanceof CryptoError;
