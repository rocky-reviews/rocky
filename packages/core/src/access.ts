import { ForgeReadError, type ForgeNumericId, type UserRepositoryDenial } from "./forge.js";
import type { Clock, OrgId } from "./ports.js";

/**
 * Repository access check (P3-6, ADR 0011): a member may see a repository's data in Rocky only
 * while the forge says that member can read the repository. Rocky membership alone is not enough.
 *
 * The forge is asked with the member's own credential by a `RepositoryAccessSource` (the adapter
 * decrypts the token for that one call; nothing here ever sees it). Answers are cached per
 * org + member + repository:
 *
 * - an allow for at most `ACCESS_MAX_TTL_MS` (5 minutes), measured from the moment the forge was
 *   asked, so a member removed on the forge loses access at most 5 minutes after the removal;
 *   it is never extended or refreshed from an older answer, and an outage after it expires is a
 *   deny (a cached allow means "the forge said yes less than 5 minutes ago", nothing more);
 * - a deny for `DENY_TTL_MS` (definitive answers) or `TRANSIENT_DENY_TTL_MS` (outages, errors),
 *   which only delays a re-grant: caching a deny can never let anyone in.
 *
 * Fail closed: any thrown error, any answer of an unexpected shape, any invalid request, and an
 * allow that arrives after its own expiry are denies. The cache is bounded (least recently used
 * entries are evicted) and has invalidation hooks for login, logout, membership changes and org
 * deletion. A check that started before an invalidation never writes to the cache.
 */

/** The hard upper bound of a cached allow (the plan's "cached ≤ 5 min"). */
export const ACCESS_MAX_TTL_MS = 5 * 60_000;
/** How long a definitive deny (no access, no token, not a member) is reused. */
export const DENY_TTL_MS = 30_000;
/** How long a deny caused by an outage or an error is reused (a stampede guard only). */
export const TRANSIENT_DENY_TTL_MS = 5_000;
export const DEFAULT_ACCESS_CACHE_ENTRIES = 10_000;
/** The largest cache a caller may configure. */
export const MAX_ACCESS_CACHE_ENTRIES = 1_000_000;

export interface RepositoryAccessRequest {
  readonly orgId: OrgId;
  /** `members.id` of the member asking (a uuid). */
  readonly memberId: string;
  /** The forge's repository id (`repos.forge_repo_id`). */
  readonly repositoryId: ForgeNumericId;
}

/** Why access was denied. Fixed codes: safe to log and to count. */
export type AccessDenyReason =
  | UserRepositoryDenial
  /** The request's ids are not well-formed. Never cached. */
  | "invalid_request"
  /** No such member in this org. */
  | "not_member"
  /** The org has no such repository (not mirrored, or another tenant's). */
  | "unknown_repository"
  /** The member has no stored forge token (never logged in, or logged out). */
  | "no_token"
  /** The stored token could not be decrypted (wrong key, tampered, no org key). */
  | "token_unreadable"
  /** No usable answer from the forge (timeout, network, 5xx, 429, other status). */
  | "forge_unavailable"
  /** The forge answered something that is not what was asked for. */
  | "invalid_response"
  /** Anything else that went wrong. */
  | "error";

export const ACCESS_DENY_REASONS: readonly AccessDenyReason[] = [
  "not_found",
  "no_read_permission",
  "token_rejected",
  "forbidden",
  "repository_mismatch",
  "token_user_mismatch",
  "not_collaborator",
  "invalid_request",
  "not_member",
  "unknown_repository",
  "no_token",
  "token_unreadable",
  "forge_unavailable",
  "invalid_response",
  "error",
];

/** Denies that say something about the world rather than about the moment. */
const TRANSIENT: ReadonlySet<AccessDenyReason> = new Set([
  "forbidden",
  "token_unreadable",
  "forge_unavailable",
  "invalid_response",
  "error",
]);

/** What a source answers. Anything else (or a throw) is a deny. */
export type RepositoryAccessAnswer =
  { readonly access: "read" } | { readonly access: "none"; readonly reason: AccessDenyReason };

/**
 * Asks the forge whether the member can read the repository, with the member's own credential.
 * Throws on any failure; must not return a cached answer of its own.
 */
export interface RepositoryAccessSource {
  readAccess(request: RepositoryAccessRequest): Promise<RepositoryAccessAnswer>;
}

export type AccessDecision =
  | {
      readonly allowed: true;
      /** Served from the cache (no forge call for this request). */
      readonly cached: boolean;
      /** When this allow stops being reused; at most 5 minutes after the forge was asked. */
      readonly expiresAt: Date;
    }
  | { readonly allowed: false; readonly reason: AccessDenyReason; readonly cached: boolean };

/** One decision, for logs and metrics: ids and fixed codes only. */
export interface AccessDecisionEvent {
  readonly orgId: string;
  readonly memberId: string;
  readonly repositoryId: number;
  readonly allowed: boolean;
  readonly reason: AccessDenyReason | null;
  readonly cached: boolean;
  /** This caller waited for another caller's forge question (one event per caller). */
  readonly joined: boolean;
}

/** A cache entry as `entries()` lists it: no credential is ever part of one. */
export interface AccessCacheEntry {
  readonly orgId: string;
  readonly memberId: string;
  readonly repositoryId: number;
  readonly allowed: boolean;
  readonly reason: AccessDenyReason | null;
  readonly checkedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Invalidation hooks must be called **after** the transaction that changed the token,
 * membership or repository has committed: called before, a concurrent check could read the old
 * row and cache it again. Each returns `true` when its ids were valid. Invalid ids fail closed:
 * an invalid member or repository id drops every entry of the org, an invalid org id clears the
 * whole cache (and `false` is returned so the caller's bug is visible in tests).
 */
export interface RepositoryAccessCheck {
  /** Allow or deny; never throws. */
  check(request: RepositoryAccessRequest): Promise<AccessDecision>;
  /** Login, logout, token refresh, role change or removal of one member. */
  invalidateMember(orgId: string, memberId: string): boolean;
  /** A repository left the installation, was transferred, renamed or made private. */
  invalidateRepository(orgId: string, repositoryId: number): boolean;
  /** The org was uninstalled, suspended or erased. */
  invalidateOrg(orgId: string): boolean;
  clear(): void;
  /** Current entries (diagnostics and tests). */
  entries(): AccessCacheEntry[];
  readonly size: number;
  /** Orgs with a stored invalidation generation (diagnostics and tests): ≤ `maxEntries`. */
  readonly generationTableSize: number;
}

export interface RepositoryAccessCheckOptions {
  readonly source: RepositoryAccessSource;
  readonly clock: Clock;
  /** How long an allow is reused; 1 ms … `ACCESS_MAX_TTL_MS` (default: the maximum). */
  readonly allowTtlMs?: number;
  readonly maxEntries?: number;
  /**
   * Called once per caller: a cache hit, the caller that asked the forge, and each caller that
   * joined that question (`joined: true`). A request rejected as `invalid_request` emits no event:
   * it has no ids that could be reported. Errors it throws are ignored.
   */
  readonly onDecision?: (event: AccessDecisionEvent) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS: ReadonlySet<string> = new Set(ACCESS_DENY_REASONS);

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

interface Entry {
  readonly orgId: string;
  readonly memberId: string;
  readonly repositoryId: number;
  readonly reason: AccessDenyReason | null;
  readonly checkedAt: number;
  readonly expiresAt: number;
}

/** Normalised ids (lower-case uuids) so one member never gets two entries. */
interface Key {
  readonly orgId: string;
  readonly memberId: string;
  readonly repositoryId: number;
  readonly text: string;
}

const keyOf = (request: RepositoryAccessRequest): Key | null => {
  // Read each field once: a getter cannot answer differently for validation and for the key.
  const { orgId, memberId, repositoryId } = request as unknown as Record<string, unknown>;
  if (!isUuid(orgId) || !isUuid(memberId) || !isId(repositoryId)) return null;
  const org = orgId.toLowerCase();
  const member = memberId.toLowerCase();
  // Uuids and integers contain no space, so the encoding is unambiguous.
  return {
    orgId: org,
    memberId: member,
    repositoryId,
    text: `${org} ${member} ${repositoryId}`,
  };
};

/** The answer's reason, or why the answer itself is a deny. */
const reasonOf = (answer: unknown): AccessDenyReason | null => {
  if (typeof answer !== "object" || answer === null) return "invalid_response";
  const { access, reason } = answer as Record<string, unknown>;
  if (access === "read" && Object.keys(answer).length === 1) return null;
  if (access === "none" && typeof reason === "string" && REASONS.has(reason)) {
    return reason as AccessDenyReason;
  }
  return "invalid_response";
};

const reasonOfError = (error: unknown): AccessDenyReason =>
  error instanceof ForgeReadError
    ? error.reason === "invalid_response"
      ? "invalid_response"
      : "forge_unavailable"
    : "error";

export const createRepositoryAccessCheck = (
  options: RepositoryAccessCheckOptions,
): RepositoryAccessCheck => {
  const allowTtlMs = options.allowTtlMs ?? ACCESS_MAX_TTL_MS;
  if (!Number.isSafeInteger(allowTtlMs) || allowTtlMs < 1 || allowTtlMs > ACCESS_MAX_TTL_MS) {
    throw new Error("repository access: allowTtlMs must be 1 ms … 5 minutes");
  }
  const maxEntries = options.maxEntries ?? DEFAULT_ACCESS_CACHE_ENTRIES;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_ACCESS_CACHE_ENTRIES
  ) {
    throw new Error("repository access: maxEntries out of range");
  }
  const { source, clock } = options;

  /** Insertion order = recency: the first key is the least recently used. */
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<AccessDecision>>();
  /**
   * Invalidation generations: `clear()` (and an invalid org id) bumps the global one, any other
   * invalidation only its org's. A check writes its answer only if neither changed since it
   * started, so an invalidation in one org never stops another org's checks from caching.
   */
  let globalGeneration = 0;
  const orgGenerations = new Map<string, number>();
  const generationOf = (orgId: string): string =>
    `${globalGeneration}:${orgGenerations.get(orgId) ?? 0}`;
  const bumpOrg = (orgId: string): void => {
    // Bounded like the cache: past the bound, a global bump is the safe way to forget.
    if (!orgGenerations.has(orgId) && orgGenerations.size >= maxEntries) {
      orgGenerations.clear();
      globalGeneration++;
    }
    orgGenerations.set(orgId, (orgGenerations.get(orgId) ?? 0) + 1);
  };

  const now = (): number => {
    const value = clock.now().getTime();
    // A clock that cannot be read is a deny path: NaN fails every freshness comparison below.
    return Number.isFinite(value) ? value : Number.NaN;
  };

  const emit = (
    key: Key,
    reason: AccessDenyReason | null,
    cached: boolean,
    joined = false,
  ): void => {
    try {
      options.onDecision?.({
        orgId: key.orgId,
        memberId: key.memberId,
        repositoryId: key.repositoryId,
        allowed: reason === null,
        reason,
        cached,
        joined,
      });
    } catch {
      // An observer never changes a decision.
    }
  };

  const decision = (entry: Entry, key: Key, cached: boolean): AccessDecision => {
    emit(key, entry.reason, cached);
    return entry.reason === null
      ? { allowed: true, cached, expiresAt: new Date(entry.expiresAt) }
      : { allowed: false, reason: entry.reason, cached };
  };

  const deny = (key: Key, reason: AccessDenyReason): AccessDecision => {
    emit(key, reason, false);
    return { allowed: false, reason, cached: false };
  };

  /** Fresh only inside [checkedAt, expiresAt): a clock that went backwards is not fresh. */
  const fresh = (entry: Entry, at: number): boolean =>
    at >= entry.checkedAt && at < entry.expiresAt;

  const store = (key: Key, entry: Entry): void => {
    entries.delete(key.text);
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    entries.set(key.text, entry);
  };

  const ask = async (key: Key): Promise<AccessDecision> => {
    const startedGeneration = generationOf(key.orgId);
    // Expiry counts from before the question: the answer describes the forge at or after this.
    const checkedAt = now();
    if (Number.isNaN(checkedAt)) return deny(key, "error");
    let reason: AccessDenyReason | null;
    try {
      reason = reasonOf(
        await source.readAccess({
          orgId: key.orgId as OrgId,
          memberId: key.memberId,
          repositoryId: key.repositoryId,
        }),
      );
    } catch (error) {
      reason = reasonOfError(error);
    }
    const ttl =
      reason === null ? allowTtlMs : TRANSIENT.has(reason) ? TRANSIENT_DENY_TTL_MS : DENY_TTL_MS;
    const entry: Entry = { ...key, reason, checkedAt, expiresAt: checkedAt + ttl };
    // An answer that took longer than its own lifetime is not an allow.
    if (!fresh(entry, now())) return deny(key, reason ?? "forge_unavailable");
    if (generationOf(key.orgId) === startedGeneration) store(key, entry);
    return decision(entry, key, false);
  };

  const check = async (request: RepositoryAccessRequest): Promise<AccessDecision> => {
    let key: Key | null;
    try {
      key = typeof request === "object" && request !== null ? keyOf(request) : null;
    } catch {
      key = null;
    }
    if (key === null) return { allowed: false, reason: "invalid_request", cached: false };
    try {
      const hit = entries.get(key.text);
      if (hit !== undefined) {
        entries.delete(key.text);
        if (fresh(hit, now())) {
          entries.set(key.text, hit);
          return decision(hit, key, true);
        }
      }
      const running = inflight.get(key.text);
      if (running !== undefined) {
        const joined = await running;
        emit(key, joined.allowed ? null : joined.reason, false, true);
        return joined;
      }
      const flight = ask(key);
      inflight.set(key.text, flight);
      try {
        return await flight;
      } finally {
        if (inflight.get(key.text) === flight) inflight.delete(key.text);
      }
    } catch {
      return deny(key, "error");
    }
  };

  type Match = (entry: Pick<Entry, "orgId" | "memberId" | "repositoryId">) => boolean;

  const drop = (match: Match): void => {
    for (const [text, entry] of entries) if (match(entry)) entries.delete(text);
    for (const text of inflight.keys()) {
      const [orgId = "", memberId = "", repositoryId = ""] = text.split(" ");
      if (match({ orgId, memberId, repositoryId: Number(repositoryId) })) inflight.delete(text);
    }
  };

  const clearAll = (): void => {
    globalGeneration++;
    orgGenerations.clear();
    drop(() => true);
  };

  /** Invalidates within one (valid) org; `false` after dropping the whole org. */
  const invalidateIn = (orgId: unknown, match: Match | null): boolean => {
    if (!isUuid(orgId)) {
      clearAll();
      return false;
    }
    const org = orgId.toLowerCase();
    bumpOrg(org);
    drop((e) => e.orgId === org && (match === null || match(e)));
    return true;
  };

  return {
    check,
    invalidateMember: (orgId, memberId) => {
      if (!isUuid(memberId)) return invalidateIn(orgId, null) && false;
      const member = memberId.toLowerCase();
      return invalidateIn(orgId, (e) => e.memberId === member);
    },
    invalidateRepository: (orgId, repositoryId) => {
      if (!isId(repositoryId)) return invalidateIn(orgId, null) && false;
      return invalidateIn(orgId, (e) => e.repositoryId === repositoryId);
    },
    invalidateOrg: (orgId) => invalidateIn(orgId, null),
    clear: clearAll,
    entries: () =>
      [...entries.values()].map((e) => ({
        orgId: e.orgId,
        memberId: e.memberId,
        repositoryId: e.repositoryId,
        allowed: e.reason === null,
        reason: e.reason,
        checkedAt: new Date(e.checkedAt),
        expiresAt: new Date(e.expiresAt),
      })),
    get size() {
      return entries.size;
    },
    get generationTableSize() {
      return orgGenerations.size;
    },
  };
};
