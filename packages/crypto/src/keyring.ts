import { randomBytes } from "node:crypto";
import { encodeAad } from "./aad.js";
import { KEY_LENGTH, NONCE_LENGTH, TAG_LENGTH, open, seal, zero, type Sealed } from "./aead.js";
import { CryptoError } from "./errors.js";
import { isKekVersion, type KeyWrapper } from "./key-wrapper.js";

/**
 * What a ciphertext protects. The purpose is part of the AAD, so a GitHub token can never be
 * decrypted "as" a BYOK key and vice versa. Add new purposes here; the runtime check only
 * enforces the shape so private plugins can define their own.
 */
export const PURPOSES = [
  "github_token",
  "github_refresh_token",
  "byok_key",
  "webhook_secret",
] as const;
export type Purpose = (typeof PURPOSES)[number];
const PURPOSE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Binds a ciphertext to one row of one table (plus the org, which the keyring supplies). */
export interface RecordContext {
  readonly purpose: Purpose;
  readonly recordId: string;
}

/** An org data key (DEK) as stored in the database: never the key itself. */
export interface WrappedDataKey {
  /** Data-key version, 1-based, increases on every DEK rotation. */
  readonly version: number;
  readonly kekVersion: string;
  readonly blob: Uint8Array;
}

/**
 * Ciphertext format `rk1:<base64url( dekVersion u32 || nonce(12) || tag(16) || body )>`.
 * The format name and the data-key version are also fed into the AAD, so flipping a header
 * byte fails authentication instead of being silently reinterpreted.
 */
const FORMAT = "rk1";
export const CIPHERTEXT_PREFIX = `${FORMAT}:`;
const FORMAT_PATTERN = /^rk([0-9]{1,3}):/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const VERSION_BYTES = 4;
/** Smallest `rk1:` payload: the header of an empty-body ciphertext (mirrored by packages/db). */
export const MIN_CIPHERTEXT_BYTES = VERSION_BYTES + NONCE_LENGTH + TAG_LENGTH;
const MAX_VERSION = 0xffff_ffff;

const WRAPPED_FORMAT = "rkw1";
const DATA_KEY_VERSION_PATTERN = /^[1-9][0-9]{0,9}$/;

const assertVersion = (version: number): void => {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new CryptoError("invalid_key");
  }
};

const assertOrgId = (orgId: string): void => {
  if (typeof orgId !== "string" || orgId.length === 0) throw new CryptoError("invalid_context");
};

const recordAad = (orgId: string, version: number, context: RecordContext): Buffer => {
  if (typeof context.purpose !== "string" || !PURPOSE_PATTERN.test(context.purpose)) {
    throw new CryptoError("invalid_context");
  }
  if (typeof context.recordId !== "string" || context.recordId.length === 0) {
    throw new CryptoError("invalid_context");
  }
  return encodeAad([FORMAT, String(version), orgId, context.purpose, context.recordId]);
};

const decodeBase64UrlStrict = (text: string): Buffer => {
  if (text.length === 0 || !BASE64URL_PATTERN.test(text))
    throw new CryptoError("malformed_ciphertext");
  const bytes = Buffer.from(text, "base64url");
  // Canonical form only: otherwise unused padding bits could change without failing.
  if (bytes.toString("base64url") !== text) throw new CryptoError("malformed_ciphertext");
  return bytes;
};

const parseCiphertext = (text: string): { version: number; sealed: Sealed } => {
  if (typeof text !== "string") throw new CryptoError("malformed_ciphertext");
  const match = FORMAT_PATTERN.exec(text);
  if (match === null) throw new CryptoError("malformed_ciphertext");
  if (match[1] !== "1") throw new CryptoError("unsupported_format");
  const bytes = decodeBase64UrlStrict(text.slice(match[0].length));
  if (bytes.length < MIN_CIPHERTEXT_BYTES) throw new CryptoError("malformed_ciphertext");
  const nonceEnd = VERSION_BYTES + NONCE_LENGTH;
  return {
    version: bytes.readUInt32BE(0),
    sealed: {
      nonce: bytes.subarray(VERSION_BYTES, nonceEnd),
      tag: bytes.subarray(nonceEnd, nonceEnd + TAG_LENGTH),
      ciphertext: bytes.subarray(nonceEnd + TAG_LENGTH),
    },
  };
};

/** Cheap structural check (prefix and alphabet), e.g. to assert a column holds ciphertext. */
export const isCiphertext = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith(CIPHERTEXT_PREFIX) &&
  BASE64URL_PATTERN.test(value.slice(CIPHERTEXT_PREFIX.length));

/** Storable text form of a wrapped data key: `rkw1:<version>:<kekVersion>:<base64url blob>`. */
export const encodeWrappedDataKey = (key: WrappedDataKey): string => {
  assertVersion(key.version);
  if (!isKekVersion(key.kekVersion) || key.blob.length === 0) throw new CryptoError("invalid_key");
  return `${WRAPPED_FORMAT}:${key.version}:${key.kekVersion}:${Buffer.from(key.blob).toString("base64url")}`;
};

export const decodeWrappedDataKey = (text: string): WrappedDataKey => {
  const parts = typeof text === "string" ? text.split(":") : [];
  if (parts.length !== 4 || parts[0] !== WRAPPED_FORMAT)
    throw new CryptoError("malformed_ciphertext");
  const [, version, kekVersion, blob] = parts as [string, string, string, string];
  if (!DATA_KEY_VERSION_PATTERN.test(version) || !isKekVersion(kekVersion)) {
    throw new CryptoError("malformed_ciphertext");
  }
  const number = Number(version);
  assertVersion(number); // the pattern alone admits values above u32 MAX_VERSION
  return { version: number, kekVersion, blob: decodeBase64UrlStrict(blob) };
};

const assertKeySet = (keys: readonly WrappedDataKey[]): void => {
  if (keys.length === 0) throw new CryptoError("invalid_key");
  const versions = new Set<number>();
  for (const key of keys) {
    assertVersion(key.version);
    if (versions.has(key.version)) throw new CryptoError("invalid_key");
    versions.add(key.version);
  }
};

/** Generates a fresh 256-bit data key for an org and returns only its wrapped form. */
export const generateWrappedDataKey = async (
  wrapper: KeyWrapper,
  orgId: string,
  version = 1,
): Promise<WrappedDataKey> => {
  assertOrgId(orgId);
  assertVersion(version);
  const dataKey = randomBytes(KEY_LENGTH);
  try {
    const wrapped = await wrapper.wrap(dataKey, { orgId, dataKeyVersion: version });
    return { version, ...wrapped };
  } finally {
    zero(dataKey);
  }
};

/**
 * DEK rotation, step 1: add a new data-key version. Store the result, reopen keyrings (the new
 * version becomes current), then `reencrypt` rows at your own pace; old versions keep
 * decrypting until you drop them from the stored set.
 */
export const rotateDataKey = async (
  wrapper: KeyWrapper,
  orgId: string,
  keys: readonly WrappedDataKey[],
): Promise<WrappedDataKey[]> => {
  assertKeySet(keys);
  const next = Math.max(...keys.map((k) => k.version)) + 1;
  return [...keys, await generateWrappedDataKey(wrapper, orgId, next)];
};

/**
 * KEK rotation: re-wrap every data key under the wrapper's current KEK. Ciphertexts are
 * untouched. Run it with a wrapper that still holds the old KEK; drop the old KEK afterwards.
 */
export const rewrapDataKeys = async (
  wrapper: KeyWrapper,
  orgId: string,
  keys: readonly WrappedDataKey[],
): Promise<WrappedDataKey[]> => {
  assertOrgId(orgId);
  assertKeySet(keys);
  const out: WrappedDataKey[] = [];
  for (const key of keys) {
    if (key.kekVersion === wrapper.currentKekVersion) {
      out.push(key);
      continue;
    }
    const context = { orgId, dataKeyVersion: key.version };
    const dataKey = await wrapper.unwrap(key.blob, key.kekVersion, context);
    try {
      out.push({ version: key.version, ...(await wrapper.wrap(dataKey, context)) });
    } finally {
      zero(dataKey);
    }
  }
  return out;
};

/**
 * An org's unwrapped data keys, held in memory for the lifetime of a request or job. Encrypts
 * under the newest version and decrypts under any version it holds. Call `destroy()` when done.
 */
export class OrgKeyring {
  readonly orgId: string;
  readonly currentVersion: number;
  readonly #keys: Map<number, Buffer>;
  #destroyed = false;

  private constructor(orgId: string, keys: Map<number, Buffer>) {
    this.orgId = orgId;
    this.#keys = keys;
    this.currentVersion = Math.max(...keys.keys());
  }

  /** Unwraps every stored data key through the `KeyWrapper`. Fails closed on any bad key. */
  static async open(
    wrapper: KeyWrapper,
    orgId: string,
    wrapped: readonly WrappedDataKey[],
  ): Promise<OrgKeyring> {
    assertOrgId(orgId);
    assertKeySet(wrapped);
    const keys = new Map<number, Buffer>();
    try {
      for (const key of wrapped) {
        const dataKey = await wrapper.unwrap(key.blob, key.kekVersion, {
          orgId,
          dataKeyVersion: key.version,
        });
        if (dataKey.length !== KEY_LENGTH) {
          zero(dataKey);
          throw new CryptoError("invalid_key");
        }
        keys.set(key.version, dataKey);
      }
    } catch (error) {
      for (const dataKey of keys.values()) zero(dataKey);
      throw error;
    }
    return new OrgKeyring(orgId, keys);
  }

  /** Data-key versions this keyring can decrypt, ascending. */
  get versions(): number[] {
    return [...this.#keys.keys()].sort((a, b) => a - b);
  }

  encrypt(plaintext: Uint8Array | string, context: RecordContext): string {
    this.#assertLive();
    const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    return this.#encryptWith(this.currentVersion, bytes, context);
  }

  decrypt(ciphertext: string, context: RecordContext): Buffer {
    this.#assertLive();
    const { version, sealed } = parseCiphertext(ciphertext);
    return open(this.#key(version), sealed, recordAad(this.orgId, version, context));
  }

  decryptToString(ciphertext: string, context: RecordContext): string {
    const bytes = this.decrypt(ciphertext, context);
    try {
      return bytes.toString("utf8");
    } finally {
      zero(bytes);
    }
  }

  /**
   * DEK rotation, step 2: returns the same secret encrypted under the current version. Returns
   * the input unchanged (after authenticating it) when it is already current.
   */
  reencrypt(ciphertext: string, context: RecordContext): string {
    const { version } = parseCiphertext(ciphertext);
    const plaintext = this.decrypt(ciphertext, context);
    try {
      if (version === this.currentVersion) return ciphertext;
      return this.#encryptWith(this.currentVersion, plaintext, context);
    } finally {
      zero(plaintext);
    }
  }

  /** Zeroes every data key. The keyring refuses all calls afterwards. */
  destroy(): void {
    for (const key of this.#keys.values()) zero(key);
    this.#keys.clear();
    this.#destroyed = true;
  }

  #encryptWith(version: number, plaintext: Uint8Array, context: RecordContext): string {
    const sealed = seal(this.#key(version), plaintext, recordAad(this.orgId, version, context));
    const header = Buffer.allocUnsafe(VERSION_BYTES);
    header.writeUInt32BE(version);
    const payload = Buffer.concat([header, sealed.nonce, sealed.tag, sealed.ciphertext]);
    return CIPHERTEXT_PREFIX + payload.toString("base64url");
  }

  #key(version: number): Buffer {
    const key = this.#keys.get(version);
    if (key === undefined) throw new CryptoError("unknown_key_version");
    return key;
  }

  #assertLive(): void {
    if (this.#destroyed) throw new CryptoError("keyring_destroyed");
  }
}
