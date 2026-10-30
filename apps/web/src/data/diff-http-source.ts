/**
 * The diff from the server (H4-3, ADR 0034): `GET /api/repos/:owner/:repo/pulls/:number/diff`,
 * same origin, with the session cookie. Like every source it hands over unchecked parts; the
 * provider runs them through `parseDiffData`, so a server answer gets no more trust than a
 * fixture (the diff is PR content, read with core's strict reader and rendered as text).
 *
 * A refusal becomes a `DiffLoadError` with a fixed reason the file view can explain; the body
 * of a refusal is never read into an error, and nothing is cached by the browser (the server
 * answers `no-store`).
 */
import type { DiffDataSource, RawDiffData } from "./diff-data.js";
import type { PullRef } from "./shell-data.js";

export type DiffLoadReason =
  /** 401: the session ended. */
  | "signed_out"
  /** 404 (and 400): no such PR in Rocky, or no GitHub read access to its repository. */
  | "not_found"
  /** 409: GitHub's head moved since the mirror's, or GitHub has no diff for its commits. */
  | "head_moved"
  /** 413: GitHub refuses to render a diff this large. */
  | "too_large"
  /** 429: more requests than the per-member limit. */
  | "rate_limited"
  /** 502: GitHub did not answer the server. */
  | "forge_failed"
  /** 503: the server has no repository access check or no diff reader yet. */
  | "unavailable"
  /** Anything else, including an answer `parseDiffData` refuses. */
  | "failed";

export class DiffLoadError extends Error {
  override readonly name = "DiffLoadError";
  constructor(readonly reason: DiffLoadReason) {
    super(`diff: ${reason}`);
  }
}

type Fetch = typeof fetch;

/** The server's address for a PR's diff. */
export const diffDataPath = (ref: PullRef): string =>
  `/api/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/diff`;

const reasonOf = (status: number): DiffLoadReason => {
  switch (status) {
    case 401:
      return "signed_out";
    case 400:
    case 404:
      return "not_found";
    case 409:
      return "head_moved";
    case 413:
      return "too_large";
    case 429:
      return "rate_limited";
    case 502:
      return "forge_failed";
    case 503:
      return "unavailable";
    default:
      return "failed";
  }
};

export const createHttpDiffSource = (options: { fetch?: Fetch } = {}): DiffDataSource => {
  const http: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    load: async (ref, { signal } = {}): Promise<RawDiffData> => {
      const response = await http(diffDataPath(ref), {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new DiffLoadError(reasonOf(response.status));
      const body: unknown = await response.json().catch(() => null);
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new DiffLoadError("failed");
      const answer = body as Record<string, unknown>;
      return { headSha: answer["headSha"], diff: answer["diff"], truncation: answer["truncation"] };
    },
  };
};
