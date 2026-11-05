/**
 * The diff, for every file view of the page (P6-3). It is loaded once through the
 * `DiffDataSource` port and validated with `parseDiffData` (`diff-loader.ts`): on the first file
 * opened, or earlier, when the briefing is shown, on a page that preloads (H4-16). The reviewer's own
 * comments are kept on the server with the drafts (P6-4, `drafts/ReviewProvider.tsx`).
 * H4-3: a load that fails carries a fixed reason (the server's refusal, or `failed` for
 * anything else, an unreadable answer included), so the file view can say why.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { DiffDataSource } from "../data/diff-data.js";
import type { PullRef } from "../data/shell-data.js";
import { createDiffLoader, type DiffLoad } from "./diff-loader.js";

export type { DiffLoadReason } from "../data/diff-http-source.js";
export type { DiffLoad } from "./diff-loader.js";

export type DiffContextValue = {
  readonly load: DiffLoad;
  /** Starts loading the diff if nothing has yet (a file view opens). */
  readonly request: () => void;
  /**
   * H4-16: starts loading the diff early, when the briefing is shown, on a page that preloads
   * (a server source); otherwise nothing. A failure shows nothing until a file is opened.
   */
  readonly preload: () => void;
  /** The PR the diff belongs to (validated names), for a link to the whole diff on GitHub. */
  readonly pull: PullRef | null;
  /** Where "Sign in with GitHub" comes back to after a dead session: this page's own path. */
  readonly returnTo?: string;
};

const nothing = () => {};

/** Without a provider there is no diff to show. */
export const DiffContext = createContext<DiffContextValue>({
  load: { kind: "failed", reason: "failed" },
  request: nothing,
  preload: nothing,
  pull: null,
});

export const useDiff = (): DiffContextValue => useContext(DiffContext);

/** GitHub's limit for a review comment body. */
export const MAX_COMMENT_CHARS = 65_536;

type Props = {
  source: DiffDataSource;
  pull: PullRef;
  returnTo?: string;
  /** H4-16: load when the briefing is shown, not only when a file opens (a server source). */
  preload?: boolean;
  children: ReactNode;
};

export const DiffProvider = ({ source, pull, returnTo, preload = false, children }: Props) => {
  const [load, setLoad] = useState<DiffLoad>({ kind: "idle" });
  // A different PR or source starts over: its own loader, the old one's answers dropped.
  const loader = useMemo(() => createDiffLoader(source, pull, setLoad), [source, pull]);
  useEffect(
    () => () => {
      loader.dispose();
      setLoad({ kind: "idle" });
    },
    [loader],
  );

  const value = useMemo(
    () => ({
      load,
      request: loader.request,
      preload: preload ? loader.preload : nothing,
      pull,
      ...(returnTo === undefined ? {} : { returnTo }),
    }),
    [load, loader, preload, pull, returnTo],
  );
  return <DiffContext value={value}>{children}</DiffContext>;
};
