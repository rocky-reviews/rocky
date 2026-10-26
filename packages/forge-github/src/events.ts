import type {
  ForgeEvent,
  WebhookIgnoreReason,
  InstallationEventType,
  PullRequestEventType,
} from "@rocky-reviews/core";
import { z } from "zod";

/**
 * GitHub webhook payloads → forge-neutral `ForgeEvent`s. Only the fields the domain needs are
 * read; everything else in the payload (titles, bodies, diffs, emails, URLs) is dropped here and
 * never stored. Every kept string is shape-checked and bounded, because the payload is
 * untrusted input even after the signature check (it carries PR authors' content).
 */

const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
const ForgeId = z.int().min(1).max(MAX_SAFE_ID);
/** GitHub caps PR numbers well below this; Postgres `integer` is the hard limit downstream. */
const PrNumber = z.int().min(1).max(2_147_483_647);
/** GitHub logins: letters, digits, `-` (and `_` for managed users); bounded. */
const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
/** Actors can also be GitHub Apps acting as themselves: `name[bot]`. Senders only. */
const ActorLogin = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/);
const Sender = z.object({ id: ForgeId, login: ActorLogin });
/** SHA-1 or SHA-256 object ids, lower-case hex as GitHub sends them. */
const Sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const ACCOUNT_KIND = { Organization: "organization", User: "user" } as const;

const InstallationPayload = z.object({
  installation: z.object({
    id: ForgeId,
    account: z.object({
      id: ForgeId,
      login: Login,
      type: z.enum(["Organization", "User"]),
    }),
  }),
});

/** Read first, so an account kind the domain does not model is ignored rather than refused. */
const AccountType = z.object({
  installation: z.object({ account: z.object({ type: z.string() }) }),
});

const PullRequestPayload = z.object({
  number: PrNumber,
  pull_request: z.object({
    number: PrNumber,
    head: z.object({ sha: Sha }),
    merged: z.boolean().nullish(),
  }),
  repository: z.object({ id: ForgeId }),
  installation: z.object({ id: ForgeId }),
});

const Action = z.object({ action: z.string().max(64) });

const INSTALLATION_ACTIONS: Readonly<Record<string, InstallationEventType>> = {
  created: "installation.created",
  deleted: "installation.deleted",
};

const PULL_REQUEST_ACTIONS: Readonly<Record<string, PullRequestEventType>> = {
  opened: "pull_request.opened",
  synchronize: "pull_request.synchronize",
  closed: "pull_request.closed",
  reopened: "pull_request.reopened",
};

/** Webhook event names (`X-GitHub-Event`) this adapter decodes. Everything else is ignored. */
export const HANDLED_EVENTS = ["installation", "pull_request"] as const;

export type DecodeResult =
  | { readonly kind: "event"; readonly event: ForgeEvent }
  | { readonly kind: "ignored"; readonly reason?: WebhookIgnoreReason }
  | { readonly kind: "invalid" };

const lookup = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/**
 * Decodes one parsed payload for a handled event name. Unknown actions are `ignored`; a known
 * action whose payload does not have the expected shape is `invalid`. Never throws.
 */
export const decodeGitHubEvent = (eventName: string, payload: unknown): DecodeResult => {
  const action = Action.safeParse(payload);
  if (!action.success) return { kind: "invalid" };

  if (eventName === "installation") {
    const type = lookup(INSTALLATION_ACTIONS, action.data.action);
    if (type === undefined) return { kind: "ignored" };
    const accountType = AccountType.safeParse(payload);
    if (
      accountType.success &&
      !Object.hasOwn(ACCOUNT_KIND, accountType.data.installation.account.type)
    ) {
      return { kind: "ignored", reason: "unsupported_account_type" };
    }
    const parsed = InstallationPayload.safeParse(payload);
    if (!parsed.success) return { kind: "invalid" };
    const { installation } = parsed.data;
    // Non-fatal: an uninstall by an app, a deleted ("ghost") user or a staff action must still
    // be recorded, so an unusable sender becomes null instead of refusing the delivery.
    const sender = Sender.safeParse(
      Object.hasOwn(payload as object, "sender")
        ? (payload as { sender: unknown }).sender
        : undefined,
    );
    return {
      kind: "event",
      event: {
        type,
        installationId: installation.id,
        account: {
          id: installation.account.id,
          login: installation.account.login,
          kind: ACCOUNT_KIND[installation.account.type],
        },
        sender: sender.success ? { id: sender.data.id, login: sender.data.login } : null,
      },
    };
  }

  if (eventName === "pull_request") {
    const type = lookup(PULL_REQUEST_ACTIONS, action.data.action);
    if (type === undefined) return { kind: "ignored" };
    const parsed = PullRequestPayload.safeParse(payload);
    if (!parsed.success) return { kind: "invalid" };
    const p = parsed.data;
    if (p.pull_request.number !== p.number) return { kind: "invalid" };
    return {
      kind: "event",
      event: {
        type,
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        number: p.number,
        headSha: p.pull_request.head.sha,
        merged: type === "pull_request.closed" && p.pull_request.merged === true,
      },
    };
  }

  return { kind: "ignored" };
};
