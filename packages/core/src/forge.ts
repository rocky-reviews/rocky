/**
 * Forge port (P3-7): what the domain needs from a code host, in forge-neutral terms. GitHub is
 * the first adapter (`packages/forge-github`); GitLab and Gitea implement the same interfaces.
 * Nothing here names a vendor SDK, a vendor header or a vendor payload shape.
 *
 * Two halves:
 * - inbound: `WebhookIngress` authenticates and decodes one webhook delivery into a minimal
 *   `ForgeEvent`; `WebhookInbox` stores it durably, once per delivery (ADR 0007);
 * - outbound: `Forge` reads installations and pull requests (implemented in P3-3/P3-4).
 *
 * Event content is untrusted. Consumers treat a `ForgeEvent` as a hint to re-read state from the
 * forge (the source of truth), never as proof of that state.
 */

export type ForgeKind = "github" | "gitlab" | "gitea";

/** A forge-side numeric id (installation, account, repository). Positive safe integer. */
export type ForgeNumericId = number;

export type ForgeAccountKind = "organization" | "user";

export interface ForgeAccount {
  readonly id: ForgeNumericId;
  readonly login: string;
  readonly kind: ForgeAccountKind;
}

export interface RepositoryRef {
  readonly installationId: ForgeNumericId;
  readonly repositoryId: ForgeNumericId;
}

export interface PullRequestRef extends RepositoryRef {
  readonly number: number;
}

// --- Webhook events ----------------------------------------------------------------------------

export const INSTALLATION_EVENT_TYPES = ["installation.created", "installation.deleted"] as const;
export const PULL_REQUEST_EVENT_TYPES = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.closed",
  "pull_request.reopened",
] as const;
/** Every event the domain consumes. Anything else a forge sends is acknowledged and ignored. */
export const FORGE_EVENT_TYPES = [
  ...INSTALLATION_EVENT_TYPES,
  ...PULL_REQUEST_EVENT_TYPES,
] as const;

export type InstallationEventType = (typeof INSTALLATION_EVENT_TYPES)[number];
export type PullRequestEventType = (typeof PULL_REQUEST_EVENT_TYPES)[number];
export type ForgeEventType = (typeof FORGE_EVENT_TYPES)[number];

/** The forge user who triggered an event (for installations: who installed or removed the app). */
export interface ForgeActor {
  readonly id: ForgeNumericId;
  readonly login: string;
}

/** App installed on / removed from an account (P3-3 creates or schedules deletion of the org). */
export interface InstallationEvent {
  readonly type: InstallationEventType;
  readonly installationId: ForgeNumericId;
  readonly account: ForgeAccount;
  /**
   * Who installed or uninstalled the app. Recorded at receipt because the forge cannot be asked
   * later (P3-3 uses it for the first admin and the audit trail). Untrusted: P3-3 re-checks it.
   * `null` when the forge sent no usable actor (missing, unexpected shape, a system action): the
   * installation change itself must never be lost over who made it.
   */
  readonly sender: ForgeActor | null;
}

/** A pull request changed (P3-4 re-reads it from the forge and updates the mirror). */
export interface PullRequestEvent extends PullRequestRef {
  readonly type: PullRequestEventType;
  /** Head commit at the time of the event: lets a consumer skip a stale delivery. */
  readonly headSha: string;
  /** Only meaningful for `pull_request.closed`; false otherwise. */
  readonly merged: boolean;
}

export type ForgeEvent = InstallationEvent | PullRequestEvent;

const EVENT_TYPES: ReadonlySet<string> = new Set(FORGE_EVENT_TYPES);

export const isForgeEventType = (value: unknown): value is ForgeEventType =>
  typeof value === "string" && EVENT_TYPES.has(value);

export const isInstallationEvent = (event: ForgeEvent): event is InstallationEvent =>
  event.type === "installation.created" || event.type === "installation.deleted";

const PULL_REQUEST_TYPES: ReadonlySet<string> = new Set(PULL_REQUEST_EVENT_TYPES);

export const isPullRequestEvent = (event: ForgeEvent): event is PullRequestEvent =>
  PULL_REQUEST_TYPES.has(event.type);

// --- Inbound: webhook deliveries ---------------------------------------------------------------

/** One authenticated delivery, reduced to what the domain needs. */
export interface WebhookDelivery {
  readonly forge: ForgeKind;
  /** The forge's delivery id (a uuid), lower-cased. The idempotency key of the delivery. */
  readonly deliveryId: string;
  /** sha256 of the raw body, lower-case hex: the same signed body is one delivery (replay). */
  readonly payloadSha256: string;
  readonly event: ForgeEvent;
}

/** Why a delivery was not accepted. Fixed codes: safe to log and to return. */
export type WebhookRejection =
  /** Missing, malformed or wrong signature / token. Nothing else about the request is trusted. */
  | "unauthenticated"
  /** Authenticated, but a required header (delivery id, event name) is missing or malformed. */
  | "bad_headers"
  /** Authenticated, but the body is not the media type the receiver accepts. */
  | "unsupported_media_type"
  /** Authenticated, but the body is not JSON or does not have the shape of the event. */
  | "bad_payload";

/** Why an authenticated event the domain would otherwise consume is ignored. Safe to log. */
export type WebhookIgnoreReason =
  /** Installed on an account kind the domain does not model (e.g. an enterprise). */
  "unsupported_account_type";

export type WebhookReceipt =
  | { readonly outcome: "rejected"; readonly reason: WebhookRejection }
  /** The forge's connectivity check. */
  | { readonly outcome: "ping"; readonly deliveryId: string }
  /** Authenticated, but not an event or action the domain consumes. */
  | {
      readonly outcome: "ignored";
      readonly deliveryId: string;
      readonly eventName: string;
      /** Set when a consumed event/action is ignored for a specific reason. Fixed codes. */
      readonly reason?: WebhookIgnoreReason;
    }
  | { readonly outcome: "accepted"; readonly delivery: WebhookDelivery };

export interface WebhookRequest {
  /** Header lookup by lower-case name; a repeated header must come back as `undefined`. */
  header(name: string): string | undefined;
  /** The raw body bytes exactly as received: authentication covers these, not a re-encoding. */
  readonly body: Uint8Array;
}

/**
 * Authenticates and decodes one webhook request. Must authenticate the raw body before parsing
 * it, must not throw on any input, and must not do I/O (it runs in the request path).
 */
export interface WebhookIngress {
  readonly forge: ForgeKind;
  /**
   * Header-shape checks only, run before the body is read so an obviously bad request costs no
   * buffering: a missing or malformed signature header, malformed delivery or event headers, a
   * non-accepted media type. No secret is involved. Returns the rejection `receive` would give
   * for the same headers, or `undefined` to go on. Must not throw.
   */
  precheck(header: WebhookRequest["header"]): WebhookRejection | undefined;
  receive(request: WebhookRequest): WebhookReceipt;
}

/**
 * Durable, deduplicated hand-off from the receiver to the worker (ADR 0007). `queued` means this
 * call stored the delivery; `duplicate` means the same delivery id, or the same body, was stored
 * before. Exactly one concurrent call for a delivery gets `queued`.
 */
export interface WebhookInbox {
  record(delivery: WebhookDelivery): Promise<"queued" | "duplicate">;
}

// --- Outbound: reading from the forge (P3-3 installations, P3-4 pull requests) -----------------

export interface ForgeInstallation {
  readonly id: ForgeNumericId;
  readonly account: ForgeAccount;
  /**
   * Suspended by the account owner (or the forge). Not the same as deleted: the installation and
   * its org stay, nothing is scheduled for deletion; reads on its behalf fail until unsuspended.
   */
  readonly suspended: boolean;
}

export type ForgePullRequestState = "open" | "closed" | "merged";

/** A repository as the forge describes it now. Display fields are untrusted and may change. */
export interface ForgeRepository {
  readonly id: ForgeNumericId;
  /** `owner/name`; display only (repositories are renamed and transferred). */
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

/**
 * A pull request as the forge describes it now (P3-4 mirrors it). `title` and `authorLogin` are
 * untrusted text from the PR's author: stored verbatim, never logged, never trusted in prompts.
 */
export interface ForgePullRequest {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly authorLogin: string | null;
  readonly state: ForgePullRequestState;
  readonly headSha: string;
  readonly baseSha: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  /** The forge's last-modified time: a newer snapshot never loses to an older one. */
  readonly updatedAt: Date;
  /** Known fields from the forge (P1-4), never from a model. */
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
}

/** What a listing returns per pull request: enough to tell whether the mirror is current. */
export interface ForgePullRequestSummary {
  readonly number: number;
  readonly headSha: string;
  readonly updatedAt: Date;
}

/** One revision of a pull request: the diff between these two commits (merge-base semantics). */
export interface RevisionRef {
  readonly baseSha: string;
  readonly headSha: string;
}

/**
 * Why a diff is not complete:
 * - `max_bytes`: longer than the reader's byte cap; `text` holds a prefix, cut at a line end;
 * - `forge_limit`: the forge refuses to render a diff this large; `text` is empty;
 * - `unavailable`: the forge has no diff for these commits (gone after a force-push); empty.
 */
export type DiffTruncation = "max_bytes" | "forge_limit" | "unavailable";

export interface ForgeDiff {
  /** Unified diff text, cut at `maxBytes`. Untrusted content: never logged. */
  readonly text: string;
  /** True when `text` is not the whole diff (`truncation` says why). */
  readonly truncated: boolean;
  readonly truncation: DiffTruncation | null;
}

/** Why a read from the forge failed. Fixed codes: safe to log and to store as an inbox error. */
export type ForgeReadFailure =
  /** No answer in time. Retry later. */
  | "timeout"
  /** Connection-level failure (DNS, TLS, reset). Retry later. */
  | "network"
  /** An HTTP status other than the documented ones (`status` set). Retry later. */
  | "http_status"
  /** A response that is not what was asked for (shape, size, ids that do not match). */
  | "invalid_response"
  /** The installation is on an account kind the domain does not model (e.g. an enterprise). */
  | "unsupported_account_type"
  /** The installation is suspended: the forge refuses reads on its behalf until unsuspended. */
  | "installation_suspended"
  /** The configured credentials authenticate a different app than the configured app id. */
  | "app_mismatch";

/**
 * A failed forge read. Carries a fixed reason and at most an HTTP status: never a body, a token
 * or a URL. A consumer must not treat it as "not found" (that is `null`), or it would act on an
 * outage: an uninstall is only believed when the forge positively says 404.
 */
export class ForgeReadError extends Error {
  override readonly name = "ForgeReadError";
  constructor(
    readonly reason: ForgeReadFailure,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `forge read failed: ${reason}`
        : `forge read failed: ${reason} ${status}`,
    );
  }

  /**
   * An outage rather than a bad answer (review round 1, S3): no answer, a server error, rate
   * limiting, or credentials GitHub does not accept right now (401/403, a key for another app).
   * Retried without counting against the row; everything else is a property of the answer.
   */
  get transient(): boolean {
    if (this.reason === "timeout" || this.reason === "network" || this.reason === "app_mismatch") {
      return true;
    }
    if (this.reason !== "http_status" || this.status === undefined) return false;
    return this.status === 401 || this.status === 403 || this.status === 429 || this.status >= 500;
  }

  /** `forge_<reason>` or `forge_http_<status>`: the inbox's `last_error` and log field. */
  get code(): string {
    return this.reason === "http_status" && this.status !== undefined
      ? `forge_http_${this.status}`
      : `forge_${this.reason}`;
  }
}

/**
 * The read the installation lifecycle needs (P3-3): authenticated as the app itself, not as an
 * installation, because it must also work for an installation that no longer exists.
 */
export interface InstallationReader {
  readonly kind: ForgeKind;
  /**
   * `null` only when the forge positively says the installation does not exist (uninstalled);
   * any other failure throws `ForgeReadError`. Consumers verify events here (ADR 0007 §4).
   */
  getInstallation(installationId: ForgeNumericId): Promise<ForgeInstallation | null>;
  /**
   * Proves the configured credentials belong to the configured app (review round 1, M2). Throws
   * `ForgeReadError` (`app_mismatch`, or any read failure) otherwise. A worker must not act on
   * installation answers until this passed: another app's key would make every one of this
   * app's installations look uninstalled.
   */
  verifyApp(): Promise<void>;
}

/**
 * Read access to one repository on behalf of its installation (P3-4, ADR 0010). The adapter
 * holds a short-lived credential scoped to this repository and read-only permissions; it never
 * leaves the session. `close` revokes it; a session must be closed when the work is done.
 */
export interface RepositorySession {
  /** The repository as the forge described it when the session opened. */
  readonly repository: ForgeRepository;
  /** `null` only when the forge positively says there is no such pull request. */
  getPullRequest(number: number): Promise<ForgePullRequest | null>;
  /** Every pull request of the repository, any state, most recently updated first. */
  listPullRequests(): AsyncIterable<ForgePullRequestSummary>;
  /** The diff of one revision, read up to `maxBytes`. */
  getDiff(revision: RevisionRef, options: { readonly maxBytes: number }): Promise<ForgeDiff>;
  /** Revokes the credential (best effort) and refuses further reads. Idempotent. */
  close(): Promise<void>;
}

/**
 * Read access to one forge (P3-3, P3-4). Grows with the tasks that need it (posting reviews
 * P3-5, access checks P3-6).
 */
export interface Forge extends InstallationReader {
  /**
   * Opens a session on one repository of an installation. `null` when the forge positively says
   * the installation is gone or the repository is not one it can access; any other failure
   * throws `ForgeReadError`.
   */
  openRepository(ref: RepositoryRef): Promise<RepositorySession | null>;
  /**
   * Finds the installation and repository id of `owner/name` for this app (the rebuild
   * command's input). `null` when the app is not installed on it; `ForgeReadError`
   * (`installation_suspended`) when its installation is suspended.
   */
  locateRepository(fullName: string): Promise<RepositoryRef | null>;
}
