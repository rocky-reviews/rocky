import { useEffect, useState } from "react";
import {
  parseShellData,
  type PullRef,
  type ShellData,
  type ShellDataSource,
} from "./data/shell-data.js";
import type { ReviewPostingSource } from "./data/posting-data.js";
import type { ReviewSource } from "./data/review-data.js";
import { ShellLoadError, type ShellLoadReason } from "./data/shell-http-source.js";
import { signInHref } from "./session.js";
import { Shell } from "./shell/Shell.js";

type Props = {
  source: ShellDataSource;
  pull: PullRef;
  review: ReviewSource;
  posting: ReviewPostingSource;
  /** Where "Sign in with GitHub" comes back to (H4-2): this page's own path. */
  returnTo?: string;
};

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: ShellData }
  | { kind: "failed"; reason: ShellLoadReason };

/**
 * What the page says while it cannot show the PR (H4-2). Fixed text only: nothing from the
 * address or an answer is put on the page.
 */
export const LoadProblem = ({
  state,
  returnTo,
}: {
  state: Exclude<State, { kind: "ready" }>;
  returnTo?: string;
}) => {
  if (state.kind === "loading")
    return (
      <main className="status-page" id="main">
        <p role="status">Loading…</p>
      </main>
    );
  const inbox = <a href="/inbox">Go to your inbox</a>;
  switch (state.reason) {
    case "signed_out":
      return (
        <main className="status-page" id="main">
          <p>
            <a href={signInHref(returnTo)}>Sign in with GitHub</a> to see this pull request.
          </p>
        </main>
      );
    case "not_found":
      return (
        <main className="status-page" id="main">
          <p role="alert">
            This pull request isn&rsquo;t in Rocky, or you can&rsquo;t read its repository on
            GitHub. {inbox}.
          </p>
        </main>
      );
    case "unavailable":
      return (
        <main className="status-page" id="main">
          <p role="alert">
            Repository access isn&rsquo;t available yet, so Rocky can&rsquo;t show this pull
            request. Try again later.
          </p>
        </main>
      );
    case "failed":
      return (
        <main className="status-page" id="main">
          <p role="alert">This pull request could not be loaded.</p>
        </main>
      );
  }
};

/**
 * Loads the shell's data through the port, validates it here (the one place, so no source can
 * skip it) and keeps "updated N ago" current.
 */
export const App = ({ source, pull, review, posting, returnTo }: Props) => {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const abort = new AbortController();
    source
      .load(pull, { signal: abort.signal })
      .then(parseShellData)
      .then(
        (data) => !abort.signal.aborted && setState({ kind: "ready", data }),
        // The error may describe PR content; the page says only why, as a fixed reason.
        (error: unknown) =>
          !abort.signal.aborted &&
          setState({
            kind: "failed",
            reason: error instanceof ShellLoadError ? error.reason : "failed",
          }),
      );
    return () => abort.abort();
  }, [source, pull]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.kind === "ready")
    return <Shell data={state.data} now={now} review={review} posting={posting} />;
  return <LoadProblem state={state} {...(returnTo === undefined ? {} : { returnTo })} />;
};
