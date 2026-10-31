/**
 * The pull request's diff for the file view (P6-3), and the port it is read through. Separate
 * from the shell's data: the diff is large and only needed once a file is opened. The server
 * source (`diff-http-source.ts`, H4-3) implements it for a real PR; the fixture source
 * (`diff-fixture-source.ts`) in development and tests. The components do not know which.
 *
 * The diff is untrusted PR content. `parseDiffData` reads it with core's strict unified-diff
 * reader, which refuses anything malformed; the view renders every line as text.
 */
import { type DiffFile, parseUnifiedDiff } from "@rocky-reviews/core/diff";
import type { PullRef } from "./shell-data.js";

/**
 * What a source hands over: unchecked. Only `parseDiffData` turns it into `DiffData`.
 * `truncation` (H4-3): the server says `"max_bytes"` when it read only a prefix of the diff
 * (cut at a line end, ADR 0010 §4); absent or `null` means the whole diff.
 */
export type RawDiffData = { headSha: unknown; diff: unknown; truncation?: unknown };

export type DiffData = {
  /** The commit the diff ends at; AI notes are only shown when the analysis is for it. */
  headSha: string;
  /** By path, in diff order. */
  files: ReadonlyMap<string, DiffFile>;
  /** Only a prefix of the diff was read: files past the cut are not in `files`. */
  truncated: boolean;
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
  const truncation = input.truncation ?? null;
  if (truncation !== null && truncation !== "max_bytes")
    throw new DiffDataError("invalid truncation");
  const truncated = truncation === "max_bytes";
  if (input.diff === "") return { headSha: input.headSha, files: new Map(), truncated };
  const parsed = parseUnifiedDiff(input.diff);
  if (!parsed.ok) throw new DiffDataError(`unreadable diff: ${parsed.code}`);
  return {
    headSha: input.headSha,
    files: new Map(parsed.files.map((f) => [f.path, f])),
    truncated,
  };
};
