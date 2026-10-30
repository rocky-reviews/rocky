import { type InboxItem } from "@rocky-reviews/core";
import { useCallback, useEffect, useState } from "react";
import { signInHref } from "../session.js";
import { useTheme } from "../shell/use-theme.js";
import { Inbox } from "./Inbox.js";
import { InboxLoadError, type InboxSource, parseInbox } from "./inbox-source.js";

type State =
  | { kind: "loading" }
  | { kind: "ready"; items: readonly InboxItem[] }
  | { kind: "signed_out" }
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
        (inbox) => !abort.signal.aborted && setState({ kind: "ready", items: inbox.items }),
        // The error may describe PR content; the page says only that it failed.
        (error: unknown) =>
          !abort.signal.aborted &&
          setState({
            kind:
              error instanceof InboxLoadError && error.reason === "signed_out"
                ? "signed_out"
                : "failed",
          }),
      );
    return () => abort.abort();
  }, [source, generation]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.kind === "ready")
    return (
      <Inbox
        items={state.items}
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
          <a href={signInHref("/inbox")}>Sign in with GitHub</a> to see your inbox.
        </p>
      ) : (
        <p role={state.kind === "failed" ? "alert" : "status"}>
          {state.kind === "failed" ? "The inbox could not be loaded." : "Loading…"}
        </p>
      )}
    </main>
  );
};
