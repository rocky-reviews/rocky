/**
 * The top bar (POC `renderTop`): brand, PR title and number, status, repo and branches, size,
 * GitHub's approvals and comments, the View on GitHub link and the light/dark toggle, plus the
 * toggles that open the sidebar and right panel when the width hides them.
 *
 * Every PR string is rendered as a React text child: React escapes it, nothing here builds HTML.
 */
import { useId, useState } from "react";
import type { MyReview, PullSummary } from "../data/shell-data.js";
import { pullRequestUrl } from "../lib/github-url.js";
import { timeAgo } from "../lib/time.js";
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
}: Props) => {
  const status = statusOf(pull.state, myReview);
  const url = pullRequestUrl(pull);
  const nextMode = mode === "dark" ? "light" : "dark";

  return (
    <header className="topbar">
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
          {pull.title} <span className="pr-number">#{pull.number}</span>
        </h1>
        <div className="pr-sub">
          <span className={`status-pill tone-${status.tone}`}>{status.label}</span>
          <span>
            {pull.owner}/{pull.repo}
          </span>
          <span className="hide-sm">
            {pull.author === null ? "Someone" : `@${pull.author}`} wants to merge{" "}
            <span className="branch">{pull.headRef}</span> →{" "}
            <span className="branch">{pull.baseRef}</span>
          </span>
          <span>
            <span className="add">+{pull.additions}</span>{" "}
            <span className="del">−{pull.deletions}</span> ·{" "}
            {plural(pull.changedFiles, "file", "files")}
          </span>
          <span className="hide-sm">updated {timeAgo(pull.updatedAt, now)}</span>
          <Approvals approvers={pull.approvers} />
          <span className="gh-stat">
            <span aria-hidden="true">💬 </span>
            {plural(pull.commentCount, "comment", "comments")}
          </span>
          {url !== undefined && (
            <a className="gh-link" href={url} target="_blank" rel="noopener noreferrer">
              View on GitHub <span aria-hidden="true">↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      </div>
      <button
        type="button"
        className="mode-btn"
        aria-label={`Switch to ${nextMode} mode`}
        title={`Switch to ${nextMode} mode`}
        onClick={onToggleMode}
      >
        <span aria-hidden="true">{mode === "dark" ? "☀" : "☾"}</span>
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

/** "✓ n approvals", with the approvers in a tooltip on hover and keyboard focus. */
const Approvals = ({ approvers }: { approvers: readonly string[] }) => {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  const label = `✓ ${plural(approvers.length, "approval", "approvals")}`;
  if (approvers.length === 0) return <span className="gh-stat">{label}</span>;
  return (
    <span
      className="gh-stat has-tip"
      tabIndex={0}
      aria-describedby={id}
      data-dismissed={dismissed}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDismissed(true);
      }}
      onBlur={() => setDismissed(false)}
      onMouseLeave={() => setDismissed(false)}
    >
      {label}
      <span role="tooltip" id={id} className="tip">
        Approved by {approvers.map((login) => `@${login}`).join(", ")}
      </span>
    </span>
  );
};
