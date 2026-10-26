import { randomBytes } from "node:crypto";
import { encodeAad } from "./aad.js";
import { KEY_LENGTH, NONCE_LENGTH, TAG_LENGTH, assertKey, open, seal, zero } from "./aead.js";
import { CryptoError } from "./errors.js";

/** What a wrapped data key is bound to. KMS adapters pass this as the encryption context. */
export interface WrapContext {
  readonly orgId: string;
  readonly dataKeyVersion: number;
}

export interface WrappedBlob {
  /** Identifies the key-encryption key that produced `blob`. */
  readonly kekVersion: string;
  readonly blob: Uint8Array;
}

/**
 * Port: wraps and unwraps per-org data keys with a key-encryption key (KEK). Production uses a
 * KMS adapter (not in this repo); development uses `LocalKeyWrapper` with keys from the
 * environment. An implementation holds every KEK version still in use and wraps with one of
 * them (`currentKekVersion`), so KEK rotation is a re-wrap, never a re-encrypt.
 */
export interface KeyWrapper {
  readonly currentKekVersion: string;
  wrap(dataKey: Uint8Array, context: WrapContext): Promise<WrappedBlob>;
  unwrap(blob: Uint8Array, kekVersion: string, context: WrapContext): Promise<Buffer>;
}

export const KEK_KEYS_ENV = "ROCKY_KEK_KEYS";
export const KEK_CURRENT_ENV = "ROCKY_KEK_CURRENT";

/**
 * A real 256-bit key has about 28 distinct byte values; fewer than this means a placeholder
 * (all zeros, a repeated byte, an ASCII string) was pasted in. The chance that a random key
 * fails this check is far below 1e-10.
 */
export const MIN_DISTINCT_KEY_BYTES = 16;

const KEK_VERSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const WRAP_PURPOSE = "data_key";

export const isKekVersion = (value: string): boolean => KEK_VERSION_PATTERN.test(value);

/** A KEK must be exactly 32 bytes and look random. */
export const assertStrongKey = (key: Uint8Array): void => {
  assertKey(key);
  if (new Set(key).size < MIN_DISTINCT_KEY_BYTES) throw new CryptoError("invalid_key");
};

const wrapAad = (context: WrapContext): Buffer => {
  if (!Number.isSafeInteger(context.dataKeyVersion) || context.dataKeyVersion < 1) {
    throw new CryptoError("invalid_context");
  }
  if (typeof context.orgId !== "string" || context.orgId.length === 0) {
    throw new CryptoError("invalid_context");
  }
  return encodeAad([context.orgId, WRAP_PURPOSE, String(context.dataKeyVersion)]);
};

/**
 * KEKs by version id. The last entry is the default current version, so order matters: only an
 * entry list (array, `Map`) keeps the listed order; a plain `Record` follows JavaScript key
 * order, which moves integer-like ids such as `"10"` ahead of `"v1"`. `localKeyWrapperFromEnv`
 * always builds an entry list.
 */
export type KekEntries =
  Iterable<readonly [string, Uint8Array]> | Readonly<Record<string, Uint8Array>>;

const toEntries = (keys: KekEntries): (readonly [string, Uint8Array])[] =>
  typeof keys === "object" && Symbol.iterator in keys
    ? [...(keys as Iterable<readonly [string, Uint8Array]>)]
    : Object.entries(keys as Readonly<Record<string, Uint8Array>>);

/**
 * Local `KeyWrapper`: AES-256-GCM with 32-byte KEKs held in memory. Blob layout:
 * `nonce(12) || tag(16) || wrapped key(32)`. Key bytes are copied on construction, so the
 * caller's buffers are neither shared nor zeroed by `destroy()`.
 */
export class LocalKeyWrapper implements KeyWrapper {
  readonly currentKekVersion: string;
  readonly #keys: Map<string, Uint8Array>;
  #destroyed = false;

  constructor(keys: KekEntries, currentKekVersion?: string) {
    const entries = toEntries(keys);
    if (entries.length === 0) throw new CryptoError("invalid_key");
    this.#keys = new Map();
    for (const [version, key] of entries) {
      if (!isKekVersion(version) || this.#keys.has(version)) throw new CryptoError("invalid_key");
      assertStrongKey(key);
      this.#keys.set(version, Buffer.from(key));
    }
    const current = currentKekVersion ?? entries[entries.length - 1]?.[0] ?? "";
    if (!this.#keys.has(current)) throw new CryptoError("unknown_key_version");
    this.currentKekVersion = current;
  }

  #key(version: string): Uint8Array {
    const key = this.#keys.get(version);
    if (key === undefined) throw new CryptoError("unknown_key_version");
    return key;
  }

  get kekVersions(): string[] {
    return [...this.#keys.keys()];
  }

  wrap(dataKey: Uint8Array, context: WrapContext): Promise<WrappedBlob> {
    return Promise.resolve().then(() => {
      this.#assertLive();
      assertKey(dataKey);
      const sealed = seal(this.#key(this.currentKekVersion), dataKey, wrapAad(context));
      return {
        kekVersion: this.currentKekVersion,
        blob: Buffer.concat([sealed.nonce, sealed.tag, sealed.ciphertext]),
      };
    });
  }

  unwrap(blob: Uint8Array, kekVersion: string, context: WrapContext): Promise<Buffer> {
    return Promise.resolve().then(() => {
      this.#assertLive();
      const key = this.#key(kekVersion);
      if (blob.length !== NONCE_LENGTH + TAG_LENGTH + KEY_LENGTH) {
        throw new CryptoError("malformed_ciphertext");
      }
      const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
      return open(
        key,
        {
          nonce: bytes.subarray(0, NONCE_LENGTH),
          tag: bytes.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH),
          ciphertext: bytes.subarray(NONCE_LENGTH + TAG_LENGTH),
        },
        wrapAad(context),
      );
    });
  }

  /** Zeroes every KEK copy it holds. The wrapper refuses all calls afterwards. */
  destroy(): void {
    for (const key of this.#keys.values()) zero(key);
    this.#keys.clear();
    this.#destroyed = true;
  }

  #assertLive(): void {
    if (this.#destroyed) throw new CryptoError("keyring_destroyed");
  }
}

/** A fresh base64 KEK for `ROCKY_KEK_KEYS` (`pnpm dev` writes one into `.env`). */
export const generateLocalKek = (): string => randomBytes(KEY_LENGTH).toString("base64");

const decodeBase64Strict = (value: string): Buffer => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new CryptoError("invalid_key");
  return Buffer.from(value, "base64");
};

/**
 * Builds a `LocalKeyWrapper` from the environment:
 * `ROCKY_KEK_KEYS="v1=<base64 32 bytes>,v2=<base64 32 bytes>"` and optionally
 * `ROCKY_KEK_CURRENT=v2` (default: the last entry as listed). Errors never echo the values.
 */
export const localKeyWrapperFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalKeyWrapper => {
  const raw = env[KEK_KEYS_ENV];
  if (raw === undefined || raw.trim() === "") throw new CryptoError("invalid_key");
  const entries: [string, Uint8Array][] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new CryptoError("invalid_key");
    const version = entry.slice(0, separator).trim();
    if (!isKekVersion(version) || seen.has(version)) throw new CryptoError("invalid_key");
    seen.add(version);
    entries.push([version, decodeBase64Strict(entry.slice(separator + 1).trim())]);
  }
  const current = env[KEK_CURRENT_ENV]?.trim();
  return new LocalKeyWrapper(
    entries,
    current === undefined || current === "" ? undefined : current,
  );
};
