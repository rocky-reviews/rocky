/**
 * Ask from the server (P9-2, ADR 0041): `GET` and `POST /api/repos/:owner/:repo/pulls/:number/ask`,
 * same origin, with the session cookie. A question carries the session's CSRF token
 * (`x-rocky-csrf`, ADR 0020 §5), read once from `/api/session` and kept in memory only. Answers
 * are handed over unchecked, with their status, for `ask-data.ts` to read; a body that is not
 * JSON is `undefined`. A 429's `retry-after` header goes with it when it is a plain number of
 * seconds (P9-3). Nothing is cached (the server answers `no-store`).
 */
import { CSRF_HEADER, fetchSession } from "../session.js";
import { askPath, retryAfterFromHeader, type AskSource, type RawAnswer } from "./ask-data.js";

type Fetch = typeof fetch;

const answerOf = async (response: Response): Promise<RawAnswer> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const retryAfterSeconds = retryAfterFromHeader(response.headers.get("retry-after"));
  return retryAfterSeconds === undefined
    ? { status: response.status, body }
    : { status: response.status, body, retryAfterSeconds };
};

export const createHttpAskSource = (
  options: { fetch?: Fetch; csrfToken?: () => Promise<string | null> } = {},
): AskSource => {
  const http: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  let token: Promise<string | null> | null = null;
  const csrf =
    options.csrfToken ??
    (() => {
      token ??= fetchSession().then((session) => session?.csrfToken ?? null);
      // A failed lookup is not remembered: the next question asks again.
      token.catch(() => {
        token = null;
      });
      return token;
    });

  return {
    index: async (pull, { signal } = {}) =>
      answerOf(
        await http(askPath(pull), {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
    ask: async (pull, question, { signal } = {}) => {
      let csrfToken: string | null;
      try {
        csrfToken = await csrf();
      } catch {
        csrfToken = null;
      }
      // Signed out (or the session could not be read): nothing is sent.
      if (csrfToken === null) return { status: 401, body: undefined };
      return answerOf(
        await http(askPath(pull), {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            [CSRF_HEADER]: csrfToken,
          },
          body: JSON.stringify(question),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    },
  };
};
