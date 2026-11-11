/**
 * What the token connection's pages say (P10-4, ADR 0045): fixed text per code, so nothing the
 * server sends is shown as markup. Logins and repository names from GitHub are shown as text.
 * The token itself is never part of any of this: a saved token is its kind, owner and expiry.
 */
import type {
  AddRepositoryRefusal,
  GitHubTokenKind,
  InboxSync,
  SyncProblem,
  SyncResponse,
  TokenWarning,
} from "@rocky-reviews/core";

export const TOKEN_KIND_LABEL: Readonly<Record<GitHubTokenKind, string>> = {
  fine_grained: "Fine-grained",
  classic: "Classic",
};

export const TOKEN_WARNING_LABEL: Readonly<Record<TokenWarning, string>> = {
  classic_token: "Classic token",
  no_expiry: "Never expires",
  expires_soon: "Expires soon",
};

export const TOKEN_WARNING_TEXT: Readonly<Record<TokenWarning, string>> = {
  classic_token:
    "A classic token reaches every repository you can. A fine-grained token limited to the repositories Rocky reviews is safer.",
  no_expiry: "This token never expires. Give the next one an expiry date.",
  expires_soon: "This token expires within two weeks. Create a new one and replace it here.",
};

/** A time of day in the viewer's own time zone ("14:05"); fixed text for a bad value. */
export const localTime = (iso: string | null): string => {
  if (iso === null) return "later";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "later";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** A calendar date in the viewer's locale ("12 Feb 2027"). */
export const localDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "an unknown date";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
};

const RATE_LIMITED = (retryAt: string | null) =>
  `GitHub's rate limit for this token is used up. Try again after ${localTime(retryAt)}.`;

const TOKEN_REFUSAL: Readonly<Record<string, string>> = {
  not_a_personal_token: "This is not a personal access token (github_pat_… or ghp_…).",
  token_rejected: "GitHub did not accept this token: it may be mistyped, expired or revoked.",
  forbidden:
    "GitHub refused this token's requests (single sign-on not authorised for it, or an IP allow list).",
  missing_permissions:
    "This classic token has no repository scope (repo or public_repo). Create a fine-grained token instead, or add the repo scope.",
  token_user_mismatch:
    "This token belongs to another GitHub user than the one Rocky is connected to.",
  forge_unavailable: "GitHub could not be reached. Try again in a minute.",
  token_mode_off: "This server is not in token mode (ROCKY_GITHUB_CONNECTION=token).",
  invalid_request: "Paste a token first.",
};

/** Why a token was not saved, by the server's fixed code; unknown codes are named, not echoed. */
export const tokenRefusalText = (code: string, retryAt: string | null): string =>
  code === "rate_limited"
    ? RATE_LIMITED(retryAt)
    : (TOKEN_REFUSAL[code] ?? `Rocky could not save this token (${safeCode(code)}).`);

const SYNC_PROBLEM: Readonly<Record<SyncProblem, string>> = {
  no_token: "No token is saved, so Rocky cannot read GitHub.",
  token_rejected: "GitHub no longer accepts the token: it may have expired or been revoked.",
  forbidden: "GitHub refused the token's requests (single sign-on or an IP allow list).",
  rate_limited: "",
  repository_not_found: "A repository is gone, or the token can no longer see it.",
  forge_unavailable: "GitHub could not be reached. Try again in a minute.",
  busy: "A sync is already running.",
  failed: "The sync failed. Try again.",
};

export const syncProblemText = (problem: SyncProblem, retryAt: string | null): string =>
  problem === "rate_limited" ? RATE_LIMITED(retryAt) : SYNC_PROBLEM[problem];

/** Problems the person fixes by saving a new token: the page links to that. */
export const needsNewToken = (problem: string | null): boolean =>
  problem === "token_rejected" || problem === "no_token" || problem === "forbidden";

const ADD_REFUSAL: Readonly<Record<AddRepositoryRefusal, string>> = {
  no_token: "Save a token first.",
  token_rejected: SYNC_PROBLEM.token_rejected,
  forbidden: SYNC_PROBLEM.forbidden,
  rate_limited: "",
  repository_not_found: "The token cannot see this repository any more.",
  no_read_permission:
    "The token can see this repository but cannot read its contents. Give it Contents: Read.",
  forge_unavailable: SYNC_PROBLEM.forge_unavailable,
  too_many_repositories: "Rocky follows as many repositories as it can on one token.",
};

export const addRefusalText = (code: string, retryAt: string | null): string =>
  code === "rate_limited"
    ? RATE_LIMITED(retryAt)
    : (ADD_REFUSAL[code as AddRepositoryRefusal] ??
      `The repository could not be added (${safeCode(code)}).`);

/** A code from the server is a fixed enum after validation; this keeps it so if it is not. */
const safeCode = (code: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "error");

const n = (count: number, one: string, many: string) => `${count}\u00a0${count === 1 ? one : many}`;

/** A sync that goes on after the request's wait (the server answers `running`). */
export const SYNC_RUNNING_TEXT =
  "Rocky is reading GitHub in the background; the page updates when it is done.";

/** One line about what a sync read (counts only). */
export const syncReportText = (sync: SyncResponse): string => {
  if (sync.outcome === "running") return SYNC_RUNNING_TEXT;
  if (sync.outcome !== "synced") return syncProblemText(sync.outcome, sync.retryAt);
  const listed = sync.repositories.reduce((sum, r) => sum + r.listed, 0);
  const mirrored = sync.repositories.reduce((sum, r) => sum + r.mirrored, 0);
  const queued = sync.repositories.reduce((sum, r) => sum + r.analysesQueued, 0);
  return `Synced: ${n(listed, "open pull request", "open pull requests")}, ${mirrored}\u00a0updated${
    queued > 0 ? `, ${n(queued, "analysis", "analyses")} queued` : ""
  }.`;
};

/** What the inbox's sync bar shows. */
export type SyncBar =
  | { readonly kind: "running" }
  | { readonly kind: "idle" }
  | {
      readonly kind: "problem";
      readonly text: string;
      /** The fix is a new token: link to the connection page. */
      readonly replaceToken: boolean;
    };

export const syncBar = (sync: InboxSync): SyncBar =>
  sync.state === "running"
    ? { kind: "running" }
    : sync.problem !== null
      ? {
          kind: "problem",
          text: syncProblemText(sync.problem, sync.retryAt),
          replaceToken: needsNewToken(sync.problem),
        }
      : { kind: "idle" };

/** While a sync runs, the inbox asks again this often, at most `SYNC_POLL_LIMIT` times. */
export const SYNC_POLL_MS = 3_000;
export const SYNC_POLL_LIMIT = 10;

/**
 * Reads a token out of its field and empties the field at once, so it is never shown again and
 * never kept in the page's state. `null` when the field is empty.
 */
export const takeToken = (field: { value: string } | null): string | null => {
  if (field === null) return null;
  const token = field.value.trim();
  field.value = "";
  return token === "" ? null : token;
};
