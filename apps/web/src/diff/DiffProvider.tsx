/**
 * The diff, for every file view of the page (P6-3). It is loaded once, on the first file opened,
 * through the `DiffDataSource` port and validated with `parseDiffData`. The reviewer's own
 * comments are kept on the server with the drafts (P6-4, `drafts/ReviewProvider.tsx`).
 * H4-3: a load that fails carries a fixed reason (the server's refusal, or `failed` for
 * anything else, an unreadable answer included), so the file view can say why.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type DiffData, type DiffDataSource, parseDiffData } from "../data/diff-data.js";
import { DiffLoadError, type DiffLoadReason } from "../data/diff-http-source.js";
import type { PullRef } from "../data/shell-data.js";

export type { DiffLoadReason } from "../data/diff-http-source.js";

export type DiffLoad =
  | { readonly kind: "idle" | "loading" }
  | { readonly kind: "failed"; readonly reason: DiffLoadReason }
  | { readonly kind: "ready"; readonly data: DiffData };

export type DiffContextValue = {
  readonly load: DiffLoad;
  /** Starts loading the diff if nothing has yet. */
  readonly request: () => void;
  /** The PR the diff belongs to (validated names), for a link to the whole diff on GitHub. */
  readonly pull: PullRef | null;
  /** Where "Sign in with GitHub" comes back to after a dead session: this page's own path. */
  readonly returnTo?: string;
};

/** Without a provider there is no diff to show. */
export const DiffContext = createContext<DiffContextValue>({
  load: { kind: "failed", reason: "failed" },
  request: () => {},
  pull: null,
});

export const useDiff = (): DiffContextValue => useContext(DiffContext);

/** GitHub's limit for a review comment body. */
export const MAX_COMMENT_CHARS = 65_536;

type Props = { source: DiffDataSource; pull: PullRef; returnTo?: string; children: ReactNode };

export const DiffProvider = ({ source, pull, returnTo, children }: Props) => {
  const [load, setLoad] = useState<DiffLoad>({ kind: "idle" });
  const started = useRef<AbortController | null>(null);

  const request = useCallback(() => {
    if (started.current !== null) return;
    const abort = new AbortController();
    started.current = abort;
    setLoad({ kind: "loading" });
    source
      .load(pull, { signal: abort.signal })
      .then(parseDiffData)
      .then(
        (data) => !abort.signal.aborted && setLoad({ kind: "ready", data }),
        // The error may describe PR content; the view says only why, as a fixed reason.
        (error: unknown) =>
          !abort.signal.aborted &&
          setLoad({
            kind: "failed",
            reason: error instanceof DiffLoadError ? error.reason : "failed",
          }),
      );
  }, [source, pull]);

  // A different PR or source starts over.
  useEffect(
    () => () => {
      started.current?.abort();
      started.current = null;
      setLoad({ kind: "idle" });
    },
    [source, pull],
  );

  const value = useMemo(
    () => ({ load, request, pull, ...(returnTo === undefined ? {} : { returnTo }) }),
    [load, request, pull, returnTo],
  );
  return <DiffContext value={value}>{children}</DiffContext>;
};
