import type { ConnectionResponse } from "@rocky-reviews/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../shell/use-theme.js";
import { SignIn } from "../SignIn.js";
import { Connection } from "./Connection.js";
import { SYNC_POLL_LIMIT, SYNC_POLL_MS } from "./connection-model.js";
import { ConnectionLoadError, type ConnectionSource } from "./connection-source.js";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: ConnectionResponse }
  | { kind: "signed_out" }
  | { kind: "app_mode" }
  | { kind: "failed" };

/**
 * Loads the connection page's data (P10-4) through the port, which validates it. Fixed text for
 * every other state; on a server connected with the GitHub App there is nothing to manage here.
 */
export const ConnectionPage = ({ source }: { source: ConnectionSource }) => {
  const { mode, toggle } = useTheme();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const live = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await source.load(signal === undefined ? {} : { signal });
        if (!live.current || signal?.aborted === true) return;
        setNow(Date.now());
        setState({ kind: "ready", data });
      } catch (error) {
        if (!live.current || signal?.aborted === true) return;
        setState({ kind: error instanceof ConnectionLoadError ? error.reason : "failed" });
      }
    },
    [source],
  );

  useEffect(() => {
    live.current = true;
    const abort = new AbortController();
    void load(abort.signal);
    return () => {
      live.current = false;
      abort.abort();
    };
  }, [load]);

  // While a sync runs on the server (after Sync or adding a repository), ask again a few times.
  const polls = useRef(0);
  const syncing = state.kind === "ready" && state.data.syncing;
  useEffect(() => {
    if (!syncing) {
      polls.current = 0;
      return undefined;
    }
    if (polls.current >= SYNC_POLL_LIMIT) return undefined;
    const timer = window.setTimeout(() => {
      polls.current += 1;
      void load();
    }, SYNC_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [syncing, state, load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.kind === "ready")
    return (
      <Connection
        data={state.data}
        now={now}
        mode={mode}
        onToggleMode={toggle}
        source={source}
        onReload={() => load()}
      />
    );
  return (
    <main className="status-page" id="main">
      {state.kind === "loading" ? (
        <p role="status">Loading…</p>
      ) : state.kind === "signed_out" ? (
        <p>
          <SignIn returnTo="/connection" rest="to manage Rocky's connection to GitHub." />
        </p>
      ) : state.kind === "app_mode" ? (
        <p>
          Rocky is connected to GitHub through the GitHub App: repositories are chosen where the app
          is installed, on GitHub. <a href="/inbox">Go to your inbox</a>.
        </p>
      ) : (
        <p role="alert">The connection could not be loaded. Reload the page to try again.</p>
      )}
    </main>
  );
};
