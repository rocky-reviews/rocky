import type { OrgId } from "@rocky-reviews/core";
import { decodeWrappedDataKey, OrgKeyring, type KeyWrapper } from "@rocky-reviews/crypto";
import { loadTokenConnection, type Db } from "@rocky-reviews/db";
import type { GitHubTokenClient } from "@rocky-reviews/forge-github";
import type { TokenRepositoryOpener } from "./analysis.js";

/**
 * Repository sessions on a token org's personal access token, for the analysis lane (P10-4,
 * ADR 0045 §6). The token is stored like a member's sign-in token (envelope-encrypted under the
 * org's data key, purpose `github_token`, record id = the owner member, ADR 0020 §4): its
 * ciphertexts are read in one short `withOrg` transaction, the keyring is opened outside it, the
 * token decrypted for this one session and the keyring destroyed. It is never logged, returned
 * or put in an error; failures are fixed codes the analysis stores (`no_token`,
 * `token_expired`, `token_unreadable`, `token_rejected`, `forbidden`).
 */

/** The ciphertext purpose the server stores the token under (`MEMBER_TOKEN_PURPOSE`). */
export const TOKEN_PURPOSE = "github_token";

export interface TokenRepositoriesDeps {
  readonly db: Pick<Db, "withOrg">;
  readonly keys: KeyWrapper;
  readonly client: Pick<GitHubTokenClient, "openRepository">;
  readonly now?: () => Date;
}

export const createTokenRepositories = (deps: TokenRepositoriesDeps): TokenRepositoryOpener => ({
  openRepository: async (orgId: OrgId, forgeRepoId: number) => {
    const connection = await deps.db.withOrg(orgId, loadTokenConnection);
    if (connection === null || connection.token === null) return { ok: false, code: "no_token" };
    const now = (deps.now ?? (() => new Date()))();
    if (connection.expiresAt !== null && connection.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, code: "token_expired" };
    }
    if (connection.dataKey === null) return { ok: false, code: "token_unreadable" };
    let token: string;
    let keyring: OrgKeyring | undefined;
    try {
      keyring = await OrgKeyring.open(deps.keys, orgId, [
        decodeWrappedDataKey(connection.dataKey.ciphertext),
      ]);
      token = keyring.decryptToString(connection.token.ciphertext, {
        purpose: TOKEN_PURPOSE,
        recordId: connection.memberId,
      });
    } catch {
      return { ok: false, code: "token_unreadable" };
    } finally {
      keyring?.destroy();
    }
    const opened = await deps.client.openRepository(token, forgeRepoId);
    if (!opened.ok) {
      return {
        ok: false,
        code: opened.reason === "forbidden" ? "forbidden" : "token_rejected",
      };
    }
    return { ok: true, session: opened.value };
  },
});
