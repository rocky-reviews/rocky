/**
 * The page's one diff load (P6-3, H4-3), kept apart from React so its rules can be tested.
 *
 * H4-16: the page preloads the diff when the briefing is shown, so the first file opened rarely
 * waits for GitHub. A load is started once and shared by every file view. A preload that fails
 * for a passing reason (`PASSING`) is kept quiet: the page reads as if nothing was loaded yet,
 * and the first file opened tries once more, so it shows a fresh answer rather than one from
 * before. Any other failure, and a failure the file view was already waiting on, is shown as
 * today and never retried.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { type DiffData, type DiffDataSource, parseDiffData } from "../data/diff-data.js";
import { DiffLoadError, type DiffLoadReason } from "../data/diff-http-source.js";
import type { PullRef } from "../data/shell-data.js";

export type DiffLoad =
  | { readonly kind: "idle" | "loading" }
  | { readonly kind: "failed"; readonly reason: DiffLoadReason }
  | { readonly kind: "ready"; readonly data: DiffData };

/** Failures that may be gone a moment later: GitHub, the rate limit, or an unreadable answer. */
const PASSING: ReadonlySet<DiffLoadReason> = new Set(["failed", "forge_failed", "rate_limited"]);

export type DiffLoader = {
  /** Starts the load if nothing has yet (the briefing is shown). */
  readonly preload: () => void;
  /** Starts the load if nothing has yet, or retries a quietly failed preload (a file opens). */
  readonly request: () => void;
  /** Aborts the load in flight and drops whatever it answers. */
  readonly dispose: () => void;
};

export const createDiffLoader = (
  source: DiffDataSource,
  pull: PullRef,
  onChange: (load: DiffLoad) => void,
): DiffLoader => {
  let started: AbortController | null = null;
  // Set while the only load so far was a preload no file view waited on.
  let preloadOnly = false;
  let retry = false;

  const start = (preload: boolean) => {
    const abort = new AbortController();
    started = abort;
    preloadOnly = preload;
    retry = false;
    onChange({ kind: "loading" });
    source
      .load(pull, { signal: abort.signal })
      .then(parseDiffData)
      .then(
        (data) => !abort.signal.aborted && onChange({ kind: "ready", data }),
        // The error may describe PR content; the view says only why, as a fixed reason.
        (error: unknown) => {
          if (abort.signal.aborted) return;
          const reason = error instanceof DiffLoadError ? error.reason : "failed";
          if (preloadOnly && PASSING.has(reason)) {
            retry = true;
            onChange({ kind: "idle" });
          } else onChange({ kind: "failed", reason });
        },
      );
  };

  return {
    preload: () => {
      if (started === null) start(true);
    },
    request: () => {
      if (started === null || retry) start(false);
      else preloadOnly = false;
    },
    dispose: () => {
      started?.abort();
      started = null;
      preloadOnly = false;
      retry = false;
    },
  };
};

/**
 * Whether the page preloads the diff: only when the analysis is for the PR's head and lists a
 * file a reviewer can open from the sidebar (triaged, noise, whose raw diff is on request, or not
 * analysed). With no analysis, none of those files, or an older push's analysis, the diff stays
 * unread until a file is opened, as before H4-16 (on an older push the drafts stay shown until
 * then).
 */
export const preloadsDiff = (analysis: AnalysisDocument | null, pullHead: string): boolean =>
  analysis !== null &&
  analysis.provenance.head.sha === pullHead &&
  (analysis.triage.files.length > 0 ||
    analysis.triage.noise.length > 0 ||
    analysis.provenance.unanalysed.length > 0);
