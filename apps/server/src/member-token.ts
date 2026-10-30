import type { ForgeUserCredential, OrgId } from "@rocky-reviews/core";
import { decodeWrappedDataKey, OrgKeyring, type KeyWrapper } from "@rocky-reviews/crypto";
import { loadMemberTokenContext, type Db } from "@rocky-reviews/db";
import { MEMBER_TOKEN_PURPOSE } from "./repository-access.js";

/**
 * A member's own forge credential for one call (P3-5, ADR 0026; the same handling as the
 * access check's `memberAccessSource`): the ciphertexts are read in one short `withOrg`
 * transaction, the org keyring is opened outside it, the token is decrypted (purpose
 * `github_token`, record id = member id: another member's or org's ciphertext does not decrypt)
 * and the keyring destroyed. The plaintext lives in the caller's frame only: never returned
 * through a log, an error or a response. Fixed reasons for every way it can be unavailable.
 */

export type MemberCredentialUnavailable =
  "not_member" | "no_token" | "token_expired" | "token_unreadable";

export type MemberCredentialResult =
  | { readonly ok: true; readonly credential: ForgeUserCredential }
  | { readonly ok: false; readonly reason: MemberCredentialUnavailable };

export interface MemberCredentialDeps {
  readonly db: Pick<Db, "withOrg">;
  readonly keys: KeyWrapper;
}

export const readMemberCredential = async (
  deps: MemberCredentialDeps,
  orgId: OrgId,
  memberId: string,
  now: Date,
): Promise<MemberCredentialResult> => {
  const context = await deps.db.withOrg(orgId, (tx) => loadMemberTokenContext(tx, memberId));
  if (context === null) return { ok: false, reason: "not_member" };
  if (context.token === null) return { ok: false, reason: "no_token" };
  if (context.expiresAt !== null && context.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "token_expired" };
  }
  if (context.dataKey === null) return { ok: false, reason: "token_unreadable" };
  let keyring: OrgKeyring | undefined;
  try {
    keyring = await OrgKeyring.open(deps.keys, orgId, [
      decodeWrappedDataKey(context.dataKey.ciphertext),
    ]);
    const token = keyring.decryptToString(context.token.ciphertext, {
      purpose: MEMBER_TOKEN_PURPOSE,
      recordId: memberId,
    });
    return { ok: true, credential: { token, userId: context.forgeUserId } };
  } catch {
    return { ok: false, reason: "token_unreadable" };
  } finally {
    keyring?.destroy();
  }
};
