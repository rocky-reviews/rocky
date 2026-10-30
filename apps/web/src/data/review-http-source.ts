/**
 * The drafts API client (P6-4, ADR 0027): `ReviewSource` over the server's routes. State changes
 * carry the session's CSRF token (`x-rocky-csrf`, ADR 0020 §5), read once from `/api/session`
 * and kept in memory only. Same origin, cookies included; nothing is cached by the browser
 * (the server answers `no-store`).
 *
 * Errors carry the HTTP status only: an answer's body is never put in an error message.
 */
import type { DraftAction } from "@rocky-reviews/core/drafts";
import { CSRF_HEADER, fetchSession } from "../session.js";
import type { ReviewSource } from "./review-data.js";

export class ReviewRequestError extends Error {
  override readonly name = "ReviewRequestError";
  readonly status: number;
  constructor(what: string, status: number) {
    super(`${what}: ${status}`);
    this.status = status;
  }
}

type Fetch = typeof fetch;

const base = (analysisId: string) => `/api/analyses/${encodeURIComponent(analysisId)}`;

const actionBody = (action: DraftAction): Record<string, string> => {
  switch (action.kind) {
    case "edit":
      return { action: "edit", body: action.body };
    case "dismiss":
      return { action: "dismiss", reason: action.reason };
    default:
      return { action: action.kind };
  }
};

export const createHttpReviewSource = (
  options: { fetch?: Fetch; csrfToken?: () => Promise<string> } = {},
): ReviewSource => {
  const http: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  let token: Promise<string> | null = null;
  const csrf =
    options.csrfToken ??
    (() => {
      token ??= fetchSession().then((session) => {
        if (session === null) throw new ReviewRequestError("session", 401);
        return session.csrfToken;
      });
      // A failed lookup is not remembered: the next action asks again.
      token.catch(() => {
        token = null;
      });
      return token;
    });

  const send = async (method: "POST" | "DELETE", url: string, body?: unknown) =>
    http(url, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        [CSRF_HEADER]: await csrf(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    load: async (analysisId, { signal } = {}) => {
      const response = await http(`${base(analysisId)}/review`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new ReviewRequestError("review", response.status);
      return response.json();
    },
    decide: async (analysisId, findingId, action) => {
      const response = await send(
        "POST",
        `${base(analysisId)}/drafts/${encodeURIComponent(findingId)}`,
        actionBody(action),
      );
      if (response.status !== 200 && response.status !== 409)
        throw new ReviewRequestError("draft", response.status);
      const answer = (await response.json()) as { error?: unknown; draft?: unknown };
      if (response.status === 409 && answer.error === "already_posted") return { kind: "posted" };
      return { kind: response.status === 200 ? "ok" : "conflict", draft: answer.draft };
    },
    addComment: async (analysisId, comment) => {
      const response = await send("POST", `${base(analysisId)}/comments`, comment);
      if (response.status !== 201) throw new ReviewRequestError("comment", response.status);
      const answer = (await response.json()) as { comment?: unknown };
      return answer.comment;
    },
    deleteComment: async (analysisId, commentId) => {
      const response = await send(
        "DELETE",
        `${base(analysisId)}/comments/${encodeURIComponent(commentId)}`,
      );
      if (response.status === 409) return "posted";
      if (response.status !== 204 && response.status !== 404)
        throw new ReviewRequestError("delete comment", response.status);
      return "deleted";
    },
  };
};
