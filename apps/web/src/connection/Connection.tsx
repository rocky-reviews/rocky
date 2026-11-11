/**
 * The connection page (P10-4, ADR 0045), token mode only: the saved token (described without
 * its value; replace or remove it), the repositories Rocky follows on it (add from what the
 * token can see; stop following), and the sync with GitHub. Not in the POC: built from the
 * inbox's page frame, cards, pills, buttons and confirmation dialog. Every string from the
 * server is a React text child (escaped); refusals are fixed text by code.
 */
import type {
  AddRepositoryResponse,
  ConnectionRepository,
  ConnectionResponse,
} from "@rocky-reviews/core";
import { useRef, useState } from "react";
import { timeAgo } from "../lib/time.js";
import { BrandMark } from "../shell/BrandMark.js";
import type { Mode } from "../theme.js";
import {
  needsNewToken,
  syncProblemText,
  syncReportText,
  tokenRefusalText,
} from "./connection-model.js";
import type { ConnectionSource } from "./connection-source.js";
import { ConfirmDialog, RepositoryPicker } from "./dialogs.js";
import { TokenForm } from "./TokenForm.js";
import { TokenSummary } from "./TokenSummary.js";

type Props = {
  data: ConnectionResponse;
  now: number;
  mode: Mode;
  onToggleMode: () => void;
  source: ConnectionSource;
  /** Loads the page's data again (after any change). */
  onReload: () => Promise<void>;
};

type Dialog =
  { kind: "remove_token" } | { kind: "unfollow"; repo: ConnectionRepository } | { kind: "add" };

/** A line the page shows (and announces) after an action; `alert` for problems. */
type Notice = { readonly text: string; readonly alert: boolean; readonly replaceToken?: boolean };

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const fullName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
const plural = (n: number, one: string, many: string) => `${n}\u00a0${n === 1 ? one : many}`;

export const Connection = ({ data, now, mode, onToggleMode, source, onReload }: Props) => {
  const [replacing, setReplacing] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tokenNotice, setTokenNotice] = useState<Notice | null>(null);
  const [repoNotice, setRepoNotice] = useState<Notice | null>(null);
  const [syncNotice, setSyncNotice] = useState<Notice | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Where focus goes back to when a dialog closes. */
  const opener = useRef<HTMLElement | null>(null);
  const nextMode = mode === "dark" ? "light" : "dark";
  const { token, repositories } = data;

  const open = (next: Dialog) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(next);
  };
  /** Focus back to the opener, or to `fallback` when the opener is gone (it was removed). */
  const closeDialog = (fallback = "main") => {
    setDialog(null);
    window.requestAnimationFrame(() => {
      const back = opener.current;
      opener.current = null;
      if (back !== null && back.isConnected) back.focus();
      else document.getElementById(fallback)?.focus();
    });
  };

  const saveToken = async (value: string): Promise<string | null> => {
    const answer = await source.saveToken(value);
    if (answer.kind !== "ok")
      return answer.kind === "refused"
        ? tokenRefusalText(answer.error, answer.retryAt)
        : "Rocky could not save the token. Try again.";
    setReplacing(false);
    setTokenNotice({ text: "Token saved. GitHub accepted it.", alert: false });
    await onReload();
    document.getElementById("token-title")?.focus();
    return null;
  };

  const removeToken = async (): Promise<string | null> => {
    const answer = await source.removeToken();
    if (answer.kind !== "ok" && !(answer.kind === "refused" && answer.error === "not_found"))
      return "The token could not be removed. Try again.";
    setTokenNotice({ text: "Token removed. Rocky no longer reads GitHub or posts.", alert: false });
    await onReload();
    return null;
  };

  const unfollow = async (repo: ConnectionRepository): Promise<string | null> => {
    const answer = await source.removeRepository(repo.id);
    if (answer.kind !== "ok" && !(answer.kind === "refused" && answer.error === "not_found"))
      return "Rocky could not stop following it. Try again.";
    setRepoNotice({ text: `Rocky no longer follows ${fullName(repo)}.`, alert: false });
    await onReload();
    return null;
  };

  const added = (result: AddRepositoryResponse) => {
    const report = syncReportText(result.sync);
    setRepoNotice({
      text: `Added ${fullName(result.repository)}. ${report}`,
      alert: result.sync.outcome !== "synced",
    });
    closeDialog();
    void onReload();
  };

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncNotice(null);
    const answer = await source.sync();
    setSyncing(false);
    if (answer.kind !== "ok") {
      setSyncNotice({ text: "The sync could not be started. Try again.", alert: true });
      return;
    }
    const { outcome, retryAt } = answer.value;
    setSyncNotice(
      outcome === "synced"
        ? { text: syncReportText(answer.value), alert: false }
        : {
            text: syncProblemText(outcome, retryAt),
            alert: true,
            replaceToken: needsNewToken(outcome),
          },
    );
    await onReload();
  };

  /** "Replace the token" after a sync GitHub refused: open the field and put focus in it. */
  const showReplace = () => {
    setReplacing(true);
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>('#token input[type="password"]')?.focus(),
    );
  };

  return (
    <div className="inbox-app connection-app">
      <div className="topbar-wrap">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="topbar">
          <a className="brand" href="/inbox" aria-label="Rocky Reviews: go to the inbox">
            <BrandMark />
            <span className="hide-sm">Rocky Reviews</span>
          </a>
          <div className="inbox-head">
            <h1 className="inbox-title">Connection</h1>
            <span className="inbox-sub">GitHub through a personal access token</span>
          </div>
          <a className="btn btn-sm connection-back" href="/inbox">
            Inbox
          </a>
          <button
            type="button"
            className="mode-btn"
            aria-label={`Switch to ${nextMode} mode`}
            title={`Switch to ${nextMode} mode`}
            onClick={onToggleMode}
          >
            <span aria-hidden="true">{mode === "dark" ? "☀" : "☾"}</span>
          </button>
        </header>
      </div>
      <main id="main" className="inbox-main connection-main" tabIndex={-1}>
        <section className="card connection-card" id="token" aria-labelledby="token-title">
          <h2 id="token-title" className="connection-title" tabIndex={-1}>
            Personal access token
          </h2>
          {token === null ? (
            <>
              <p className="connection-note">
                No token is saved: Rocky does not read GitHub or post reviews until you save one.
                Create a fine-grained token with Contents: Read and Pull requests: Read and write on
                the repositories Rocky should review.
              </p>
              <div className="connection-actions">
                <a className="btn" href={NEW_TOKEN_URL}>
                  Create a token on GitHub <span aria-hidden="true">↗</span>
                </a>
              </div>
              <TokenForm
                label="Personal access token"
                submitLabel="Save token"
                busyLabel="Saving…"
                onSubmit={saveToken}
              />
            </>
          ) : (
            <>
              <TokenSummary token={token} now={now} />
              <div className="connection-actions">
                <button
                  type="button"
                  className="btn"
                  aria-expanded={replacing}
                  aria-controls="token-replace"
                  onClick={() => setReplacing((r) => !r)}
                >
                  Replace token
                </button>
                <button
                  type="button"
                  className="btn btn-danger-ghost"
                  onClick={() => open({ kind: "remove_token" })}
                >
                  Remove token
                </button>
              </div>
              <div id="token-replace" hidden={!replacing}>
                {replacing && (
                  <TokenForm
                    label="New personal access token"
                    submitLabel="Save"
                    busyLabel="Saving…"
                    hint="The new token must belong to the same GitHub user. The old one is forgotten once GitHub accepts this one."
                    onSubmit={saveToken}
                    autoFocus
                  />
                )}
              </div>
            </>
          )}
          <NoticeLine notice={tokenNotice} />
        </section>

        <section className="card connection-card" aria-labelledby="repos-title">
          <div className="connection-head">
            <h2 id="repos-title" className="connection-title" tabIndex={-1}>
              Repositories <span className="inbox-count">{repositories.length}</span>
            </h2>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => open({ kind: "add" })}
            >
              Add repository
            </button>
          </div>
          {repositories.length === 0 ? (
            <p className="connection-note">
              Rocky follows no repository yet. Add one the token can read.
            </p>
          ) : (
            <ul className="connection-repos">
              {repositories.map((repo) => (
                <li key={repo.id} className="connection-repo">
                  <span className="connection-repo-name">
                    <bdi>{fullName(repo)}</bdi>
                    {repo.private && <span className="status-pill tone-low">Private</span>}
                  </span>
                  <span className="connection-repo-meta">
                    {plural(repo.openPullRequests, "open pull request", "open pull requests")} ·{" "}
                    {repo.lastSyncedAt === null
                      ? "not synced yet"
                      : `synced ${timeAgo(repo.lastSyncedAt, now)}`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={`Stop following ${fullName(repo)}`}
                    onClick={() => open({ kind: "unfollow", repo })}
                  >
                    Stop following
                  </button>
                </li>
              ))}
            </ul>
          )}
          <NoticeLine notice={repoNotice} />
        </section>

        <section className="card connection-card" aria-labelledby="sync-title">
          <h2 id="sync-title" className="connection-title">
            Sync with GitHub
          </h2>
          <p className="connection-note">
            Rocky has no webhooks in token mode: it reads GitHub when you open the inbox or press
            Sync.{" "}
            {data.analysisAuto
              ? "New pull requests and new commits are analysed automatically."
              : "New pull requests are listed but not analysed automatically (ROCKY_ANALYSIS_AUTO=off): open one and choose Analyze."}
          </p>
          <div className="connection-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void sync()}
              {...(syncing ? { "aria-disabled": true } : {})}
            >
              <span aria-hidden="true">↻</span> {syncing ? "Syncing…" : "Sync now"}
            </button>
            <span className="connection-when">
              {data.lastSyncedAt === null
                ? "Not synced yet"
                : `Last synced ${timeAgo(data.lastSyncedAt, now)}`}
            </span>
          </div>
          <NoticeLine notice={syncNotice} onReplaceToken={showReplace} />
        </section>
      </main>
      {dialog?.kind === "remove_token" && (
        <ConfirmDialog
          title="Remove the token?"
          confirmLabel="Remove token"
          busyLabel="Removing…"
          onConfirm={removeToken}
          onClose={() => closeDialog("token-title")}
        >
          <p>
            Rocky forgets the token. Until you save a new one it stops reading GitHub and cannot
            post reviews. The repositories it follows and their analyses stay.
          </p>
          <p>To cut access on GitHub&rsquo;s side too, revoke the token there.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === "unfollow" && (
        <ConfirmDialog
          title={`Stop following ${fullName(dialog.repo)}?`}
          confirmLabel="Stop following"
          busyLabel="Stopping…"
          onConfirm={() => unfollow(dialog.repo)}
          onClose={() => closeDialog("repos-title")}
        >
          <p>
            Rocky stops reading its pull requests. Nothing changes on GitHub; you can add it again
            later.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === "add" && (
        <RepositoryPicker source={source} onAdded={added} onClose={() => closeDialog()} />
      )}
    </div>
  );
};

/** The result of the last action in a card. Problems are alerts; the rest a polite status. */
const NoticeLine = ({
  notice,
  onReplaceToken,
}: {
  notice: Notice | null;
  onReplaceToken?: () => void;
}) => (
  <>
    <p className="connection-notice" role="status">
      {notice !== null && !notice.alert ? notice.text : ""}
    </p>
    {notice?.alert === true && (
      <p className="connection-notice is-alert" role="alert">
        {notice.text}
        {notice.replaceToken === true && onReplaceToken !== undefined && (
          <>
            {" "}
            <a
              href="#token"
              onClick={(event) => {
                event.preventDefault();
                onReplaceToken();
              }}
            >
              Replace the token
            </a>
          </>
        )}
      </p>
    )}
  </>
);
