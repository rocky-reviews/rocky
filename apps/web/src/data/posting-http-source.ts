/**
 * The posting API client (P6-6 over P3-5): `ReviewPostingSource` over `GET` and `POST
 * /api/pull-requests/:id/review`. The click carries the session's CSRF token (`x-rocky-csrf`,
 * ADR 0020 §5), read once from `/api/session` and kept in memory only. Same origin, cookies
 * included; nothing is cached (the server answers `no-store`).
 *
 * Answers come back unchecked, with their status, for `posting-data.ts` to interpret; a body
 * that is not JSON is `undefined`. When the CSRF token cannot be read, nothing is sent and the
 * answer has status 0 (`not_sent`); a request that fails rejects, and the caller must treat
 * that as "the review may exist". Errors thrown here carry a status only, never an answer.
 */
import { CSRF_HEADER, fetchSession } from "../session.js";
import type { Answer, ReviewPostingSource, SubmitInput } from "./posting-data.js";

export class PostingRequestError extends Error {
  override readonly name = "PostingRequestError";
  readonly status: number;
  constructor(what: string, status: number) {
    super(`${what}: ${status}`);
    this.status = status;
  }
}

type Fetch = typeof fetch;

const url = (pullRequestId: string) =>
  `/api/pull-requests/${encodeURIComponent(pullRequestId)}/review`;

const answerOf = async (response: Response): Promise<Answer> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

/** Nothing was sent: the caller may retry with the same key, nothing can have been posted. */
const NOT_SENT: Answer = { status: 0, body: { error: "not_sent" } };

export const createHttpPostingSource = (
  options: { fetch?: Fetch; csrfToken?: () => Promise<string> } = {},
): ReviewPostingSource => {
  const http: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  let token: Promise<string> | null = null;
  const csrf =
    options.csrfToken ??
    (() => {
      token ??= fetchSession().then((session) => {
        if (session === null) throw new PostingRequestError("session", 401);
        return session.csrfToken;
      });
      // A failed lookup is not remembered: the next click asks again.
      token.catch(() => {
        token = null;
      });
      return token;
    });

  return {
    preview: async (pullRequestId, { signal } = {}) =>
      answerOf(
        await http(url(pullRequestId), {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
    submit: async (pullRequestId, input: SubmitInput) => {
      let csrfToken: string;
      try {
        csrfToken = await csrf();
      } catch {
        return NOT_SENT;
      }
      return answerOf(
        await http(url(pullRequestId), {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            [CSRF_HEADER]: csrfToken,
          },
          body: JSON.stringify({
            idempotencyKey: input.idempotencyKey,
            contentSha256: input.contentSha256,
            headSha: input.headSha,
            verdict: input.verdict,
            body: input.body,
          }),
        }),
      );
    },
  };
};
