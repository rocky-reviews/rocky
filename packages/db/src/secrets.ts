import { and, eq, isNull } from "drizzle-orm";
import { TenantContextError, type TenantTx } from "./client.js";
import { members, orgs } from "./schema.js";

/**
 * The only writers of the `*_ciphertext` / `*_key_version` column pairs (P2-3, ADR 0006).
 *
 * Storage convention: a `bytea` column holds the UTF-8 bytes of the self-describing text form
 * `packages/crypto` produces (`rk1:…` for a record ciphertext, `rkw1:…` for a wrapped data
 * key) and the integer column holds the data-key version the value was made with, so "which
 * rows still use version n" is one query. Callers encrypt with an `OrgKeyring` and pass the
 * result here; nothing in this module can see a plaintext, and a value that does not have the
 * shape of a ciphertext is refused before any SQL runs: prefix, canonical base64url, the
 * minimum payload a real ciphertext has (`u32 version || nonce(12) || tag(16)`), and a header
 * version equal to the column version. The check mirrors crypto's formats so this package does
 * not depend on it at runtime; it is structural, not cryptographic: it stops a plaintext token
 * from reaching the database by mistake, not a forged ciphertext, which fails to authenticate
 * when decrypted.
 *
 * Errors are `SecretStoreError` with a fixed message. A database error is rethrown with its
 * SQLSTATE only: the driver's message carries the statement parameters, which here are the
 * caller's values (a swapped argument would otherwise put a token into the error text).
 */

export const CIPHERTEXT_PREFIX = "rk1:";
export const WRAPPED_KEY_PREFIX = "rkw1:";

/**
 * `u32 version || nonce(12) || tag(16)`: the header every `rk1:` payload starts with. Mirrors
 * `MIN_CIPHERTEXT_BYTES` in `@rocky-reviews/crypto` (a test pins the two together).
 */
export const MIN_CIPHERTEXT_BYTES = 4 + 12 + 16;
/** A wrapped 256-bit key cannot be shorter than the key. */
const MIN_WRAPPED_KEY_BYTES = 32;
const PG_INTEGER_MAX = 2_147_483_647;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const WRAPPED_KEY = /^rkw1:([1-9][0-9]{0,9}):[A-Za-z0-9_-]{1,32}:([A-Za-z0-9_-]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE = /^[0-9A-Z]{5}$/;

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
  /** The SQLSTATE of the underlying database error, when there was one. */
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export interface StoredSecret {
  /** The text form (`rk1:…` or `rkw1:…`) exactly as it was stored. */
  readonly ciphertext: string;
  readonly keyVersion: number;
}

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= PG_INTEGER_MAX;

const assertKeyVersion = (version: number): void => {
  if (!isPositiveInteger(version)) {
    throw new SecretStoreError("secrets: key version must be a positive integer");
  }
};

/** Canonical base64url only, as crypto's decoder requires. */
const decodeBase64Url = (text: string): Buffer | null => {
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
};

const isCiphertextFor = (value: string, keyVersion: number): boolean => {
  if (typeof value !== "string" || !value.startsWith(CIPHERTEXT_PREFIX)) return false;
  const payload = decodeBase64Url(value.slice(CIPHERTEXT_PREFIX.length));
  return (
    payload !== null &&
    payload.length >= MIN_CIPHERTEXT_BYTES &&
    payload.readUInt32BE(0) === keyVersion
  );
};

const assertCiphertext = (value: string, keyVersion: number): void => {
  if (!isCiphertextFor(value, keyVersion)) {
    throw new SecretStoreError("secrets: expected a record ciphertext (rk1:…)");
  }
};

const isWrappedKeyFor = (value: string, version: number): boolean => {
  const match = typeof value === "string" ? WRAPPED_KEY.exec(value) : null;
  if (match === null || Number(match[1]) !== version) return false;
  const blob = decodeBase64Url(match[2] ?? "");
  return blob !== null && blob.length >= MIN_WRAPPED_KEY_BYTES;
};

const assertWrappedKey = (value: string, version: number): void => {
  if (!isWrappedKeyFor(value, version)) {
    throw new SecretStoreError("secrets: expected a wrapped data key (rkw1:…)");
  }
};

const assertMemberId = (memberId: string): void => {
  if (typeof memberId !== "string" || !UUID.test(memberId)) {
    throw new SecretStoreError("secrets: member id must be a uuid");
  }
};

const sqlState = (error: unknown): string | undefined => {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
  }
  return undefined;
};

/** Runs a query; a database failure becomes a `SecretStoreError` that carries no values. */
const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    // withOrg's guard errors carry fixed text only; Drizzle wraps them like any driver error.
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (error instanceof TenantContextError) throw error;
    if (cause instanceof TenantContextError) throw cause;
    throw new SecretStoreError("secrets: database error", sqlState(error));
  }
};

const toBytes = (text: string): Buffer => Buffer.from(text, "utf8");

const fromRow = (ciphertext: Buffer | null, keyVersion: number | null): StoredSecret | null =>
  ciphertext === null || keyVersion === null
    ? null
    : { ciphertext: ciphertext.toString("utf8"), keyVersion };

/**
 * Stores the org's wrapped data key (`rkw1:…`) and its data-key version, once: an org that
 * already has a key keeps it (overwriting would orphan every ciphertext made under the old
 * key). Rotation and KEK re-wrap go through `replaceOrgDataKey`.
 */
export const storeOrgDataKey = async (
  tx: TenantTx,
  wrappedKey: string,
  version: number,
): Promise<void> => {
  assertKeyVersion(version);
  assertWrappedKey(wrappedKey, version);
  await guarded(async () => {
    const updated = await tx.db
      .update(orgs)
      .set({ dataKeyCiphertext: toBytes(wrappedKey), dataKeyVersion: version })
      .where(and(eq(orgs.id, tx.orgId), isNull(orgs.dataKeyCiphertext)))
      .returning({ id: orgs.id });
    if (updated.length === 1) return;
    const [org] = await tx.db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, tx.orgId));
    throw new SecretStoreError(
      org === undefined ? "secrets: no such org" : "secrets: data key already provisioned",
    );
  });
};

/**
 * Replaces the org's wrapped data key by compare-and-swap on the version currently stored
 * (`rotateDataKey`: a new version; `rewrapDataKeys`: the same version under a new KEK). No
 * row matches when the stored version differs or no key was provisioned.
 */
export const replaceOrgDataKey = async (
  tx: TenantTx,
  wrappedKey: string,
  version: number,
  expectedCurrentVersion: number,
): Promise<void> => {
  assertKeyVersion(version);
  assertKeyVersion(expectedCurrentVersion);
  assertWrappedKey(wrappedKey, version);
  await guarded(async () => {
    const updated = await tx.db
      .update(orgs)
      .set({ dataKeyCiphertext: toBytes(wrappedKey), dataKeyVersion: version })
      .where(and(eq(orgs.id, tx.orgId), eq(orgs.dataKeyVersion, expectedCurrentVersion)))
      .returning({ id: orgs.id });
    if (updated.length !== 1) throw new SecretStoreError("secrets: data key version mismatch");
  });
};

export const loadOrgDataKey = (tx: TenantTx): Promise<StoredSecret | null> =>
  guarded(async () => {
    const [row] = await tx.db
      .select({ ciphertext: orgs.dataKeyCiphertext, keyVersion: orgs.dataKeyVersion })
      .from(orgs)
      .where(eq(orgs.id, tx.orgId));
    return row === undefined ? null : fromRow(row.ciphertext, row.keyVersion);
  });

/** Stores the org's encrypted BYOK LLM key (`rk1:…`, purpose `byok_key`, record id = org id). */
export const storeOrgLlmApiKey = async (
  tx: TenantTx,
  ciphertext: string,
  keyVersion: number,
): Promise<void> => {
  assertKeyVersion(keyVersion);
  assertCiphertext(ciphertext, keyVersion);
  await guarded(async () => {
    const updated = await tx.db
      .update(orgs)
      .set({ llmApiKeyCiphertext: toBytes(ciphertext), llmApiKeyVersion: keyVersion })
      .where(eq(orgs.id, tx.orgId))
      .returning({ id: orgs.id });
    if (updated.length !== 1) throw new SecretStoreError("secrets: no such org");
  });
};

export const loadOrgLlmApiKey = (tx: TenantTx): Promise<StoredSecret | null> =>
  guarded(async () => {
    const [row] = await tx.db
      .select({ ciphertext: orgs.llmApiKeyCiphertext, keyVersion: orgs.llmApiKeyVersion })
      .from(orgs)
      .where(eq(orgs.id, tx.orgId));
    return row === undefined ? null : fromRow(row.ciphertext, row.keyVersion);
  });

/**
 * Stores a member's encrypted forge token (`rk1:…`, record id = member id) and, for an expiring
 * token, when it expires (P7-1; `null` when it does not expire or the expiry is unknown). A
 * member of another org does not exist for this transaction (RLS), so the update matches no row
 * and this throws.
 */
export const storeForgeToken = async (
  tx: TenantTx,
  memberId: string,
  ciphertext: string,
  keyVersion: number,
  options: { readonly expiresAt?: Date | null } = {},
): Promise<void> => {
  assertMemberId(memberId);
  assertKeyVersion(keyVersion);
  assertCiphertext(ciphertext, keyVersion);
  const expiresAt = options.expiresAt ?? null;
  if (expiresAt !== null && !(expiresAt instanceof Date && Number.isFinite(expiresAt.getTime()))) {
    throw new SecretStoreError("secrets: token expiry must be a date");
  }
  await guarded(async () => {
    const updated = await tx.db
      .update(members)
      .set({
        forgeTokenCiphertext: toBytes(ciphertext),
        forgeTokenKeyVersion: keyVersion,
        forgeAccessExpiresAt: expiresAt,
      })
      .where(and(eq(members.orgId, tx.orgId), eq(members.id, memberId)))
      .returning({ id: members.id });
    if (updated.length !== 1) throw new SecretStoreError("secrets: no such member in this org");
  });
};

export const loadForgeToken = (tx: TenantTx, memberId: string): Promise<StoredSecret | null> => {
  assertMemberId(memberId);
  return guarded(async () => {
    const [row] = await tx.db
      .select({
        ciphertext: members.forgeTokenCiphertext,
        keyVersion: members.forgeTokenKeyVersion,
      })
      .from(members)
      .where(and(eq(members.orgId, tx.orgId), eq(members.id, memberId)));
    return row === undefined ? null : fromRow(row.ciphertext, row.keyVersion);
  });
};

/**
 * Deletes a member's stored forge token and its expiry (logout, ADR 0011 §6). Idempotent: a
 * member without a token stays without one. Throws when there is no such member in this org.
 */
export const clearForgeToken = async (tx: TenantTx, memberId: string): Promise<void> => {
  assertMemberId(memberId);
  await guarded(async () => {
    const updated = await tx.db
      .update(members)
      .set({ forgeTokenCiphertext: null, forgeTokenKeyVersion: null, forgeAccessExpiresAt: null })
      .where(and(eq(members.orgId, tx.orgId), eq(members.id, memberId)))
      .returning({ id: members.id });
    if (updated.length !== 1) throw new SecretStoreError("secrets: no such member in this org");
  });
};
