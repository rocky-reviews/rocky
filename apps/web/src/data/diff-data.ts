/**
 * The pull request's diff for the file view (P6-3), and the port it is read through. Separate
 * from the shell's data: the diff is large and only needed once a file is opened. The fixture
 * source (`diff-fixture-source.ts`) implements it today; a server-backed source (after P7-1
 * sessions and P7-2 policy) replaces it without the components changing.
 *
 * The diff is untrusted PR content. `parseDiffData` reads it with core's strict unified-diff
 * reader, which refuses anything malformed; the view renders every line as text.
 */
import { type DiffFile, parseUnifiedDiff } from "@rocky-reviews/core/diff";
import type { PullRef } from "./shell-data.js";

/** What a source hands over: unchecked. Only `parseDiffData` turns it into `DiffData`. */
export type RawDiffData = { headSha: unknown; diff: unknown };

export type DiffData = {
  /** The commit the diff ends at; AI notes are only shown when the analysis is for it. */
  headSha: string;
  /** By path, in diff order. */
  files: ReadonlyMap<string, DiffFile>;
};

export interface DiffDataSource {
  load(ref: PullRef, options?: { signal?: AbortSignal }): Promise<RawDiffData>;
}

/** Bounds the text a source can make the tab read (GitHub refuses diffs far smaller). */
export const MAX_DIFF_CHARS = 20_000_000;

const SHA = /^[0-9a-f]{40}$/;

export class DiffDataError extends Error {
  override readonly name = "DiffDataError";
}

/** Validates data from any source. Errors name a field or a fixed code, never content. */
export const parseDiffData = (input: RawDiffData): DiffData => {
  if (typeof input.headSha !== "string" || !SHA.test(input.headSha))
    throw new DiffDataError("invalid head sha");
  if (typeof input.diff !== "string") throw new DiffDataError("invalid diff");
  if (input.diff.length > MAX_DIFF_CHARS) throw new DiffDataError("diff too large");
  if (input.diff === "") return { headSha: input.headSha, files: new Map() };
  const parsed = parseUnifiedDiff(input.diff);
  if (!parsed.ok) throw new DiffDataError(`unreadable diff: ${parsed.code}`);
  return { headSha: input.headSha, files: new Map(parsed.files.map((f) => [f.path, f])) };
};

/**
 * H4-2: the diff for a PR read from the server, until the server serves diffs (a follow-up):
 * every load fails, so the file view says the diff could not be loaded.
 */
export const unavailableDiffSource: DiffDataSource = {
  load: () => Promise.reject(new DiffDataError("diff not served yet")),
};
