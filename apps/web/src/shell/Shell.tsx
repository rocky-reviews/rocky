/**
 * The app shell (P6-1): top bar, sidebar, main column and right panel, laid out like the POC.
 * Below the POC's breakpoints the sidebar and right panel become drawers opened from the top
 * bar (POC defect 5: the POC just hid them). An open drawer makes the rest of the page inert
 * and closes on Escape or a click outside, returning focus to its toggle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShellData } from "../data/shell-data.js";
import { MainContent } from "./MainArea.js";
import { RightPanelContent } from "./RightPanel.js";
import { type Selection, SidebarContent } from "./Sidebar.js";
import { type Drawer, TopBar } from "./TopBar.js";
import { coverage, noiseGroup, sidebarGroups } from "./triage-model.js";
import { PANEL_HIDDEN, SIDEBAR_HIDDEN, useMediaQuery } from "./use-media-query.js";
import { useTheme } from "./use-theme.js";

type Props = { data: ShellData; now: number };

export const Shell = ({ data, now }: Props) => {
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

  // Focus moves into an opened drawer and back to its toggle when it closes.
  const returnFocus = useRef<Drawer | null>(null);
  const closeDrawer = useCallback(() => {
    returnFocus.current = drawer;
    setDrawer(null);
  }, [drawer]);
  useEffect(() => {
    if (drawer !== null) {
      document.querySelector<HTMLElement>(`[data-drawer-close="${drawer}"]`)?.focus();
    } else if (returnFocus.current !== null) {
      document.querySelector<HTMLElement>(`[data-drawer-toggle="${returnFocus.current}"]`)?.focus();
      returnFocus.current = null;
    }
  }, [drawer]);

  // A drawer whose panel the width now shows in place is no longer a drawer.
  useEffect(() => {
    if (drawer !== null && overlay === null) setDrawer(null);
  }, [drawer, overlay]);

  useEffect(() => {
    if (overlay === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay, closeDrawer]);

  const select = (next: Selection) => {
    setSelection(next);
    if (overlay === "files") closeDrawer();
  };

  const toggleViewed = (path: string) =>
    setViewed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const markViewed = (paths: readonly string[]) =>
    setViewed((current) => new Set([...current, ...paths]));

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className="topbar-wrap" inert={overlay !== null}>
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
          aria-label="Files"
          data-open={drawer === "files"}
          inert={overlay !== null && overlay !== "files"}
        >
          {drawer === "files" && <DrawerHead title="Files" which="files" onClose={closeDrawer} />}
          {data.analysis === null ? (
            <p className="placeholder">Files appear here once the analysis is ready.</p>
          ) : (
            <SidebarContent
              groups={groups}
              noise={noise}
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
          <MainContent selection={selection} analysis={data.analysis} />
        </main>
        <aside
          id="review-panel"
          className="panel"
          aria-label="Review panel"
          data-open={drawer === "panel"}
          inert={overlay !== null && overlay !== "panel"}
        >
          {drawer === "panel" && (
            <DrawerHead title="Review panel" which="panel" onClose={closeDrawer} />
          )}
          <RightPanelContent />
        </aside>
      </div>
      {overlay !== null && <div className="scrim" aria-hidden="true" onClick={closeDrawer} />}
    </div>
  );
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
    <span>{title}</span>
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
