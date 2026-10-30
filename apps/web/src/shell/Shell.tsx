/**
 * The app shell (P6-1): top bar, sidebar, main column and right panel, laid out like the POC.
 * Below the POC's breakpoints the sidebar and right panel become drawers opened from the top
 * bar (POC defect 5: the POC just hid them). An open drawer is a modal dialog: the rest of the
 * page is inert, Tab cycles inside it, and Escape or a click outside closes it and returns
 * focus to its toggle. If the width grows until the panel shows in place, focus moves to it.
 * P6-5: the keyboard shortcuts (ADR 0030) and their dialog, a modal in the same way.
 */
import type { Finding } from "@rocky-reviews/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { focusMain } from "../briefing/focus.js";
import type { ReviewSource } from "../data/review-data.js";
import type { ShellData } from "../data/shell-data.js";
import { ReviewProvider } from "../drafts/ReviewProvider.js";
import { MainContent } from "./MainArea.js";
import { RightPanelContent } from "./RightPanel.js";
import { ToastProvider, useToast } from "./Toast.js";
import { type Selection, SidebarContent } from "./Sidebar.js";
import { type Drawer, TopBar } from "./TopBar.js";
import { coverage, noiseGroup, sidebarGroups } from "./triage-model.js";
import { PANEL_HIDDEN, SIDEBAR_HIDDEN, useMediaQuery } from "./use-media-query.js";
import { useTheme } from "./use-theme.js";
import { trapTab } from "./focus-trap.js";
import { reviewOrder } from "../diff/annotations.js";
import { KeyboardContext, type KeyboardContextValue } from "../keyboard/KeyboardContext.js";
import { readSingleKeys, saveSingleKeys } from "../keyboard/keymap.js";
import { ShortcutKeys } from "../keyboard/ShortcutKeys.js";
import { ShortcutsDialog } from "../keyboard/ShortcutsDialog.js";

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

/** P6-5: the entry points that later tasks fill (Ask: P9-2; Finish review: P6-6). */
export const NOT_YET = {
  ask: "Ask is not available yet.",
  finish: "Finish review is not available yet. Your decisions and comments are saved.",
} as const;

const storage = (): Storage => window.localStorage;

const ShellLayout = ({ data, now, review }: Props) => {
  const { mode, toggle } = useTheme();
  const toast = useToast();
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
  const order = useMemo(
    () => (data.analysis === null ? [] : reviewOrder(data.analysis)),
    [data.analysis],
  );

  // P6-5: single-key shortcuts on or off (WCAG 2.1.4), and the shortcuts dialog, which returns
  // focus to wherever it was opened from.
  const [singleKeys, setSingleKeysState] = useState(() =>
    typeof window === "undefined" ? true : readSingleKeys(storage),
  );
  const [help, setHelp] = useState(false);
  const helpReturn = useRef<Element | null>(null);
  const keyboard = useMemo<KeyboardContextValue>(
    () => ({
      singleKeys,
      setSingleKeys: (on) => {
        saveSingleKeys(storage, on);
        setSingleKeysState(on);
      },
      openHelp: () => {
        helpReturn.current = document.activeElement;
        setHelp(true);
      },
    }),
    [singleKeys],
  );
  const closeHelp = useCallback(() => setHelp(false), []);
  useEffect(() => {
    if (help || helpReturn.current === null) return;
    if (helpReturn.current instanceof HTMLElement) helpReturn.current.focus();
    helpReturn.current = null;
  }, [help]);
  const modal = overlay !== null || help;

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
    <KeyboardContext value={keyboard}>
      <ReviewProvider
        source={review}
        analysisId={data.analysis === null ? null : data.analysisId}
        analysisHead={data.analysis?.provenance.head.sha ?? null}
        findings={data.analysis?.findings ?? NO_FINDINGS}
        onOpenFile={jumpToFile}
      >
        <ShortcutKeys
          active={!modal}
          singleKeys={singleKeys}
          current={selection.kind === "file" ? selection.path : null}
          order={order}
          onOpen={(path) => {
            select(path === null ? { kind: "briefing" } : { kind: "file", path });
            focusMain();
          }}
          onToggleViewed={toggleViewed}
          onToggleMode={toggle}
          onHelp={keyboard.openHelp}
          onAsk={() => toast(NOT_YET.ask)}
          onFinish={() => toast(NOT_YET.finish)}
        />
        <div className="app">
          <div className="topbar-wrap" inert={modal}>
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
              inert={(overlay !== null && overlay !== "files") || help}
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
            <main id="main" className="col main" tabIndex={-1} inert={modal}>
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
              inert={(overlay !== null && overlay !== "panel") || help}
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
          {help && (
            <ShortcutsDialog
              singleKeys={singleKeys}
              onSingleKeys={keyboard.setSingleKeys}
              onClose={closeHelp}
            />
          )}
        </div>
      </ReviewProvider>
    </KeyboardContext>
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
