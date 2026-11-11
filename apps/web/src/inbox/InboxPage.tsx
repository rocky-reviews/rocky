import { type InboxItem, type InboxSync } from "@rocky-reviews/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { SYNC_POLL_LIMIT, SYNC_POLL_MS } from "../connection/connection-model.js";
import { SignIn } from "../SignIn.js";
import { useTheme } from "../shell/use-theme.js";
import { Inbox } from "./Inbox.js";
import { InboxLoadError, type InboxSource, parseInbox } from "./inbox-source.js";

type State =
  | { kind: "loading" }
  /** `sync`: token mode only (P10-4). */
  | { kind: "ready"; items: readonly InboxItem[]; sync: InboxSync | undefined }
  | { kind: "signed_out" }
  | { kind: "unavailable" }
  | { kind: "failed" };

/**
 * Loads the inbox through the port, validates it here (the one place, so no source can skip
 * it) and keeps "updated N ago" current.
 */
export const InboxPage = ({ source }: { source: InboxSource }) => {
  const { mode, toggle } = useTheme();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    const abort = new AbortController();
    source
      .load({ signal: abort.signal })
      .then(parseInbox)
      .then(
        (inbox) =>
          !abort.signal.aborted &&
          setState({ kind: "ready", items: inbox.items, sync: inbox.sync }),
        // The error may describe PR content; the page says only that it failed.
        (error: unknown) =>
          !abort.signal.aborted &&
          setState({ kind: error instanceof InboxLoadError ? error.reason : "failed" }),
      );
    return () => abort.abort();
  }, [source, generation]);

  // P10-4: while the sync the server started is running, ask again a few times, then stop.
  const polls = useRef(0);
  const syncing = state.kind === "ready" && state.sync?.state === "running";
  useEffect(() => {
    if (!syncing) {
      polls.current = 0;
      return undefined;
    }
    if (polls.current >= SYNC_POLL_LIMIT) return undefined;
    const timer = window.setTimeout(() => {
      polls.current += 1;
      reload();
    }, SYNC_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [syncing, generation, reload]);

  const sync = useCallback(async () => {
    const answer = await source.sync();
    polls.current = 0;
    setNow(Date.now());
    reload();
    return answer;
  }, [source, reload]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.kind === "ready")
    return (
      <Inbox
        items={state.items}
        sync={state.sync}
        onSync={sync}
        now={now}
        mode={mode}
        onToggleMode={toggle}
        source={source}
        onReload={reload}
      />
    );
  return (
    <main className="status-page" id="main">
      {state.kind === "signed_out" ? (
        <p>
          <SignIn returnTo="/inbox" rest="to see your inbox." />
        </p>
      ) : state.kind === "unavailable" ? (
        <p role="alert">
          Repository access isn&rsquo;t available yet, so Rocky can&rsquo;t list pull requests. Try
          again later.
        </p>
      ) : (
        <p role={state.kind === "failed" ? "alert" : "status"}>
          {state.kind === "failed" ? "The inbox could not be loaded." : "Loading…"}
        </p>
      )}
    </main>
  );
};
