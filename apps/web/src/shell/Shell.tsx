/**
 * The app shell (P6-1): top bar, sidebar, main column and right panel, laid out like the POC.
 * Below the POC's breakpoints the sidebar and right panel become drawers opened from the top
 * bar (POC defect 5: the POC just hid them). An open drawer is a modal dialog: the rest of the
 * page is inert, Tab cycles inside it, and Escape or a click outside closes it and returns
 * focus to its toggle. If the width grows until the panel shows in place, focus moves to it.
 */
import type { Finding } from "@rocky-reviews/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { focusMain } from "../briefing/focus.js";
import type { ReviewSource } from "../data/review-data.js";
import type { ShellData } from "../data/shell-data.js";
import { ReviewProvider } from "../drafts/ReviewProvider.js";
import { MainContent } from "./MainArea.js";
import { RightPanelContent } from "./RightPanel.js";
import { ToastProvider } from "./Toast.js";
import { type Selection, SidebarContent } from "./Sidebar.js";
import { type Drawer, TopBar } from "./TopBar.js";
import { coverage, noiseGroup, sidebarGroups } from "./triage-model.js";
import { PANEL_HIDDEN, SIDEBAR_HIDDEN, useMediaQuery } from "./use-media-query.js";
import { useTheme } from "./use-theme.js";

type Props = {
  data: ShellData;
  now: number;
  /** Where the reviewer's drafts and comments are kept (P6-4). */
  review: ReviewSource;
};

export const Shell = (props: Props) => (
  <ToastProvider>
    <ShellLayout {...props} />
  </ToastProvider>
);

const NO_FINDINGS: readonly Finding[] = [];

const ShellLayout = ({ data, now, review }: Props) => {
  const { mode, toggle } = useTheme();
  const [selection, setSelection] = useState<Selection>({ kind: "briefing" });
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const panelHidden = useMediaQuery(PANEL_HIDDEN);
  const sidebarHidden = useMediaQuery(SIDEBAR_HIDDEN);
  const overlay =
    (drawer === "files" && sidebarHidden) || (drawer === "panel" && panelHidden) ? drawer : null;

  const groups = useMemo(
    () => (data.analysis === null ? [] : sidebarGroups(data.analysis)),
    [data.analysis],
  );
  const noise = useMemo(
    () => (data.analysis === null ? { files: [], lines: 0 } : noiseGroup(data.analysis)),
    [data.analysis],
  );
  const cover = coverage(groups, viewed);

  // Focus moves into an opened drawer, and on close back to its toggle, or to the region
  // itself when a wider window now shows it in place (the toggle is hidden then).
  const returnFocus = useRef<string | null>(null);
  const closeDrawer = useCallback(
    (focusTarget?: string) => {
      if (drawer === null) return;
      returnFocus.current = focusTarget ?? `[data-drawer-toggle="${drawer}"]`;
      setDrawer(null);
    },
    [drawer],
  );
  useEffect(() => {
    if (drawer !== null) {
      document.querySelector<HTMLElement>(`[data-drawer-close="${drawer}"]`)?.focus();
    } else if (returnFocus.current !== null) {
      document.querySelector<HTMLElement>(returnFocus.current)?.focus();
      returnFocus.current = null;
    }
  }, [drawer]);

  // A drawer whose panel the width now shows in place is no longer a drawer.
  useEffect(() => {
    if (drawer !== null && overlay === null)
      closeDrawer(drawer === "files" ? "#sidebar" : "#review-panel");
  }, [drawer, overlay, closeDrawer]);

  useEffect(() => {
    if (overlay === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
      if (event.key === "Tab") trapTab(event, overlay === "files" ? "#sidebar" : "#review-panel");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay, closeDrawer]);

  const select = (next: Selection) => {
    setSelection(next);
    if (overlay === "files") closeDrawer();
  };

  // A file opened from the briefing (P6-2): the content under focus is replaced, so focus moves
  // to the main column, scrolled to the top. With a line (a finding badge on the change map,
  // P5-3), the diff then moves focus on to that line once it is rendered.
  const openFile = (path: string, line?: number) => {
    select({ kind: "file", path, line });
    focusMain();
  };

  const toggleViewed = (path: string) =>
    setViewed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const markViewed = (paths: readonly string[]) =>
    setViewed((current) => new Set([...current, ...paths]));

  // A jump from the review panel (P6-4): open the file; a panel shown as a drawer closes, and the
  // draft or line the jump aims at takes the focus once it is rendered.
  const jumpToFile = useCallback(
    (path: string) => {
      setSelection({ kind: "file", path });
      if (overlay !== null) {
        // No focus target here: the draft or line the jump aims at takes it once rendered.
        returnFocus.current = null;
        setDrawer(null);
      }
    },
    [overlay],
  );

  return (
    <ReviewProvider
      source={review}
      analysisId={data.analysis === null ? null : data.analysisId}
      analysisHead={data.analysis?.provenance.head.sha ?? null}
      findings={data.analysis?.findings ?? NO_FINDINGS}
      onOpenFile={jumpToFile}
    >
      <div className="app">
        <div className="topbar-wrap" inert={overlay !== null}>
          <a className="skip-link" href="#main">
            Skip to main content
          </a>
          <TopBar
            pull={data.pull}
            myReview={data.myReview}
            now={now}
            mode={mode}
            onToggleMode={toggle}
            drawer={drawer}
            onToggleDrawer={(which) => (drawer === which ? closeDrawer() : setDrawer(which))}
          />
        </div>
        <div className="body">
          <nav
            id="sidebar"
            className="col sidebar"
            tabIndex={-1}
            {...(overlay === "files"
              ? { role: "dialog", "aria-modal": true, "aria-labelledby": "drawer-title-files" }
              : { "aria-label": "Files" })}
            data-open={drawer === "files"}
            inert={overlay !== null && overlay !== "files"}
          >
            {drawer === "files" && (
              <DrawerHead title="Files" which="files" onClose={() => closeDrawer()} />
            )}
            {data.analysis === null ? (
              <p className="placeholder">Files appear here once the analysis is ready.</p>
            ) : (
              <SidebarContent
                groups={groups}
                noise={noise}
                unanalysed={data.analysis.provenance.unanalysed.map((f) => f.path)}
                coverage={cover}
                selection={selection}
                viewed={viewed}
                onSelect={select}
                onToggleViewed={toggleViewed}
                onMarkViewed={markViewed}
              />
            )}
          </nav>
          <main id="main" className="col main" tabIndex={-1} inert={overlay !== null}>
            <MainContent
              selection={selection}
              analysis={data.analysis}
              run={data.analysisRun}
              headSha={data.pull.headSha}
              onOpenFile={openFile}
              files={{ viewed, onToggleViewed: toggleViewed, onSelect: select }}
            />
          </main>
          <aside
            id="review-panel"
            className="panel"
            tabIndex={-1}
            {...(overlay === "panel"
              ? { role: "dialog", "aria-modal": true, "aria-labelledby": "drawer-title-panel" }
              : { "aria-label": "Review panel" })}
            data-open={drawer === "panel"}
            inert={overlay !== null && overlay !== "panel"}
          >
            {drawer === "panel" && (
              <DrawerHead title="Review panel" which="panel" onClose={() => closeDrawer()} />
            )}
            <RightPanelContent />
          </aside>
        </div>
        {overlay !== null && (
          <div className="scrim" aria-hidden="true" onClick={() => closeDrawer()} />
        )}
      </div>
    </ReviewProvider>
  );
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside the open drawer, wrapping at either end. */
const trapTab = (event: KeyboardEvent, container: string) => {
  const root = document.querySelector<HTMLElement>(container);
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !root.contains(active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
};

const DrawerHead = ({
  title,
  which,
  onClose,
}: {
  title: string;
  which: Drawer;
  onClose: () => void;
}) => (
  <div className="drawer-head">
    <h2 id={`drawer-title-${which}`}>{title}</h2>
    <button
      type="button"
      className="icon-btn"
      aria-label={`Close ${title.toLowerCase()}`}
      data-drawer-close={which}
      onClick={onClose}
    >
      <span aria-hidden="true">✕</span>
    </button>
  </div>
);
