/**
 * The inbox's port (P6-7) and its two sources: the server's API (`/api/inbox`, ADR 0029) and the
 * fixture, which stands in until the web app reads the server for every page. Like the shell's
 * sources, `load` hands over unchecked JSON: the page runs it through `parseInbox`, so no source
 * can skip validation. Titles and logins stay untrusted text: rendered as text, never as HTML.
 *
 * `approve` is called only from the confirmation dialog's confirm button, once per batch.
 */
import {
  BULK_APPROVE_REFUSALS,
  BulkApproveRequest,
  BulkApproveResponse,
  InboxResponse,
} from "@rocky-reviews/core";
import { z } from "zod";
import { CSRF_HEADER, fetchSession } from "../session.js";
import { INBOX_FIXTURE } from "./fixtures.js";

export type ApproveResult =
  | { readonly kind: "done"; readonly results: BulkApproveResponse["results"] }
  | {
      readonly kind: "refused";
      readonly refusals: readonly {
        readonly id: string;
        readonly reason: (typeof BULK_APPROVE_REFUSALS)[number];
      }[];
    }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

export interface InboxSource {
  load(options?: { signal?: AbortSignal }): Promise<unknown>;
  approve(batch: BulkApproveRequest): Promise<ApproveResult>;
}

export class InboxLoadError extends Error {
  override readonly name = "InboxLoadError";
  constructor(readonly reason: "signed_out" | "unavailable" | "failed") {
    super(`inbox: ${reason}`);
  }
}

/** Validates what a source loaded. Messages name fields, never values (they are PR content). */
export const parseInbox = (raw: unknown): InboxResponse => {
  const parsed = InboxResponse.safeParse(raw);
  if (!parsed.success) {
    throw new InboxLoadError("failed");
  }
  return parsed.data;
};

const Refused = z.object({
  error: z.literal("batch_refused"),
  refusals: z.array(z.strictObject({ id: z.string(), reason: z.enum(BULK_APPROVE_REFUSALS) })),
});

/** Results must name exactly the batch's pull requests: nothing else is shown as approved. */
const sameBatch = (batch: BulkApproveRequest, results: BulkApproveResponse["results"]) =>
  results.length === batch.pullRequests.length &&
  results.every((r, i) => r.id === batch.pullRequests[i]?.id);

export const INBOX_PATH = "/api/inbox";
export const APPROVALS_PATH = "/api/inbox/approvals";

/** The server's inbox, same origin, with the session's CSRF token on the POST. */
export const createHttpInboxSource = (): InboxSource => ({
  load: async (options) => {
    const response = await fetch(INBOX_PATH, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 401) throw new InboxLoadError("signed_out");
    // H4-2: 503 until the server can check repository access (P3-6).
    if (response.status === 503) throw new InboxLoadError("unavailable");
    if (!response.ok) throw new InboxLoadError("failed");
    return response.json() as Promise<unknown>;
  },
  approve: async (batch) => {
    try {
      const session = await fetchSession();
      if (session === null) return { kind: "error" };
      const response = await fetch(APPROVALS_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [CSRF_HEADER]: session.csrfToken,
        },
        body: JSON.stringify(BulkApproveRequest.parse(batch)),
      });
      if (response.status === 503) return { kind: "unavailable" };
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 200) {
        const parsed = BulkApproveResponse.safeParse(body);
        return parsed.success && sameBatch(batch, parsed.data.results)
          ? { kind: "done", results: parsed.data.results }
          : { kind: "error" };
      }
      if (response.status === 409) {
        const refused = Refused.safeParse(body);
        if (refused.success) return { kind: "refused", refusals: refused.data.refusals };
      }
      return { kind: "error" };
    } catch {
      return { kind: "error" };
    }
  },
});

/** The fixture inbox. `approve` is a stand-in: it approves nothing anywhere, it only answers. */
export const createFixtureInboxSource = (options: { delayMs?: number } = {}): InboxSource => {
  const approved = new Set<string>();
  return {
    load: async () => ({
      ...INBOX_FIXTURE,
      items: INBOX_FIXTURE.items.filter((item) => !approved.has(item.id)),
    }),
    approve: async (batch) => {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 300));
      for (const pick of batch.pullRequests) approved.add(pick.id);
      return {
        kind: "done",
        results: batch.pullRequests.map((p) => ({ id: p.id, outcome: "approved" as const })),
      };
    },
  };
};
