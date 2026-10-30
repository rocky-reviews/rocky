/**
 * The top bar (POC `renderTop`): brand, PR title and number, status, repo and branches, size,
 * GitHub's approvals and comments, the View on GitHub link and the light/dark toggle, plus the
 * toggles that open the sidebar and right panel when the width hides them. P6-6: "Finish review"
 * with the count of comments waiting to be posted; it opens the finish modal (also ⌘/Ctrl+Enter).
 *
 * Every PR string is rendered as a React text child: React escapes it, nothing here builds HTML.
 * Each one sits in a <bdi>, so bidi controls in it (U+202E) cannot reorder the text around it.
 */
import { Fragment, useEffect, useId, useState } from "react";
import type { MyReview, PullSummary } from "../data/shell-data.js";
import { pullRequestUrl } from "../lib/github-url.js";
import { timeAgo } from "../lib/time.js";
import { useKeyboard, useKeyShortcut } from "../keyboard/KeyboardContext.js";
import type { Mode } from "../theme.js";
import { PanelIcon, SidebarIcon } from "./icons.js";
import { statusOf } from "./status.js";

export type Drawer = "files" | "panel";

type Props = {
  pull: PullSummary;
  myReview: MyReview | null;
  now: number;
  mode: Mode;
  onToggleMode: () => void;
  drawer: Drawer | null;
  onToggleDrawer: (drawer: Drawer) => void;
  /** Accepted drafts and own comments not yet posted (P6-6). */
  pending: number;
  onFinish: () => void;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const TopBar = ({
  pull,
  myReview,
  now,
  mode,
  onToggleMode,
  drawer,
  onToggleDrawer,
  pending,
  onFinish,
}: Props) => {
  const status = statusOf(pull.state, myReview);
  const url = pullRequestUrl(pull);
  const nextMode = mode === "dark" ? "light" : "dark";
  const { openHelp } = useKeyboard();
  const modeKey = useKeyShortcut("m");
  // ARIA names the physical keys: "?" is Shift+/ on a US keyboard (not "?" or "Shift+?").
  const helpKey = useKeyShortcut("Shift+/");

  return (
    <header className="topbar pr-bar">
      <button
        type="button"
        className="icon-btn toggle-files"
        aria-label="Files"
        aria-controls="sidebar"
        aria-expanded={drawer === "files"}
        data-drawer-toggle="files"
        onClick={() => onToggleDrawer("files")}
      >
        <SidebarIcon />
      </button>
      <div className="brand">
        <div className="brand-mark" aria-hidden="true" />
        <span className="hide-sm">Rocky Reviews</span>
      </div>
      <div className="pr-meta">
        <h1 className="pr-title">
          <span className="pr-title-text" title={pull.title}>
            <bdi>{pull.title}</bdi>
          </span>{" "}
          <span className="pr-number">#{pull.number}</span>
        </h1>
        <div className="pr-sub">
          <span className={`status-pill tone-${status.tone}`}>{status.label}</span>
          <span>
            <bdi>
              {pull.owner}/{pull.repo}
            </bdi>
          </span>
          <span className="hide-sm">
            {pull.author === null ? "Someone" : <bdi>@{pull.author}</bdi>} wants to merge{" "}
            <bdi className="branch">{pull.headRef}</bdi> →{" "}
            <bdi className="branch">{pull.baseRef}</bdi>
          </span>
          <span>
            <span className="add">+{pull.additions}</span>{" "}
            <span className="del">−{pull.deletions}</span> ·{" "}
            {plural(pull.changedFiles, "file", "files")}
          </span>
          <span className="hide-sm">updated {timeAgo(pull.updatedAt, now)}</span>
          <span className="gh-stats">
            <Approvals approvers={pull.approvers} />
            <span className="gh-stat">
              <span aria-hidden="true">💬 </span>
              {plural(pull.commentCount, "comment", "comments")}
            </span>
          </span>
          {url !== undefined && (
            <a className="gh-link" href={url} target="_blank" rel="noopener noreferrer">
              <span className="sr-only-sm">View on </span>GitHub <span aria-hidden="true">↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      </div>
      <button
        type="button"
        className="mode-btn hide-sm"
        aria-label={`Switch to ${nextMode} mode`}
        aria-keyshortcuts={modeKey}
        title={`Switch to ${nextMode} mode${modeKey === undefined ? "" : " (m)"}`}
        onClick={onToggleMode}
      >
        <span aria-hidden="true">{mode === "dark" ? "☀" : "☾"}</span>
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm shortcuts-btn"
        aria-label="Keyboard shortcuts"
        aria-haspopup="dialog"
        aria-keyshortcuts={helpKey}
        title="Keyboard shortcuts (?)"
        onClick={openHelp}
      >
        <kbd aria-hidden="true">?</kbd>
        <span className="shortcuts-label" aria-hidden="true">
          Shortcuts
        </span>
      </button>
      <button
        type="button"
        className="btn btn-primary finish-btn"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+Enter Control+Enter"
        onClick={onFinish}
      >
        <span className="label">Finish review</span>
        <span className="count" aria-hidden="true">
          {pending}
        </span>
        <span className="sr-only">
          , {pending} {pending === 1 ? "comment" : "comments"} to post
        </span>
      </button>
      <button
        type="button"
        className="icon-btn toggle-panel"
        aria-label="Review panel"
        aria-controls="review-panel"
        aria-expanded={drawer === "panel"}
        data-drawer-toggle="panel"
        onClick={() => onToggleDrawer("panel")}
      >
        <PanelIcon />
      </button>
    </header>
  );
};

/**
 * "✓ n approvals", with the approvers in a tooltip on hover and keyboard focus (WCAG 1.4.13:
 * Escape dismisses it however it opened, and the pointer can move onto it).
 */
const Approvals = ({ approvers }: { approvers: readonly string[] }) => {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hover || focus) && !dismissed;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Once neither hover nor focus holds it, the next hover or focus may open it again.
  useEffect(() => {
    if (!hover && !focus) setDismissed(false);
  }, [hover, focus]);

  const label = `✓ ${plural(approvers.length, "approval", "approvals")}`;
  if (approvers.length === 0) return <span className="gh-stat">{label}</span>;
  return (
    <span
      className="gh-stat has-tip"
      tabIndex={0}
      aria-describedby={id}
      data-open={open}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {label}
      <span role="tooltip" id={id} className="tip">
        <span className="tip-box">
          Approved by{" "}
          {approvers.map((login, i) => (
            <Fragment key={login}>
              {i > 0 && ", "}
              <bdi>@{login}</bdi>
            </Fragment>
          ))}
        </span>
      </span>
    </span>
  );
};
