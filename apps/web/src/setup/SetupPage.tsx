import type { SetupStatusResponse } from "@rocky-reviews/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../shell/use-theme.js";
import { Setup } from "./Setup.js";
import { parseSetupStatus, SetupLoadError, type SetupSource } from "./setup-source.js";

type State =
  | { kind: "loading" }
  | { kind: "ready"; status: SetupStatusResponse }
  | { kind: "no_session" }
  | { kind: "closed" }
  | { kind: "finished" }
  | { kind: "failed" };

/** While setup is open the page checks again on its own, so installs and analyses show up. */
export const SETUP_REFRESH_MS = 15_000;

/**
 * Loads the setup status through the port and validates it here (P10-2). Fixed text for every
 * state but `ready`; nothing from the address is put on the page.
 */
export const SetupPage = ({ source }: { source: SetupSource }) => {
  const { mode, toggle } = useTheme();
  const [state, setState] = useState<State>({ kind: "loading" });
  const live = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const status = parseSetupStatus(await source.load(signal === undefined ? {} : { signal }));
        if (live.current && signal?.aborted !== true) setState({ kind: "ready", status });
      } catch (error) {
        if (live.current && signal?.aborted !== true)
          setState({ kind: error instanceof SetupLoadError ? error.reason : "failed" });
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

  const ready = state.kind === "ready";
  useEffect(() => {
    if (!ready) return undefined;
    const timer = window.setInterval(() => void load(), SETUP_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [ready, load]);

  if (state.kind === "ready")
    return (
      <Setup
        status={state.status}
        mode={mode}
        onToggleMode={toggle}
        source={source}
        onReload={() => load()}
        onFinished={() => setState({ kind: "finished" })}
      />
    );
  return (
    <main className="status-page" id="main">
      {state.kind === "loading" ? (
        <p role="status">Loading…</p>
      ) : state.kind === "no_session" ? (
        <p role="alert">
          Open the one-time setup link printed in the server&rsquo;s log (it starts with{" "}
          <code>/setup/start</code>). If you already used it, restart the server to get a new one.
        </p>
      ) : state.kind === "closed" ? (
        <p role="alert">
          Setup is closed on this server. To open it again, set <code>ROCKY_SETUP=true</code> and
          restart Rocky.
        </p>
      ) : state.kind === "finished" ? (
        <p role="status">
          Setup is closed. Remove <code>ROCKY_SETUP</code> from Rocky&rsquo;s configuration (with
          Docker Compose, start without <code>docker-compose.setup.yml</code>) and restart.{" "}
          <a href="/inbox">Go to your inbox</a>.
        </p>
      ) : (
        <p role="alert">The setup status could not be loaded. Reload the page to try again.</p>
      )}
    </main>
  );
};
