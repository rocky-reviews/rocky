import type { MemoryListResponse } from "@rocky-reviews/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { signInHref } from "../session.js";
import { useTheme } from "../shell/use-theme.js";
import { Memory } from "./Memory.js";
import {
  MemoryLoadError,
  parseMemoryList,
  type MemoryRepoRef,
  type MemorySource,
} from "./memory-source.js";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: MemoryListResponse }
  | { kind: "signed_out" }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "failed" };

/**
 * Loads a repository's memory through the port and validates it here (the one place, so no
 * source can skip it). A reload after a change keeps the page on screen until the new list is in.
 * The address's names are only used to ask; the page shows the names the server answered.
 */
export const MemoryPage = ({
  source,
  repo,
  returnTo,
}: {
  source: MemorySource;
  repo: MemoryRepoRef;
  returnTo: string;
}) => {
  const { mode, toggle } = useTheme();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const live = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = parseMemoryList(
          await source.load(repo, signal === undefined ? {} : { signal }),
        );
        if (live.current && signal?.aborted !== true) setState({ kind: "ready", data });
      } catch (error) {
        // The error may describe PR content; the page says only why, as a fixed reason.
        if (live.current && signal?.aborted !== true)
          setState({ kind: error instanceof MemoryLoadError ? error.reason : "failed" });
      }
    },
    [source, repo],
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.kind === "ready")
    return (
      <Memory
        data={state.data}
        now={now}
        mode={mode}
        onToggleMode={toggle}
        source={source}
        repo={repo}
        onReload={() => load()}
      />
    );
  const inbox = <a href="/inbox">Go to your inbox</a>;
  return (
    <main className="status-page" id="main">
      {state.kind === "signed_out" ? (
        <p>
          <a href={signInHref(returnTo)}>Sign in with GitHub</a> to see this repository&rsquo;s
          project memory.
        </p>
      ) : state.kind === "not_found" ? (
        <p role="alert">
          This repository isn&rsquo;t in Rocky, or you can&rsquo;t read it on GitHub. {inbox}.
        </p>
      ) : state.kind === "unavailable" ? (
        <p role="alert">
          Repository access isn&rsquo;t available yet, so Rocky can&rsquo;t show this
          repository&rsquo;s memory. Try again later.
        </p>
      ) : (
        <p role={state.kind === "failed" ? "alert" : "status"}>
          {state.kind === "failed" ? "Project memory could not be loaded." : "Loading…"}
        </p>
      )}
    </main>
  );
};
