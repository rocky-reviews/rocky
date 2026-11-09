/**
 * The right panel's frame: two tabs as in the POC, Review (P6-4, with the shortcut strip under
 * it, P6-5) and ✦ Ask (P9-2). Both stay mounted, so switching keeps the drafts' scroll and the
 * questions asked; the hidden one is `hidden`. The tabs follow the ARIA tabs pattern: ←/→ (and
 * Home/End) move between them, Tab goes into the shown panel.
 */
import type { KeyboardEvent } from "react";
import { AskPanelContent } from "../ask/AskPanel.js";
import type { AskSelection, AskSource } from "../ask/ask-data.js";
import type { PullRef } from "../data/shell-data.js";
import { ReviewPanelContent, undecidedCount } from "../drafts/ReviewPanel.js";
import { useReview } from "../drafts/ReviewProvider.js";
import { ShortcutStrip } from "../keyboard/ShortcutStrip.js";

export type PanelTab = "review" | "ask";

export interface AskPanelProps {
  readonly source: AskSource;
  readonly pull: PullRef;
  readonly selection: AskSelection | null;
  readonly onClearSelection: () => void;
  readonly focusRequest: number;
}

const TABS: readonly PanelTab[] = ["review", "ask"];

/**
 * `current`: the file on screen, or null on the briefing; `files`: the sidebar's order (H4-14:
 * the open file's drafts first, then the next files').
 */
export const RightPanelContent = ({
  current,
  files,
  tab,
  onTab,
  ask,
}: {
  current: string | null;
  files: readonly string[];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  ask: AskPanelProps;
}) => {
  const count = undecidedCount(useReview());
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.indexOf(tab);
    const to =
      event.key === "ArrowRight"
        ? TABS[(at + 1) % TABS.length]
        : event.key === "ArrowLeft"
          ? TABS[(at - 1 + TABS.length) % TABS.length]
          : event.key === "Home"
            ? TABS[0]
            : event.key === "End"
              ? TABS.at(-1)
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    onTab(to);
    document.getElementById(`panel-tab-${to}`)?.focus();
  };
  const tabProps = (which: PanelTab) => ({
    type: "button" as const,
    role: "tab",
    id: `panel-tab-${which}`,
    "aria-selected": tab === which,
    "aria-controls": `panel-pane-${which}`,
    tabIndex: tab === which ? 0 : -1,
    className: `panel-tab${tab === which ? " is-selected" : ""}`,
    onClick: () => onTab(which),
  });
  return (
    <>
      <div className="panel-head" role="tablist" aria-label="Review and Ask" onKeyDown={onKeyDown}>
        <button {...tabProps("review")}>
          Review
          {count !== null && count > 0 && (
            <span className="panel-count">
              {" "}
              · {count}
              <span className="sr-only"> AI drafts to decide</span>
            </span>
          )}
        </button>
        <button {...tabProps("ask")}>
          <span className="ask-mark" aria-hidden="true">
            ✦
          </span>{" "}
          Ask
        </button>
      </div>
      <div
        className="panel-pane"
        role="tabpanel"
        id="panel-pane-review"
        aria-labelledby="panel-tab-review"
        hidden={tab !== "review"}
      >
        <ReviewPanelContent current={current} files={files} head={false} />
        <ShortcutStrip />
      </div>
      <div
        className="panel-pane"
        role="tabpanel"
        id="panel-pane-ask"
        aria-labelledby="panel-tab-ask"
        hidden={tab !== "ask"}
      >
        <AskPanelContent {...ask} active={tab === "ask"} />
      </div>
    </>
  );
};
