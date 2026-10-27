import { useEffect, useState } from "react";
import {
  parseShellData,
  type PullRef,
  type ShellData,
  type ShellDataSource,
} from "./data/shell-data.js";
import { Shell } from "./shell/Shell.js";

type Props = { source: ShellDataSource; pull: PullRef };

type State = { kind: "loading" } | { kind: "ready"; data: ShellData } | { kind: "failed" };

/**
 * Loads the shell's data through the port, validates it here (the one place, so no source can
 * skip it) and keeps "updated N ago" current.
 */
export const App = ({ source, pull }: Props) => {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const abort = new AbortController();
    source
      .load(pull, { signal: abort.signal })
      .then(parseShellData)
      .then(
        (data) => !abort.signal.aborted && setState({ kind: "ready", data }),
        // The error may describe PR content; the page says only that it failed.
        () => !abort.signal.aborted && setState({ kind: "failed" }),
      );
    return () => abort.abort();
  }, [source, pull]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.kind === "ready") return <Shell data={state.data} now={now} />;
  return (
    <main className="status-page" id="main">
      <p role={state.kind === "failed" ? "alert" : "status"}>
        {state.kind === "failed" ? "This pull request could not be loaded." : "Loading…"}
      </p>
    </main>
  );
};
