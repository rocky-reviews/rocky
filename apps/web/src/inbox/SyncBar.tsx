/**
 * The inbox's sync bar (P10-4, token mode only): when Rocky last read GitHub, a Sync button, and
 * what went wrong, if anything. A token-mode Rocky has no webhooks: opening the inbox starts a
 * sync on the server, and this is the way to ask for another. Problems are fixed text by code;
 * those a new token fixes link to the connection page.
 */
import type { InboxSync, SyncResponse } from "@rocky-reviews/core";
import { useState } from "react";
import { syncBar, syncProblemText } from "../connection/connection-model.js";
import type { Answer } from "../connection/connection-source.js";
import { timeAgo } from "../lib/time.js";

type Props = {
  sync: InboxSync;
  now: number;
  /** Starts a sync and loads the inbox again. */
  onSync: () => Promise<Answer<SyncResponse>>;
};

export const SyncBar = ({ sync, now, onSync }: Props) => {
  const [busy, setBusy] = useState(false);
  /** What the last Sync press answered, when it is not what the inbox shows anyway. */
  const [answer, setAnswer] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const bar = syncBar(sync);
  const running = busy || bar.kind === "running";

  const press = async () => {
    if (running) return;
    setBusy(true);
    setAnswer(null);
    setAnnouncement("Syncing with GitHub…");
    const result = await onSync();
    setBusy(false);
    if (result.kind !== "ok") {
      setAnnouncement("");
      setAnswer("The sync could not be started. Try again.");
    } else if (result.value.outcome === "synced") {
      setAnnouncement("Synced with GitHub.");
    } else if (result.value.outcome === "running") {
      // Goes on on the server; the inbox shows it running and asks again until it is done.
      setAnnouncement("Syncing with GitHub in the background…");
    } else {
      setAnnouncement("");
      setAnswer(syncProblemText(result.value.outcome, result.value.retryAt));
    }
  };

  const problem = answer ?? (bar.kind === "problem" ? bar.text : null);
  const replaceToken = answer === null && bar.kind === "problem" && bar.replaceToken;

  return (
    <section className="card sync-bar" aria-labelledby="sync-title">
      <h2 id="sync-title" className="sr-only">
        Sync with GitHub
      </h2>
      <div className="sync-row">
        <p className="sync-when">
          {running ? (
            <>
              <span className="sync-spinner" aria-hidden="true" />
              Syncing with GitHub…
            </>
          ) : sync.lastSyncedAt === null ? (
            "Not synced yet"
          ) : (
            `Last synced ${timeAgo(sync.lastSyncedAt, now)}`
          )}
        </p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void press()}
          {...(running ? { "aria-disabled": true } : {})}
        >
          <span aria-hidden="true">↻</span> Sync
        </button>
        <a className="sync-link" href="/connection">
          Repositories and token
        </a>
      </div>
      {problem !== null && (
        <p className="sync-alert" role="alert">
          {problem}
          {replaceToken && (
            <>
              {" "}
              <a href="/connection">Replace the token</a>
            </>
          )}
        </p>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
};
