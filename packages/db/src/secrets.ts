import { and, eq } from "drizzle-orm";
import type { TenantTx } from "./client.js";
import { members, orgs } from "./schema.js";

/**
 * The only writers of the `*_ciphertext` / `*_key_version` column pairs (P2-3, ADR 0006).
 *
 * Storage convention: a `bytea` column holds the UTF-8 bytes of the self-describing text form
 * `packages/crypto` produces (`rk1:…` for a record ciphertext, `rkw1:…` for a wrapped data
 * key) and the integer column holds the data-key version the value was made with, so "which
 * rows still use version n" is one query. Callers encrypt with an `OrgKeyring` and pass the
 * result here; nothing in this module can see a plaintext, and a value that does not have the
 * shape of a ciphertext is refused before any SQL runs. That check is structural (prefix and
 * alphabet, mirrored from crypto so this package does not depend on it at runtime), not
 * cryptographic: it stops a plaintext token from reaching the database by mistake, not a
 * forged ciphertext, which fails to authenticate when decrypted.
 */

export const CIPHERTEXT_PREFIX = "rk1:";
export const WRAPPED_KEY_PREFIX = "rkw1:";

const CIPHERTEXT = /^rk1:[A-Za-z0-9_-]+$/;
const WRAPPED_KEY = /^rkw1:[1-9][0-9]{0,9}:[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]+$/;
const PG_INTEGER_MAX = 2_147_483_647;

export interface StoredSecret {
  /** The text form (`rk1:…` or `rkw1:…`) exactly as it was stored. */
  readonly ciphertext: string;
  readonly keyVersion: number;
}

const assertKeyVersion = (version: number): void => {
  if (!Number.isSafeInteger(version) || version < 1 || version > PG_INTEGER_MAX) {
    throw new Error("secrets: key version must be a positive integer");
  }
};

const assertCiphertext = (value: string): void => {
  if (typeof value !== "string" || !CIPHERTEXT.test(value)) {
    throw new Error("secrets: expected a record ciphertext (rk1:…)");
  }
};

const assertWrappedKey = (value: string): void => {
  if (typeof value !== "string" || !WRAPPED_KEY.test(value)) {
    throw new Error("secrets: expected a wrapped data key (rkw1:…)");
  }
};

const toBytes = (text: string): Buffer => Buffer.from(text, "utf8");

const fromRow = (ciphertext: Buffer | null, keyVersion: number | null): StoredSecret | null =>
  ciphertext === null || keyVersion === null
    ? null
    : { ciphertext: ciphertext.toString("utf8"), keyVersion };

/** Stores the org's wrapped data key (`rkw1:…`) and its data-key version. */
export const storeOrgDataKey = async (
  tx: TenantTx,
  wrappedKey: string,
  version: number,
): Promise<void> => {
  assertWrappedKey(wrappedKey);
  assertKeyVersion(version);
  const updated = await tx.db
    .update(orgs)
    .set({ dataKeyCiphertext: toBytes(wrappedKey), dataKeyVersion: version })
    .where(eq(orgs.id, tx.orgId))
    .returning({ id: orgs.id });
  if (updated.length !== 1) throw new Error("secrets: no such org");
};

export const loadOrgDataKey = async (tx: TenantTx): Promise<StoredSecret | null> => {
  const [row] = await tx.db
    .select({ ciphertext: orgs.dataKeyCiphertext, keyVersion: orgs.dataKeyVersion })
    .from(orgs)
    .where(eq(orgs.id, tx.orgId));
  return row === undefined ? null : fromRow(row.ciphertext, row.keyVersion);
};

/** Stores the org's encrypted BYOK LLM key (`rk1:…`, purpose `byok_key`, record id = org id). */
export const storeOrgLlmApiKey = async (
  tx: TenantTx,
  ciphertext: string,
  keyVersion: number,
): Promise<void> => {
  assertCiphertext(ciphertext);
  assertKeyVersion(keyVersion);
  const updated = await tx.db
    .update(orgs)
    .set({ llmApiKeyCiphertext: toBytes(ciphertext), llmApiKeyVersion: keyVersion })
    .where(eq(orgs.id, tx.orgId))
    .returning({ id: orgs.id });
  if (updated.length !== 1) throw new Error("secrets: no such org");
};

export const loadOrgLlmApiKey = async (tx: TenantTx): Promise<StoredSecret | null> => {
  const [row] = await tx.db
    .select({ ciphertext: orgs.llmApiKeyCiphertext, keyVersion: orgs.llmApiKeyVersion })
    .from(orgs)
    .where(eq(orgs.id, tx.orgId));
  return row === undefined ? null : fromRow(row.ciphertext, row.keyVersion);
};

/**
 * Stores a member's encrypted forge token (`rk1:…`, record id = member id). A member of another
 * org does not exist for this transaction (RLS), so the update matches no row and this throws.
 */
export const storeForgeToken = async (
  tx: TenantTx,
  memberId: string,
  ciphertext: string,
  keyVersion: number,
): Promise<void> => {
  assertCiphertext(ciphertext);
  assertKeyVersion(keyVersion);
  const updated = await tx.db
    .update(members)
    .set({ forgeTokenCiphertext: toBytes(ciphertext), forgeTokenKeyVersion: keyVersion })
    .where(and(eq(members.orgId, tx.orgId), eq(members.id, memberId)))
    .returning({ id: members.id });
  if (updated.length !== 1) throw new Error("secrets: no such member in this org");
};

export const loadForgeToken = async (
  tx: TenantTx,
  memberId: string,
): Promise<StoredSecret | null> => {
  const [row] = await tx.db
    .select({ ciphertext: members.forgeTokenCiphertext, keyVersion: members.forgeTokenKeyVersion })
    .from(members)
    .where(and(eq(members.orgId, tx.orgId), eq(members.id, memberId)));
  return row === undefined ? null : fromRow(row.ciphertext, row.keyVersion);
};
