/**
 * Ask's data (P9-2, ADR 0041): what the panel reads through its port, and the rules that turn
 * a server (or fixture) answer into something it shows. Every answer is checked here, the one
 * place, so no source can skip it: an index state, a reply or a citation that does not have the
 * expected shape is an error or is dropped, never shown half-understood.
 *
 * A citation becomes a link only when one can be built from parts that pass the checks below
 * (`citationUrl`): the page's own repository, the commit the server says the index holds, and
 * the cited path and lines. Never from a URL in an answer, so neither the model nor the server
 * can point a link anywhere else. A citation that fails is dropped, never shown as a link.
 */
import { limits, RepoName, RepoOwner } from "@rocky-reviews/schema";
import type { PullRef } from "../data/shell-data.js";

export type AskIndex =
  | { readonly status: "ready"; readonly indexedSha: string; readonly updating: boolean }
  | { readonly status: "indexing" }
  | { readonly status: "not_indexed" }
  | { readonly status: "off" };

/** Why the index state could not be read. */
export type AskIndexProblem = "signed_out" | "not_found" | "failed";

export interface AskSelection {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface AskQuestion {
  readonly question: string;
  readonly selection?: AskSelection;
}

export interface Citation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Built here (`citationUrl`), never taken from an answer. */
  readonly url: string;
}

/** `rate_limited` is the member's own per-minute limit; `org_rate_limited` the org's Ask budget. */
export type AskProblem =
  | "not_indexed"
  | "indexing"
  | "rate_limited"
  | "org_rate_limited"
  | "model_unavailable"
  | "answer_failed"
  | "forge_unavailable"
  | "unavailable"
  | "invalid_question"
  | "not_found"
  | "signed_out"
  | "failed";

export type AskReply =
  | {
      readonly kind: "answered";
      readonly answer: string;
      readonly citations: readonly Citation[];
      readonly indexedSha: string;
    }
  | {
      readonly kind: "no_answer";
      readonly reason: "no_context" | "model" | "uncited";
      readonly note: string | null;
    }
  | {
      readonly kind: "error";
      readonly problem: AskProblem;
      /** For the two limit problems only, when the server said how long (P9-3). */
      readonly retryAfterSeconds?: number;
    };

/**
 * An answer as the source got it: a status and the body, unchecked. `retryAfterSeconds` is
 * the `retry-after` header of a 429, in seconds, as far as the source could read it.
 */
export interface RawAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;
}

/** The port the panel reads through (server, or fixtures in development and tests). */
export interface AskSource {
  index(pull: PullRef, options?: { signal?: AbortSignal }): Promise<RawAnswer>;
  ask(pull: PullRef, question: AskQuestion, options?: { signal?: AbortSignal }): Promise<RawAnswer>;
}

/** The panel's own bounds (the server checks the same). */
export const MAX_QUESTION_CHARS = 2_000;
export const MAX_SELECTION_CHARS = 4_000;
const MAX_ANSWER_CHARS = 4_000;
const MAX_NOTE_CHARS = 4_000;
const MAX_CITATIONS = 8;
/** The longest wait a 429 can ask for and still be shown (a day; the server never says more). */
const MAX_RETRY_AFTER_SECONDS = 86_400;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GITHUB = "https://github.com";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const isLine = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= limits.MAX_LINE_NUMBER;

/**
 * A path inside the repository that can go in a URL as it is, segment by segment: no empty,
 * `.` or `..` segment, no leading slash, no control or invisible character.
 */
const pathSegments = (path: string): string[] | undefined => {
  if (path.length === 0 || path.length > limits.MAX_PATH_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]|[\p{Cf}\p{Zl}\p{Zp}]/u.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return segments;
};

/**
 * GitHub's view of the cited lines at the indexed commit, or undefined when any part fails:
 * `https://github.com/{owner}/{repo}/blob/{sha}/{path}#L{start}-L{end}`.
 */
export const citationUrl = (
  pull: PullRef,
  indexedSha: string,
  citation: { readonly path: string; readonly startLine: number; readonly endLine: number },
): string | undefined => {
  const owner = RepoOwner.safeParse(pull.owner);
  const repo = RepoName.safeParse(pull.repo);
  if (!owner.success || !repo.success || repo.data === "." || repo.data === "..") return undefined;
  if (!SHA.test(indexedSha)) return undefined;
  const { startLine, endLine } = citation;
  if (!isLine(startLine) || !isLine(endLine) || endLine < startLine) return undefined;
  const segments = pathSegments(citation.path);
  if (segments === undefined) return undefined;
  const url = new URL(
    `/${encodeURIComponent(owner.data)}/${encodeURIComponent(repo.data)}/blob/${indexedSha}/${segments
      .map(encodeURIComponent)
      .join("/")}`,
    GITHUB,
  );
  url.hash = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return url.origin === GITHUB ? url.href : undefined;
};

/** The index state from a `GET …/ask` answer. */
export const parseAskIndex = (
  answer: RawAnswer,
):
  | { readonly ok: true; readonly index: AskIndex }
  | { readonly ok: false; readonly problem: AskIndexProblem } => {
  if (answer.status === 401) return { ok: false, problem: "signed_out" };
  if (answer.status === 404 || answer.status === 400) return { ok: false, problem: "not_found" };
  if (answer.status !== 200) return { ok: false, problem: "failed" };
  const index = record(record(answer.body)?.["index"]);
  switch (index?.["status"]) {
    case "ready": {
      const sha = index["indexedSha"];
      const updating = index["updating"];
      return typeof sha === "string" && SHA.test(sha) && typeof updating === "boolean"
        ? { ok: true, index: { status: "ready", indexedSha: sha, updating } }
        : { ok: false, problem: "failed" };
    }
    case "indexing":
    case "not_indexed":
    case "off":
      return { ok: true, index: { status: index["status"] } };
    default:
      return { ok: false, problem: "failed" };
  }
};

const PROBLEMS: Readonly<Record<string, AskProblem>> = {
  not_indexed: "not_indexed",
  indexing: "indexing",
  model_unavailable: "model_unavailable",
  answer_failed: "answer_failed",
  forge_unavailable: "forge_unavailable",
  ask_unavailable: "unavailable",
  access_check_unavailable: "unavailable",
  invalid_question: "invalid_question",
};

const errorOf = (body: unknown): string | null => {
  const error = record(body)?.["error"];
  return typeof error === "string" ? error : null;
};

const isRetryAfter = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_RETRY_AFTER_SECONDS;

/**
 * A `retry-after` header's value as seconds, or undefined: only the delay-seconds form, a plain
 * integer from 1 to a day (the HTTP-date form, and anything else, is not read).
 */
export const retryAfterFromHeader = (value: string | null): number | undefined => {
  if (value === null || !/^\d{1,5}$/.test(value)) return undefined;
  const seconds = Number(value);
  return isRetryAfter(seconds) ? seconds : undefined;
};

/** A `POST …/ask` answer as the panel shows it (see the module comment). */
export const parseAskReply = (pull: PullRef, answer: RawAnswer): AskReply => {
  const fail = (problem: AskProblem): AskReply => ({ kind: "error", problem });
  if (answer.status === 401) return fail("signed_out");
  if (answer.status === 404) return fail("not_found");
  if (answer.status === 429) {
    // P9-3: the body says whose limit it was; without it (an older server), the member's own.
    const problem: AskProblem =
      record(answer.body)?.["limit"] === "org" ? "org_rate_limited" : "rate_limited";
    return isRetryAfter(answer.retryAfterSeconds)
      ? { kind: "error", problem, retryAfterSeconds: answer.retryAfterSeconds }
      : fail(problem);
  }
  if (answer.status !== 200) {
    const code = errorOf(answer.body);
    return fail(
      (code !== null && Object.hasOwn(PROBLEMS, code) ? PROBLEMS[code] : undefined) ?? "failed",
    );
  }
  const body = record(answer.body);
  if (body === null) return fail("failed");
  if (body["status"] === "no_answer") {
    const reason = body["reason"];
    const note = body["note"];
    if (reason !== "no_context" && reason !== "model" && reason !== "uncited")
      return fail("failed");
    return {
      kind: "no_answer",
      reason,
      note:
        reason === "model" &&
        typeof note === "string" &&
        note.length > 0 &&
        note.length <= MAX_NOTE_CHARS
          ? note
          : null,
    };
  }
  if (body["status"] !== "answered") return fail("failed");
  const text = body["answer"];
  const sha = body["indexedSha"];
  const raw = body["citations"];
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_ANSWER_CHARS ||
    typeof sha !== "string" ||
    !SHA.test(sha) ||
    !Array.isArray(raw)
  ) {
    return fail("failed");
  }
  const citations: Citation[] = [];
  for (const item of raw.slice(0, MAX_CITATIONS)) {
    const c = record(item);
    if (c === null || typeof c["path"] !== "string") continue;
    const cited = { path: c["path"], startLine: c["startLine"], endLine: c["endLine"] };
    if (!isLine(cited.startLine) || !isLine(cited.endLine)) continue;
    const url = citationUrl(
      pull,
      sha,
      cited as { path: string; startLine: number; endLine: number },
    );
    if (url === undefined) continue;
    citations.push({ path: cited.path, startLine: cited.startLine, endLine: cited.endLine, url });
  }
  // An answer whose every citation was dropped here points at nothing the reader can check.
  if (citations.length === 0) return { kind: "no_answer", reason: "uncited", note: null };
  return { kind: "answered", answer: text, citations, indexedSha: sha };
};

/** `path:12` or `path:12–14`, for a citation's label. */
export const lineLabel = (c: {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}) =>
  c.startLine === c.endLine ? `${c.path}:${c.startLine}` : `${c.path}:${c.startLine}–${c.endLine}`;

/** The server's address for Ask on a PR. */
export const askPath = (ref: PullRef): string =>
  `/api/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/ask`;
