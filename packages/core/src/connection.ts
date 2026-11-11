import { z } from "zod";
import { RepoName, RepoOwner } from "@rocky-reviews/schema";

/**
 * The token connection's API (P10-4, ADR 0045): what a self-hosted Rocky connected with a
 * personal access token instead of the GitHub App exchanges with its web app. Everything here is
 * fixed codes, counts, times and GitHub's own names (the token owner's login, repository names),
 * rendered as text. The token itself never appears in any answer: a saved token is described by
 * its kind, its owner and its expiry only. Both sides validate against these schemas.
 */

const Count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be a uuid");
/** A GitHub user login as `GET /user` returns it (display only; identity is the numeric id). */
const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** How Rocky is connected to GitHub: the App (the recommended path) or one person's token. */
export const CONNECTION_KINDS = ["app", "token"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/**
 * GitHub's two kinds of personal access token. Fine-grained tokens name the repositories and the
 * permissions they carry; classic tokens carry scopes over everything the person can reach,
 * which is why Rocky warns about them.
 */
export const GITHUB_TOKEN_KINDS = ["fine_grained", "classic"] as const;
export type GitHubTokenKind = (typeof GITHUB_TOKEN_KINDS)[number];

/** Things worth saying about a token that still works. Fixed codes; the page has the text. */
export const TOKEN_WARNINGS = ["classic_token", "no_expiry", "expires_soon"] as const;
export type TokenWarning = (typeof TOKEN_WARNINGS)[number];

/** A token the person should replace soon: GitHub's expiry is within this many days. */
export const TOKEN_EXPIRES_SOON_DAYS = 14;

/**
 * The shape a personal access token has (GitHub issues `github_pat_…` fine-grained tokens and
 * `ghp_…` classic ones; the rest is opaque). Anything else is refused before any request: an
 * OAuth token (`gho_`), an installation token (`ghs_`), a user-to-server token (`ghu_`) or free
 * text is not a personal token. Printable ASCII, bounded.
 */
const FINE_GRAINED = /^github_pat_[A-Za-z0-9_]{20,500}$/;
const CLASSIC = /^ghp_[A-Za-z0-9]{20,500}$/;

export const personalTokenKind = (value: unknown): GitHubTokenKind | null => {
  if (typeof value !== "string" || value.length > 512) return null;
  if (FINE_GRAINED.test(value)) return "fine_grained";
  if (CLASSIC.test(value)) return "classic";
  return null;
};

/** A saved token, described without its value. */
export const ConnectionToken = z.strictObject({
  login: Login,
  forgeUserId: ForgeId,
  kind: z.enum(GITHUB_TOKEN_KINDS),
  /** GitHub's expiry for the token, when it has one. */
  expiresAt: z.iso.datetime().nullable(),
  savedAt: z.iso.datetime(),
  warnings: z.array(z.enum(TOKEN_WARNINGS)).max(TOKEN_WARNINGS.length),
});
export type ConnectionToken = z.infer<typeof ConnectionToken>;

/** Why a token was not saved. Fixed codes: safe to log and to show. */
export const TOKEN_SAVE_REFUSALS = [
  /** Not a personal access token (shape), or longer than GitHub issues. */
  "not_a_personal_token",
  /** GitHub answered 401: revoked, expired or mistyped. */
  "token_rejected",
  /** GitHub answered 403 (SSO not authorised for the token, an IP allow list). */
  "forbidden",
  /** A classic token without the `repo` or `public_repo` scope: it can read no repository. */
  "missing_permissions",
  /** GitHub's rate limit for this token is exhausted. */
  "rate_limited",
  /** The token belongs to another GitHub user than the one connected (replacing a token). */
  "token_user_mismatch",
  /** GitHub could not be reached or did not answer as asked. */
  "forge_unavailable",
  /** Token mode is not on for this server. */
  "token_mode_off",
] as const;
export type TokenSaveRefusal = (typeof TOKEN_SAVE_REFUSALS)[number];

export const SaveTokenRequest = z.strictObject({
  /** The token as pasted; validated by `personalTokenKind` before anything else. */
  token: z.string().min(1).max(512),
});
export type SaveTokenRequest = z.infer<typeof SaveTokenRequest>;

export const SaveTokenResponse = z.strictObject({ token: ConnectionToken });
export type SaveTokenResponse = z.infer<typeof SaveTokenResponse>;

/** One repository Rocky follows on the token (the mirror's row). */
export const ConnectionRepository = z.strictObject({
  id: Uuid,
  forgeRepoId: ForgeId,
  owner: RepoOwner,
  name: RepoName,
  private: z.boolean(),
  openPullRequests: Count,
  lastSyncedAt: z.iso.datetime().nullable(),
});
export type ConnectionRepository = z.infer<typeof ConnectionRepository>;

/** Repositories one listing (and one sync) covers at most. */
export const MAX_CONNECTION_REPOSITORIES = 200;

export const ConnectionResponse = z.strictObject({
  connection: z.literal("token"),
  token: ConnectionToken.nullable(),
  repositories: z.array(ConnectionRepository).max(MAX_CONNECTION_REPOSITORIES),
  /** The latest sync of any repository; `null` before the first. */
  lastSyncedAt: z.iso.datetime().nullable(),
  /** `ROCKY_ANALYSIS_AUTO=on`: a sync queues an analysis of every new head it reads. */
  analysisAuto: z.boolean(),
});
export type ConnectionResponse = z.infer<typeof ConnectionResponse>;

/** A repository the token can see, as GitHub lists it: enough to pick one. */
export const AvailableRepository = z.strictObject({
  forgeRepoId: ForgeId,
  owner: RepoOwner,
  name: RepoName,
  private: z.boolean(),
  /** Already followed by Rocky. */
  added: z.boolean(),
});
export type AvailableRepository = z.infer<typeof AvailableRepository>;

/** Repositories `GET /user/repos` is read for, at most (pages of 100). */
export const MAX_AVAILABLE_REPOSITORIES = 500;

export const AvailableRepositoriesResponse = z.strictObject({
  repositories: z.array(AvailableRepository).max(MAX_AVAILABLE_REPOSITORIES),
  /** The token can see more than were listed. */
  truncated: z.boolean(),
});
export type AvailableRepositoriesResponse = z.infer<typeof AvailableRepositoriesResponse>;

export const AddRepositoryRequest = z.strictObject({ forgeRepoId: ForgeId });
export type AddRepositoryRequest = z.infer<typeof AddRepositoryRequest>;

/** Why a sync, or an add, did not read from GitHub. Fixed codes. */
export const SYNC_PROBLEMS = [
  "no_token",
  "token_rejected",
  "forbidden",
  "rate_limited",
  /** GitHub says the repository is gone or no longer visible to the token. */
  "repository_not_found",
  "forge_unavailable",
  /** Another sync of this org is running. */
  "busy",
  "failed",
] as const;
export type SyncProblem = (typeof SYNC_PROBLEMS)[number];

/** What one repository's sync did. Counts only. */
export const RepositorySyncReport = z.strictObject({
  id: Uuid,
  /** Pull requests GitHub listed (up to the per-sync limit). */
  listed: Count,
  /** Created or refreshed from GitHub's answer. */
  mirrored: Count,
  /** Already current: not read again. */
  unchanged: Count,
  /** Analyses queued by this sync (`ROCKY_ANALYSIS_AUTO=on`). */
  analysesQueued: Count,
  problem: z.enum(SYNC_PROBLEMS).nullable(),
});
export type RepositorySyncReport = z.infer<typeof RepositorySyncReport>;

export const SyncResponse = z.strictObject({
  /** `synced` when every repository was read; otherwise the first problem met. */
  outcome: z.enum(["synced", ...SYNC_PROBLEMS]),
  /** When GitHub's rate limit resets, for `rate_limited`. */
  retryAt: z.iso.datetime().nullable(),
  syncedAt: z.iso.datetime().nullable(),
  repositories: z.array(RepositorySyncReport).max(MAX_CONNECTION_REPOSITORIES),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

export const AddRepositoryResponse = z.strictObject({
  repository: ConnectionRepository,
  sync: SyncResponse,
});
export type AddRepositoryResponse = z.infer<typeof AddRepositoryResponse>;

/** Fixed codes an add may refuse with. */
export const ADD_REPOSITORY_REFUSALS = [
  "no_token",
  "token_rejected",
  "forbidden",
  "rate_limited",
  /** The token cannot see this repository (or it does not exist). */
  "repository_not_found",
  /** The token can see it but cannot read its contents. */
  "no_read_permission",
  "forge_unavailable",
  "too_many_repositories",
] as const;
export type AddRepositoryRefusal = (typeof ADD_REPOSITORY_REFUSALS)[number];

/**
 * What opening the inbox did about the sync in token mode (P10-4). `synced`: a sync ran and read
 * every repository; `running`: one is still running (it continues; the page asks again shortly);
 * `skipped`: one ran within the last minute, so the mirror is fresh enough; `failed`: it stopped
 * with `problem` (and, for a rate limit, `retryAt`).
 */
export const INBOX_SYNC_STATES = ["synced", "running", "skipped", "failed"] as const;
export type InboxSyncState = (typeof INBOX_SYNC_STATES)[number];

export const InboxSync = z
  .strictObject({
    state: z.enum(INBOX_SYNC_STATES),
    /** The latest sync of any followed repository; `null` before the first. */
    lastSyncedAt: z.iso.datetime().nullable(),
    problem: z.enum(SYNC_PROBLEMS).nullable(),
    retryAt: z.iso.datetime().nullable(),
  })
  .refine((s) => (s.state === "failed") === (s.problem !== null), "problem only when failed");
export type InboxSync = z.infer<typeof InboxSync>;

/** Every fixed code a connection route refuses with. */
export const CONNECTION_ERRORS = [
  ...new Set([
    ...TOKEN_SAVE_REFUSALS,
    ...ADD_REPOSITORY_REFUSALS,
    "invalid_request",
    "not_found",
    "internal",
  ] as const),
];
export type ConnectionError =
  TokenSaveRefusal | AddRepositoryRefusal | "invalid_request" | "not_found" | "internal";

/** A refused connection request: a fixed code and, for a rate limit, when to try again. */
export const ConnectionErrorResponse = z.strictObject({
  error: z.enum(CONNECTION_ERRORS as [ConnectionError, ...ConnectionError[]]),
  retryAt: z.iso.datetime().nullable(),
});
export type ConnectionErrorResponse = z.infer<typeof ConnectionErrorResponse>;

/**
 * How a signed-out browser signs in (`GET /api/session`'s 401 answer): `github` through the
 * GitHub App's login, `token_link` through the one-time link the server prints at boot.
 */
export const SIGN_IN_METHODS = ["github", "token_link"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/** The warnings a token deserves, from what GitHub said about it. */
export const tokenWarnings = (
  token: { readonly kind: GitHubTokenKind; readonly expiresAt: Date | null },
  now: Date,
): TokenWarning[] => {
  const warnings: TokenWarning[] = [];
  if (token.kind === "classic") warnings.push("classic_token");
  if (token.expiresAt === null) warnings.push("no_expiry");
  else if (token.expiresAt.getTime() - now.getTime() < TOKEN_EXPIRES_SOON_DAYS * 86_400_000) {
    warnings.push("expires_soon");
  }
  return warnings;
};
