/**
 * The page's one keydown listener for shortcuts (P6-5, ADR 0030). Rendered inside the review
 * provider so i/u and a/e/d go through the same paths as the mouse: i/u are the right panel's
 * jump to a draft, in the panel's order (H4-14: the open file's first), and a/e/d press the
 * focused draft card's own Accept/Edit/Dismiss button, so whatever guards the card has (a
 * disabled or missing button) apply to the key too. H4-14: a/e/d act only while that card is on
 * screen; off screen they do nothing (their hints are hidden then too). Like the panel, they do
 * nothing until the review state is loaded or when the drafts are hidden because the diff is
 * from a newer push than the analysis.
 *
 * H4-14: ↑/↓ scroll the main column from outside it, unless the focus is in a widget with its
 * own arrow keys (`arrowsScrollFile`).
 */
import { useEffect, useRef } from "react";
import { panelOrder } from "../drafts/ReviewPanel.js";
import { type ReviewContextValue, useReview } from "../drafts/ReviewProvider.js";
import { cardOnScreen } from "./draft-on-screen.js";
import {
  arrowsScrollFile,
  type FocusChainItem,
  isTextEntry,
  scrollStepFor,
  type ShortcutAction,
  shortcutFor,
  stepDraft,
  stepFile,
} from "./keymap.js";

type Props = {
  /** False while a modal (drawer, dialog) is open: nothing fires behind it. */
  active: boolean;
  singleKeys: boolean;
  /** The file on screen, or null on the briefing. */
  current: string | null;
  /** k/j order: the sidebar's, noise last. */
  order: readonly string[];
  onOpen: (path: string | null) => void;
  onToggleViewed: (path: string) => void;
  onToggleMode: () => void;
  onHelp: () => void;
  /** H4-12: opens the change tree. */
  onTree: () => void;
  onAsk: () => void;
  onFinish: () => void;
};

const ROLE = { accept: "accept", edit: "edit", dismiss: "dismiss" } as const;

/** The panel's jump items are enabled (P6-4): state loaded, diff of the analysed commit. */
const draftsShown = (r: ReviewContextValue): boolean => r.status === "ready" && !r.stale;

export const ShortcutKeys = (props: Props) => {
  const review = useReview();
  const latest = useRef({ props, review });
  latest.current = { props, review };

  useEffect(() => {
    if (!props.active) return;
    const run = (action: ShortcutAction): boolean => {
      const { props: p, review: r } = latest.current;
      switch (action) {
        case "nextFile":
        case "prevFile": {
          const to = stepFile(p.order, p.current, action === "nextFile" ? 1 : -1);
          if (to !== p.current) p.onOpen(to);
          return true;
        }
        case "nextDraft":
        case "prevDraft": {
          if (!draftsShown(r)) return true;
          const ids = panelOrder(r.findings, p.current, p.order).map((f) => f.id);
          const undecided = (id: string) =>
            r.decisionOf(id).state === "draft" && r.postedOf(id) === null;
          const to = stepDraft(ids, undecided, r.focused, action === "nextDraft" ? 1 : -1);
          if (to !== undefined) r.jumpToFinding(to);
          return true;
        }
        case "accept":
        case "edit":
        case "dismiss": {
          if (!draftsShown(r)) return true;
          const finding = r.findings.find((f) => f.id === r.focused);
          if (finding === undefined || finding.path !== p.current) return true;
          const card = document.querySelector(`[data-finding="${CSS.escape(finding.id)}"]`);
          // H4-14: the reviewer must see the draft they decide; off screen the key does nothing.
          if (card === null || !cardOnScreen(card)) return true;
          // No such button (the card is being edited or dismissed): the key does nothing.
          const button = card.querySelector<HTMLButtonElement>(`[data-role="${ROLE[action]}"]`);
          if (button !== null && !button.disabled) button.click();
          return true;
        }
        case "viewed":
          if (p.current !== null) p.onToggleViewed(p.current);
          return true;
        case "briefing":
          p.onOpen(null);
          return true;
        case "mode":
          p.onToggleMode();
          return true;
        case "help":
          p.onHelp();
          return true;
        case "tree":
          p.onTree();
          return true;
        case "ask":
          p.onAsk();
          return true;
        case "finish":
          p.onFinish();
          return true;
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (isTextEntry(target)) return;
      const chain: FocusChainItem[] = [];
      const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
      for (let el = arrow ? target : null; el !== null; el = el.parentElement)
        chain.push({
          tagName: el.tagName,
          role: el.getAttribute("role"),
          type: el.getAttribute("type") ?? "",
          id: el.id,
        });
      const step = arrow ? scrollStepFor(event, arrowsScrollFile(chain)) : null;
      if (step !== null) {
        event.preventDefault();
        document.getElementById("main")?.scrollBy({ top: step });
        return;
      }
      const action = shortcutFor(event, latest.current.props.singleKeys);
      if (action !== null && run(action)) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.active]);

  return null;
};
