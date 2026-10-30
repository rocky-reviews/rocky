import {
  createRepositoryAccessCheck,
  DENY_TTL_MS,
  type Clock,
  type CollaboratorReader,
  type RepositoryAccessAnswer,
  type RepositoryAccessCheck,
  type RepositoryAccessSource,
  type RepositoryRef,
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

const systemClock: Clock = { now: () => new Date() };

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
    // No installation to ask membership on behalf of: nothing can be verified.
    if (context.installationId === null) return none("no_installation");
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
      {
        installationId: context.installationId,
        id: repositoryId,
        fullName: context.repositoryFullName,
      },
    );
  },
});

export interface RepositoryAccessOptions extends MemberAccessSourceOptions {
  readonly log: Logger;
  readonly clock?: Clock;
  readonly allowTtlMs?: number;
  readonly maxEntries?: number;
}

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

export interface MembershipDenialCacheOptions {
  readonly clock?: Clock;
  /** 1 ms … `DENY_TTL_MS` (default: `DENY_TTL_MS`); never longer than the core's deny cache. */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

const DEFAULT_MEMBERSHIP_ENTRIES = 10_000;
const MAX_MEMBERSHIP_ENTRIES = 1_000_000;
/** GitHub's user-login shape, as the forge adapter checks it; anything else is asked uncached. */
const USER_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const membershipKey = (ref: RepositoryRef, login: string): string | null => {
  if (
    !Number.isSafeInteger(ref.installationId) ||
    ref.installationId <= 0 ||
    !Number.isSafeInteger(ref.repositoryId) ||
    ref.repositoryId <= 0 ||
    typeof login !== "string" ||
    !USER_LOGIN.test(login)
  ) {
    return null;
  }
  return `${ref.installationId}:${ref.repositoryId}:${login.toLowerCase()}`;
};

/**
 * Remembers "not a collaborator" answers for at most the core's deny lifetime (H4-1, ADR 0033
 * W11). Every membership question mints and revokes an installation token, and the installation's
 * rate limit is shared with the worker. The core caches each member's deny for 30 s, but a member
 * can drop their own entries at will (every sign-in and sign-out invalidates them) and so make the
 * server mint again for every public or internal repository of the inbox. This cache sits below
 * that: keyed by installation, repository and the login GitHub gave for the token, so no
 * invalidation reaches it, and one `false` costs the installation at most one mint per 30 s.
 *
 * Only `false` is remembered. A remembered `true` would stretch ADR 0011's 5-minute bound by
 * this cache's lifetime (the check's allow is dated from its own question, not from the older
 * membership answer); a remembered `false` can only delay a re-grant, like the core's deny cache.
 * Errors are never remembered (the next question asks again; the core caches the transient deny
 * for 5 s). An entry is fresh only when `checkedAt ≤ now < expiresAt`, so a clock that moves
 * backwards does not keep it alive. Malformed input is passed through uncached (the adapter
 * refuses it). Bounded, least recently used first.
 */
export const cacheMembershipDenials = (
  inner: CollaboratorReader,
  options: MembershipDenialCacheOptions = {},
): CollaboratorReader => {
  const ttl = options.ttlMs ?? DENY_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > DENY_TTL_MS) {
    throw new RangeError(`membership deny cache ttlMs must be 1 … ${DENY_TTL_MS}`);
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MEMBERSHIP_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_MEMBERSHIP_ENTRIES) {
    throw new RangeError(`membership deny cache maxEntries must be 1 … ${MAX_MEMBERSHIP_ENTRIES}`);
  }
  const clock = options.clock ?? systemClock;
  const denied = new Map<string, { checkedAt: number; expiresAt: number }>();

  return {
    isCollaborator: async (ref, login) => {
      const key = membershipKey(ref, login);
      if (key === null) return inner.isCollaborator(ref, login);
      const now = clock.now().getTime();
      const entry = denied.get(key);
      if (entry !== undefined) {
        if (entry.checkedAt <= now && now < entry.expiresAt) {
          denied.delete(key);
          denied.set(key, entry);
          return false;
        }
        denied.delete(key);
      }
      const answer = await inner.isCollaborator(ref, login);
      if (answer === false) {
        denied.set(key, { checkedAt: now, expiresAt: now + ttl });
        while (denied.size > maxEntries) {
          const oldest = denied.keys().next().value;
          if (oldest === undefined) break;
          denied.delete(oldest);
        }
      }
      return answer;
    },
  };
};
