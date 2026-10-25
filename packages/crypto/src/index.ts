/**
 * Envelope encryption for GitHub tokens and customer (BYOK) keys — ADR-0006.
 *
 * Each org has a data key (DEK) wrapped by a key-encryption key (KEK) behind the `KeyWrapper`
 * port (KMS in production, `LocalKeyWrapper` in development). Records are encrypted with
 * AES-256-GCM under the org's DEK; the AAD binds org, purpose and record id, so a ciphertext
 * copied to another org or row does not decrypt.
 */
export { CryptoError, isCryptoError, type CryptoErrorCode } from "./errors.js";
export {
  KEK_CURRENT_ENV,
  KEK_KEYS_ENV,
  LocalKeyWrapper,
  generateLocalKek,
  localKeyWrapperFromEnv,
  type KeyWrapper,
  type WrapContext,
  type WrappedBlob,
} from "./key-wrapper.js";
export {
  CIPHERTEXT_PREFIX,
  OrgKeyring,
  PURPOSES,
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  generateWrappedDataKey,
  isCiphertext,
  rewrapDataKeys,
  rotateDataKey,
  type Purpose,
  type RecordContext,
  type WrappedDataKey,
} from "./keyring.js";
