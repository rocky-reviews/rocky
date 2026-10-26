import type { ForgeEvent, InstallationEventType, PullRequestEventType } from "@rocky-reviews/core";
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
  | { readonly kind: "ignored" }
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
    const parsed = InstallationPayload.safeParse(payload);
    if (!parsed.success) return { kind: "invalid" };
    const { installation } = parsed.data;
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
