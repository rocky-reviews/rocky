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
  | { kind: "finished"; setupMode: boolean }
  | { kind: "failed" };

/** The last words after Finish: focused, so keyboard and screen reader users land on them. */
const Finished = ({ setupMode }: { setupMode: boolean }) => {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <p role="status" className="setup-finished" tabIndex={-1} ref={ref}>
      {setupMode ? (
        <>
          Setup is closed. Start Rocky again without the setup overlay (
          <code>docker compose -f deploy/docker-compose.yml up -d</code>; on bare metal, remove{" "}
          <code>ROCKY_SETUP</code> and restart). Rocky then serves the inbox and GitHub sign-in.
        </>
      ) : (
        <>
          Setup is closed. Remove <code>ROCKY_SETUP</code> from Rocky&rsquo;s configuration (with
          Docker Compose, start without <code>docker-compose.setup.yml</code>) and restart.{" "}
          <a href="/inbox">Go to your inbox</a>.
        </>
      )}
    </p>
  );
};

/** While setup is open the page checks again on its own, so installs and analyses show up. */
export const SETUP_REFRESH_MS = 15_000;

/**
 * Loads the setup status through the port and validates it here (P10-2). Fixed text for every
 * state but `ready`; nothing from the address is put on the page.
 */
export const SetupPage = ({ source }: { source: SetupSource }) => {
  const { mode, toggle } = useTheme();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [loadProblem, setLoadProblem] = useState(false);
  const live = useRef(true);
  /** A status was shown: a failed check keeps it (fix round, item 6). */
  const shown = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      try {
        const status = parseSetupStatus(await source.load(signal === undefined ? {} : { signal }));
        if (!live.current || signal?.aborted === true) return false;
        shown.current = true;
        setLoadProblem(false);
        setState({ kind: "ready", status });
        return true;
      } catch (error) {
        if (!live.current || signal?.aborted === true) return false;
        const reason = error instanceof SetupLoadError ? error.reason : "failed";
        // Only a lost session or a closed setup replaces the wizard; anything else is inline.
        if (reason === "failed" && shown.current) setLoadProblem(true);
        else setState({ kind: reason });
        return false;
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
        onFinished={() => setState({ kind: "finished", setupMode: state.status.mode === "setup" })}
        loadProblem={loadProblem}
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
        <Finished setupMode={state.setupMode} />
      ) : (
        <p role="alert">The setup status could not be loaded. Reload the page to try again.</p>
      )}
    </main>
  );
};
