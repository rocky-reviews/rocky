import {
  createRepositoryAccessCheck,
  type Clock,
  type RepositoryAccessAnswer,
  type RepositoryAccessCheck,
  type RepositoryAccessSource,
  type UserAccessReader,
} from "@rocky-reviews/core";
import { decodeWrappedDataKey, OrgKeyring, type KeyWrapper } from "@rocky-reviews/crypto";
import { loadRepositoryAccessContext, type Db } from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";

/**
 * The repository access check wired to Postgres, the org's keyring and the forge (P3-6,
 * ADR 0011). No route calls it yet: P7-1/P7-2 must call `check` on every request that reads or
 * writes a repository's data (ADR 0011 §6), and the invalidation hooks on login, logout and
 * membership changes.
 *
 * Per forge question, `memberAccessSource`:
 * 1. reads, in one `withOrg` transaction for the request's org, whether the member exists, the
 *    repository's name, the member's encrypted token and the org's wrapped data key;
 * 2. after the transaction (no transaction is held across an HTTP call), opens the org keyring,
 *    decrypts the token (purpose `github_token`, record id = member id), and destroys the keyring;
 * 3. asks the forge as the member, bound to the member's `forge_user_id`; the token lives in this
 *    call's frame only.
 *
 * Logs carry ids and fixed reason codes; the token, its ciphertext and any error text never.
 */

/** ADR 0006: the AAD purpose of a member's forge token; the record id is the member id. */
export const MEMBER_TOKEN_PURPOSE = "github_token";

export interface MemberAccessSourceOptions {
  readonly db: Db;
  readonly keys: KeyWrapper;
  readonly reader: UserAccessReader;
}

const none = (reason: Extract<RepositoryAccessAnswer, { access: "none" }>["reason"]) =>
  ({ access: "none", reason }) as const;

export const memberAccessSource = (options: MemberAccessSourceOptions): RepositoryAccessSource => ({
  readAccess: async ({ orgId, memberId, repositoryId }) => {
    const context = await options.db.withOrg(orgId, (tx) =>
      loadRepositoryAccessContext(tx, { memberId, forgeRepoId: repositoryId }),
    );
    if (!context.member || context.forgeUserId === null) return none("not_member");
    if (context.repositoryFullName === null) return none("unknown_repository");
    if (context.token === null) return none("no_token");
    if (context.dataKey === null) return none("token_unreadable");

    let token: string;
    let keyring: OrgKeyring | undefined;
    try {
      keyring = await OrgKeyring.open(options.keys, orgId, [
        decodeWrappedDataKey(context.dataKey.ciphertext),
      ]);
      token = keyring.decryptToString(context.token.ciphertext, {
        purpose: MEMBER_TOKEN_PURPOSE,
        recordId: memberId,
      });
    } catch {
      return none("token_unreadable");
    } finally {
      keyring?.destroy();
    }
    return options.reader.readUserRepositoryAccess(
      // The reader checks that GitHub says this token is `forge_user_id`'s (token_user_mismatch).
      { token, userId: context.forgeUserId },
      { id: repositoryId, fullName: context.repositoryFullName },
    );
  },
});

export interface RepositoryAccessOptions extends MemberAccessSourceOptions {
  readonly log: Logger;
  readonly clock?: Clock;
  readonly allowTtlMs?: number;
  readonly maxEntries?: number;
}

const systemClock: Clock = { now: () => new Date() };

export const createRepositoryAccess = (options: RepositoryAccessOptions): RepositoryAccessCheck =>
  createRepositoryAccessCheck({
    source: memberAccessSource(options),
    clock: options.clock ?? systemClock,
    ...(options.allowTtlMs === undefined ? {} : { allowTtlMs: options.allowTtlMs }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    onDecision: (event) => {
      const fields = {
        event: "repository_access",
        orgId: event.orgId,
        memberId: event.memberId,
        repositoryId: event.repositoryId,
        allowed: event.allowed,
        reason: event.reason,
        cached: event.cached,
        joined: event.joined,
      };
      if (event.cached) options.log.debug(fields, "repository access");
      else options.log.info(fields, "repository access");
    },
  });
