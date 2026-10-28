/**
 * The diff and the reviewer's own comments, for every file view of the page (P6-3). The diff is
 * loaded once, on the first file opened, through the `DiffDataSource` port and validated with
 * `parseDiffData`. Own comments live in memory until drafts are persisted (P6-4) and posted by
 * Finish review (P6-6): nothing here sends anything anywhere.
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
import type { PullRef } from "../data/shell-data.js";
import type { OwnComment } from "./diff-model.js";

export type DiffLoad =
  | { readonly kind: "idle" | "loading" | "failed" }
  | { readonly kind: "ready"; readonly data: DiffData };

export type DiffContextValue = {
  readonly load: DiffLoad;
  /** Starts loading the diff if nothing has yet. */
  readonly request: () => void;
  readonly comments: readonly OwnComment[];
  readonly addComment: (path: string, line: number, body: string) => void;
  readonly deleteComment: (id: string) => void;
};

/** Without a provider there is no diff to show. */
export const DiffContext = createContext<DiffContextValue>({
  load: { kind: "failed" },
  request: () => {},
  comments: [],
  addComment: () => {},
  deleteComment: () => {},
});

export const useDiff = (): DiffContextValue => useContext(DiffContext);

/** GitHub's limit for a review comment body. */
export const MAX_COMMENT_CHARS = 65_536;

type Props = { source: DiffDataSource; pull: PullRef; children: ReactNode };

export const DiffProvider = ({ source, pull, children }: Props) => {
  const [load, setLoad] = useState<DiffLoad>({ kind: "idle" });
  const [comments, setComments] = useState<readonly OwnComment[]>([]);
  const started = useRef<AbortController | null>(null);
  const nextId = useRef(1);

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
        // The error may describe PR content; the view says only that it failed.
        () => !abort.signal.aborted && setLoad({ kind: "failed" }),
      );
  }, [source, pull]);

  // A different PR or source starts over (comments belong to one PR).
  useEffect(
    () => () => {
      started.current?.abort();
      started.current = null;
      setLoad({ kind: "idle" });
      setComments([]);
    },
    [source, pull],
  );

  const addComment = useCallback((path: string, line: number, body: string) => {
    const text = body.trim().slice(0, MAX_COMMENT_CHARS);
    if (text === "") return;
    const id = `c${nextId.current++}`;
    setComments((current) => [...current, { id, path, line, body: text }]);
  }, []);

  const deleteComment = useCallback(
    (id: string) => setComments((current) => current.filter((c) => c.id !== id)),
    [],
  );

  const value = useMemo(
    () => ({ load, request, comments, addComment, deleteComment }),
    [load, request, comments, addComment, deleteComment],
  );
  return <DiffContext value={value}>{children}</DiffContext>;
};
