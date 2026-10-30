/**
 * The shell's data from the server (H4-2): `GET /api/repos/:owner/:repo/pulls/:number`, same
 * origin, with the session cookie. Like every source it hands over unchecked parts; the app runs
 * them through `parseShellData`, so a server answer gets no more trust than a fixture.
 *
 * A refusal becomes a `ShellLoadError` with a fixed reason the page can explain (signed out, not
 * found, repository access not available yet); the body of a refusal is never read into an
 * error, and nothing is cached by the browser (the server answers `no-store`).
 */
import type { PullRef, RawShellData, ShellDataSource } from "./shell-data.js";

export type ShellLoadReason = "signed_out" | "not_found" | "unavailable" | "failed";

export class ShellLoadError extends Error {
  override readonly name = "ShellLoadError";
  constructor(readonly reason: ShellLoadReason) {
    super(`pull request: ${reason}`);
  }
}

type Fetch = typeof fetch;

/** The server's address for a PR's shell data. */
export const shellDataPath = (ref: PullRef): string =>
  `/api/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`;

const reasonOf = (status: number): ShellLoadReason => {
  if (status === 401) return "signed_out";
  // 400: the address cannot name a pull request; for the person, the same as one that is not there.
  if (status === 404 || status === 400) return "not_found";
  if (status === 503) return "unavailable";
  return "failed";
};

export const createHttpShellSource = (options: { fetch?: Fetch } = {}): ShellDataSource => {
  const http: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    load: async (ref, { signal } = {}): Promise<RawShellData> => {
      const response = await http(shellDataPath(ref), {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new ShellLoadError(reasonOf(response.status));
      const body: unknown = await response.json().catch(() => null);
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new ShellLoadError("failed");
      const answer = body as Record<string, unknown>;
      return {
        pull: answer["pull"],
        myReview: answer["myReview"],
        analysis: answer["analysis"],
        analysisRun: answer["analysisRun"],
        analysisId: answer["analysisId"],
        pullRequestId: answer["pullRequestId"],
      };
    },
  };
};
